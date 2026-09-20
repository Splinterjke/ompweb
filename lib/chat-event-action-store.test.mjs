import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";

// Isolate the store in a temp agent dir before any store call resolves it.
const agentDir = mkdtempSync(join(tmpdir(), "omp-chat-actions-store-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url);
const store = await jiti.import("./chat-event-action-store.ts");
const fileP = store.getChatEventActionsPath();

after(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

// The API routes persist via saveChatEventActionFile — the tests do the same.
function save(file) {
  store.saveChatEventActionFile(file);
}
function reset() {
  // Tests run against the same agent dir; start each on an empty file.
  save({ version: 1, actions: [] });
}
function create(input) {
  const { file, action } = store.createChatEventAction(input);
  save(file);
  return action;
}
function patch(id, p) {
  const { file, action } = store.patchChatEventAction(id, p);
  save(file);
  return action;
}
function remove(id) {
  save(store.removeChatEventAction(id));
}
function notificationInput(name = "notify") {
  return { name, events: ["conversation_completed"], action: { type: "notification" } };
}

test("create -> list -> get round-trip persists the action", () => {
  reset();
  const action = create(notificationInput("alpha"));
  assert.ok(action.id);
  const listed = store.listChatEventActions();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, action.id);
  assert.equal(listed[0].name, "alpha");
  assert.deepEqual(listed[0].events, ["conversation_completed"]);
  assert.equal(listed[0].enabled, true);
  assert.equal(listed[0].action.type, "notification");
  assert.ok(action.createdAt);
  assert.ok(action.updatedAt);

  assert.deepEqual(store.getChatEventAction(action.id), listed[0]);
  assert.equal(store.getChatEventAction("nope"), null);
  assert.equal(store.getChatEventAction("bad id!"), null);
});

test("patch updates fields and leaves absent ones intact", () => {
  reset();
  const action = create(notificationInput("beta"));
  const patched = patch(action.id, {
    enabled: false,
    events: ["assistant_text", "conversation_interrupted"],
  });
  assert.equal(patched.enabled, false);
  assert.deepEqual(patched.events, ["assistant_text", "conversation_interrupted"]);
  assert.equal(patched.name, "beta"); // untouched
  assert.equal(store.getChatEventAction(action.id).enabled, false);

  remove(action.id);
  assert.equal(store.listChatEventActions().length, 0);
});

test("remove deletes only the targeted action", () => {
  reset();
  const a = create(notificationInput("a"));
  const b = create(notificationInput("b"));
  remove(a.id);
  const remaining = store.listChatEventActions();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, b.id);
});

test("corrupt file yields an empty list; malformed entries are dropped", () => {
  reset();
  writeFileSync(fileP, "{ not json at all", "utf8");
  assert.deepEqual(store.loadChatEventActionFile(), { version: 1, actions: [] });

  // One good entry + an entry missing events + an entry with a bad action type.
  const good = create(notificationInput("good"));
  writeFileSync(
    fileP,
    JSON.stringify({
      version: 1,
      actions: [
        good,
        { id: "bad1", name: "no events", events: [], action: { type: "notification" } },
        { id: "bad2", name: "x", events: ["conversation_completed"], action: { type: "unknown" } },
      ],
    }),
    "utf8",
  );
  const loaded = store.loadChatEventActionFile();
  assert.equal(loaded.actions.length, 1);
  assert.equal(loaded.actions[0].id, good.id);
});

test("validateActionSpec rejects bad specs with stable codes", () => {
  const cases = [
    [{ type: "http", method: "BOGUS", url: "https://x.test" }, "method_invalid"],
    [{ type: "http", method: "GET" }, "url_required"],
    [{ type: "http", method: "GET", url: "not a url" }, "url_invalid"],
    [{ type: "http", method: "GET", url: "ftp://x.test" }, "url_invalid"],
    [{ type: "http", method: "POST", url: "https://x.test", body: "b", bodyContentType: "octet" }, "body_content_type_invalid"],
    [{ type: "bash" }, "script_required"],
    [{ type: "scheduled" }, "scheduler_required"],
    [{ type: "nope" }, "action_type_invalid"],
    [null, "action_required"],
  ];
  for (const [spec, code] of cases) {
    assert.throws(() => store.validateActionSpec(spec), (err) => err.code === code, `expected ${code} for ${JSON.stringify(spec)}`);
  }
  // Valid specs normalize (method upper-cased, trimmed title).
  assert.deepEqual(store.validateActionSpec({ type: "notification", title: "  T  " }), { type: "notification", title: "T" });
  const getSpec = store.validateActionSpec({ type: "http", method: "get", url: " https://x.test/a " });
  assert.deepEqual(getSpec, { type: "http", method: "GET", url: "https://x.test/a" });
  // POST/PUT body gets a default content type.
  assert.equal(store.validateActionSpec({ type: "http", method: "POST", url: "https://x.test", body: "{}" }).bodyContentType, "json");
});

test("create rejects missing name, empty events, unknown event types", () => {
  assert.throws(() => create({ name: "  ", events: ["conversation_completed"], action: { type: "notification" } }), (e) => e.code === "name_required");
  assert.throws(() => create({ name: "x", events: [], action: { type: "notification" } }), (e) => e.code === "events_required");
  assert.throws(() => create({ name: "x", events: ["bogus_event"], action: { type: "notification" } }), (e) => e.code === "event_invalid");
});

test("recordActionRun sets lastRun and is a no-op for unknown ids", () => {
  reset();
  const action = create(notificationInput("run"));
  store.recordActionRun(action.id, { at: new Date().toISOString(), ok: true, detail: "HTTP 200" });
  assert.equal(store.getChatEventAction(action.id).lastRun.ok, true);
  assert.equal(store.getChatEventAction(action.id).lastRun.detail, "HTTP 200");
  // Unknown id: must not throw.
  store.recordActionRun("does-not-exist", { at: new Date().toISOString(), ok: false });
});

test("loadActionsForEvent returns only enabled bound actions; save invalidates the cache", () => {
  reset();
  const on = create({
    name: "on",
    events: ["assistant_text", "conversation_completed"],
    action: { type: "notification" },
  });
  create({
    name: "off",
    events: ["assistant_text"],
    action: { type: "notification" },
    enabled: false,
  });
  const other = create({
    name: "other",
    events: ["subagent_completed"],
    action: { type: "notification" },
  });

  assert.deepEqual(store.loadActionsForEvent("assistant_text").map((a) => a.id), [on.id]);
  assert.equal(store.loadActionsForEvent("conversation_completed").map((a) => a.id).length, 1);
  assert.deepEqual(store.loadActionsForEvent("subagent_completed").map((a) => a.id), [other.id]);
  assert.deepEqual(store.loadActionsForEvent("user_prompt_sent"), []);

  // Disabling via the save path invalidates the cached view.
  patch(on.id, { enabled: false });
  assert.deepEqual(store.loadActionsForEvent("assistant_text"), []);
});
