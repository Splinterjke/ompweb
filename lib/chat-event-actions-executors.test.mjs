import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { createJiti } from "jiti";

// Isolate the store + scheduler files in a temp agent dir before any call
// resolves them.
const agentDir = mkdtempSync(join(tmpdir(), "omp-chat-actions-exec-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const scriptsDir = mkdtempSync(join(tmpdir(), "omp-chat-action-scripts-"));

const jiti = createJiti(import.meta.url);
const store = await jiti.import("./chat-event-action-store.ts");
const storeMod = store;
const executors = await jiti.import("./chat-event-actions-executors.ts");
const engine = await jiti.import("./scheduler-engine.ts");

before(async () => {
  // A manual scheduler backed by a slow script (to exercise the busy path)
  // and a fast one (to exercise the ok path).
  const slow = join(scriptsDir, "slow.sh");
  const fast = join(scriptsDir, "fast.sh");
  writeFileSync(slow, "#!/bin/sh\nsleep 3\n", "utf8");
  writeFileSync(fast, "#!/bin/sh\necho fast-ran\n", "utf8");
  const schedFileP = join(agentDir, "schedulers.json");
  writeFileSync(
    schedFileP,
    JSON.stringify({
      version: 1,
      schedulers: [
        { id: "sched-slow", name: "slow", script: slow, args: [], timeoutMs: 30000, schedule: { kind: "manual" }, enabled: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        { id: "sched-fast", name: "fast", script: fast, args: [], timeoutMs: 30000, schedule: { kind: "manual" }, enabled: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      ],
    }),
    "utf8",
  );
});

after(async () => {
  // Let any still-running slow scheduler child finish (it sleeps 3s).
  await new Promise((r) => setTimeout(r, 100));
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(scriptsDir, { recursive: true, force: true });
});

function save(file) {
  storeMod.saveChatEventActionFile(file);
}
function create(input) {
  const { file, action } = storeMod.createChatEventAction(input);
  save(file);
  return action;
}
function lastRun(id) {
  return storeMod.getChatEventAction(id)?.lastRun;
}
async function waitRun(id, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (lastRun(id)) return lastRun(id);
    await new Promise((r) => setTimeout(r, 50));
  }
  return lastRun(id);
}
const payload = { sessionId: "s1", sessionName: "Demo Session" };

test("parseHeaderLines: first wins on dup keys, skips blank/malformed", () => {
  const h = executors.parseHeaderLines("X-A: one\nx-a: two\n\n:::broken\nB: two words\n");
  // Keys are normalized to lowercase; first value wins on duplicates.
  assert.deepEqual(h, { "x-a": "one", b: "two words" });
});

/* ─────────────────────────── http ─────────────────────────── */

test("http executor records HTTP status and response tail", async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.headers["x-header"], "abc");
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("hello-body");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const action = create({
    name: "http-ok",
    events: ["conversation_completed"],
    action: { type: "http", method: "POST", url: `http://127.0.0.1:${port}/`, body: "{}", headers: "X-Header: abc" },
  });
  executors.executeChatAction(action, payload);
  const run = await waitRun(action.id);
  server.close();
  assert.equal(run.ok, true);
  assert.match(run.detail, /^HTTP 200/);
  assert.match(run.detail, /hello-body/);
});

test("http executor records failure status as not ok", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("boom");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const action = create({
    name: "http-500",
    events: ["conversation_completed"],
    action: { type: "http", method: "GET", url: `http://127.0.0.1:${port}/` },
  });
  executors.executeChatAction(action, payload);
  const run = await waitRun(action.id);
  server.close();
  assert.equal(run.ok, false);
  assert.match(run.detail, /^HTTP 500/);
});

test("http executor records timeout on a black-holed endpoint", async () => {
  // A listener that never answers: the executor must give up at 10s and
  // record a timeout (test waits up to 15s).
  const server = http.createServer(() => {
    /* never respond */
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const action = create({
    name: "http-timeout",
    events: ["conversation_completed"],
    action: { type: "http", method: "GET", url: `http://127.0.0.1:${port}/` },
  });
  const t0 = Date.now();
  executors.executeChatAction(action, payload);
  const run = await waitRun(action.id, 15000);
  server.close();
  assert.equal(run.ok, false);
  assert.match(run.detail, /timeout/);
  assert.ok(Date.now() - t0 < 14000, "timeout fires near 10s, not much later");
}, { timeout: 20000 });

/* ─────────────────────────── bash ─────────────────────────── */

test("bash executor runs inline scriptText via a temp file, cleans it up", async () => {
  const marker = join(scriptsDir, `marker-${Date.now()}.txt`);
  const action = create({
    name: "bash-text",
    events: ["conversation_completed"],
    action: { type: "bash", scriptText: `touch ${marker}` },
  });
  executors.executeChatAction(action, payload);
  const run = await waitRun(action.id);
  assert.equal(run.ok, true);
  assert.ok(existsSync(marker), "the script ran to completion");
  // The temp action.sh dir under the agent dir must be cleaned up.
  const leftovers = (await import("node:fs")).readdirSync(agentDir).filter((n) => n.startsWith("chat-action-"));
  assert.deepEqual(leftovers, []);
});

test("bash executor records non-zero exit", async () => {
  const action = create({
    name: "bash-fail",
    events: ["conversation_completed"],
    action: { type: "bash", scriptText: "exit 3" },
  });
  executors.executeChatAction(action, payload);
  const run = await waitRun(action.id);
  assert.equal(run.ok, false);
  assert.match(run.detail, /exit 3/);
});

test("bash executor runs a .sh scriptPath with bash", async () => {
  const marker = join(scriptsDir, `sh-marker-${Date.now()}.txt`);
  const script = join(scriptsDir, "scripted.sh");
  writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`, "utf8");
  const action = create({
    name: "bash-path",
    events: ["conversation_completed"],
    action: { type: "bash", scriptPath: script },
  });
  executors.executeChatAction(action, payload);
  const run = await waitRun(action.id);
  assert.equal(run.ok, true);
  assert.ok(existsSync(marker));
});

/* ─────────────────────────── scheduled ─────────────────────────── */

test("scheduled executor starts a manual scheduler and records ok", async () => {
  const action = create({
    name: "sched-fast",
    events: ["conversation_completed"],
    action: { type: "scheduled", schedulerId: "sched-fast" },
  });
  executors.executeChatAction(action, payload);
  const run = await waitRun(action.id);
  assert.equal(run.ok, true);
  assert.equal(run.detail, "started");
});

test("scheduled executor records 'scheduler busy' when one is already running", async () => {
  // Start the slow scheduler manually; it sleeps 3s so the action hit is
  // guaranteed to land while it's still active.
  const busy = engine.triggerManualRun("sched-slow");
  assert.equal(busy.ok, true);
  const action = create({
    name: "sched-busy",
    events: ["conversation_completed"],
    action: { type: "scheduled", schedulerId: "sched-slow" },
  });
  executors.executeChatAction(action, payload);
  const run = await waitRun(action.id);
  assert.equal(run.ok, false);
  assert.equal(run.detail, "scheduler busy");
});

/* ─────────────────────────── notification ─────────────────────────── */

test("notification executor delivers via emitToSession and records ok", async () => {
  const seen = [];
  const action = create({
    name: "notif",
    events: ["conversation_completed"],
    action: { type: "notification" },
  });
  const p = { ...payload, emitToSession: (frame) => { seen.push(frame); return 1; } };
  executors.executeChatAction(action, p);
  const run = await waitRun(action.id);
  assert.equal(run.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, "chat_event_action");
  assert.equal(seen[0].actionId, action.id);
  // Defaults: the session name as title, the generic body.
  assert.equal(seen[0].title, "Demo Session");
  assert.equal(seen[0].message, "Task finished.");
});

test("notification executor records failure when no listener is attached", async () => {
  const action = create({
    name: "notif-silent",
    events: ["conversation_completed"],
    action: { type: "notification", title: "T", message: "M" },
  });
  // No emitToSession and no running-stream listeners in this test process.
  executors.executeChatAction(action, { sessionId: "s2", sessionName: "N" });
  const run = await waitRun(action.id);
  assert.equal(run.ok, false);
  assert.equal(run.detail, "no browser attached");
});
