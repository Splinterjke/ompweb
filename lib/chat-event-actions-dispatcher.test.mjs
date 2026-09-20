import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";

// Isolate the store in a temp agent dir before any store call resolves it.
const agentDir = mkdtempSync(join(tmpdir(), "omp-chat-actions-dispatch-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url);
const store = await jiti.import("./chat-event-action-store.ts");
const executors = await jiti.import("./chat-event-actions-executors.ts");
const dispatcher = await jiti.import("./chat-event-actions-dispatcher.ts");

// Replace the real executors with a recording table so no process is
// spawned, no HTTP request made, and no browser frame broadcast.
const calls = [];
const types = ["notification", "http", "bash", "scheduled"];
const fake = {};
for (const t of types) fake[t] = (action, payload) => {
  calls.push({ type: t, actionId: action.id, payload });
};
before(() => executors.__setActionExecutorsForTests(fake));
after(() => {
  executors.__setActionExecutorsForTests(null);
  rmSync(agentDir, { recursive: true, force: true });
});

function save(file) {
  store.saveChatEventActionFile(file);
}
// Fresh store for a test (other tests' actions must not leak in).
function resetStore() {
  save({ version: 1, actions: [] });
}
// Clear the recorded executor calls without touching the store.
function resetCalls() {
  calls.length = 0;
}
function create(input) {
  const { file, action } = store.createChatEventAction(input);
  save(file);
  return action;
}
function payload(sessionId = "sess-1") {
  return { sessionId, sessionName: "Test Session" };
}

test("fires the enabled actions bound to the event type only", () => {
  resetStore();
  create({ name: "a", events: ["assistant_text"], action: { type: "notification" } });
  create({ name: "b", events: ["assistant_text", "conversation_completed"], action: { type: "http", method: "GET", url: "https://x.test" } });
  create({ name: "c", events: ["conversation_completed"], action: { type: "bash", scriptText: "true" } });
  create({ name: "off", events: ["assistant_text"], action: { type: "notification" }, enabled: false });

  resetCalls();
  dispatcher.dispatchChatEvent("assistant_text", payload());
  assert.deepEqual(calls.map((c) => c.type), ["notification", "http"]);
  // The payload is passed through to the executor.
  assert.equal(calls[0].payload.sessionId, "sess-1");
  assert.equal(calls[0].payload.sessionName, "Test Session");

  resetCalls();
  dispatcher.dispatchChatEvent("conversation_completed", payload());
  assert.deepEqual(calls.map((c) => c.type), ["http", "bash"]);
});

test("does nothing when no action is bound to the event", () => {
  resetStore();
  resetCalls();
  dispatcher.dispatchChatEvent("user_prompt_sent", payload());
  assert.deepEqual(calls, []);
});

test("an action bound to several events fires once per event", () => {
  resetStore();
  const a = create({ name: "multi", events: ["thinking_completed", "assistant_text", "subagent_completed"], action: { type: "notification" } });
  resetCalls();
  dispatcher.dispatchChatEvent("thinking_completed", payload());
  dispatcher.dispatchChatEvent("assistant_text", payload());
  dispatcher.dispatchChatEvent("subagent_completed", payload());
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.actionId === a.id));
});

test("provider_api_error is deduped within one run", () => {
  resetStore();
  create({ name: "err", events: ["provider_api_error"], action: { type: "notification" } });
  resetCalls();
  const p = payload("sess-dedupe");
  dispatcher.dispatchChatEvent("provider_api_error", p);
  dispatcher.dispatchChatEvent("provider_api_error", p);
  dispatcher.dispatchChatEvent("provider_api_error", p);
  assert.equal(calls.length, 1);
});

test("a new run (user_prompt_sent) resets the provider_api_error dedupe", () => {
  resetStore();
  create({ name: "err", events: ["provider_api_error"], action: { type: "notification" } });
  resetCalls();
  const p = payload("sess-reset");
  // First run: error fires once, second error suppressed.
  dispatcher.dispatchChatEvent("provider_api_error", p);
  dispatcher.dispatchChatEvent("provider_api_error", p);
  // Second run: the user_prompt_sent dispatch clears the per-run flag even
  // though no action is bound to it, so a new error fires again.
  dispatcher.dispatchChatEvent("user_prompt_sent", p);
  dispatcher.dispatchChatEvent("provider_api_error", p);
  assert.equal(calls.length, 2);
});

test("clearChatActionRunState drops the per-run dedupe", () => {
  resetStore();
  create({ name: "err", events: ["provider_api_error"], action: { type: "notification" } });
  resetCalls();
  const p = payload("sess-clear");
  dispatcher.dispatchChatEvent("provider_api_error", p);
  dispatcher.dispatchChatEvent("provider_api_error", p);
  assert.equal(calls.length, 1);
  dispatcher.clearChatActionRunState(p.sessionId);
  dispatcher.dispatchChatEvent("provider_api_error", p);
  assert.equal(calls.length, 2);
});

test("one action's executor failure does not skip the others", () => {
  resetStore();
  create({ name: "bad", events: ["assistant_text"], action: { type: "notification" } });
  create({ name: "good", events: ["assistant_text"], action: { type: "http", method: "GET", url: "https://x.test" } });
  resetCalls();
  // Swap the notification executor for one that throws; the dispatcher must
  // isolate it and still run the http action.
  const real = { ...fake };
  executors.__setActionExecutorsForTests({
    ...real,
    notification: () => {
      throw new Error("boom");
    },
  });
  try {
    dispatcher.dispatchChatEvent("assistant_text", payload("sess-failure"));
    // executors are fire-and-forget but the record is synchronous here, so
    // the calls are visible immediately.
    assert.equal(calls.filter((c) => c.type === "http").length, 1);
  } finally {
    executors.__setActionExecutorsForTests(real);
  }
});
