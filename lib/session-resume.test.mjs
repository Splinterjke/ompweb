import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
/** A new omp-web process: fresh tracker, same agent dir. */
function restart() {
  globalThis.__ompResumeTracker = undefined;
}

const { EXIT_GRACE_MS, markShuttingDown, recordRunningSessions, takeInterruptedSessions } = await jiti.import("./session-resume.ts");
const { saveWebServerSettings } = await jiti.import("./web-settings.ts");

/** Fresh agent dir and tracker per test; the resume setting starts as given. */
function setup(t, { enabled }) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-resume-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  globalThis.__ompResumeTracker = undefined;
  t.after(() => {
    for (const timer of globalThis.__ompResumeTracker?.drops.values() ?? []) clearTimeout(timer);
    globalThis.__ompResumeTracker = undefined;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  });
  saveWebServerSettings({ autoResumeSessions: enabled });
  const listPath = join(agentDir, "omp-web-interrupted-sessions.json");
  const recorded = () => (existsSync(listPath) ? JSON.parse(readFileSync(listPath, "utf8")).sessions.map((s) => s.id) : []);
  return { listPath, recorded };
}

const A = { id: "01a0e6b0-d916-7610-8343-f4a766ba005a", advisor: false };
const B = { id: "01a0e6b0-d916-7610-8343-f4a766ba005b", advisor: true };

test("with the setting off nothing is recorded and a leftover list is discarded", (t) => {
  const { listPath, recorded } = setup(t, { enabled: false });
  writeFileSync(listPath, JSON.stringify({ sessions: [A] }));
  recordRunningSessions([B], () => true);
  assert.deepEqual(recorded(), []);
  assert.deepEqual(takeInterruptedSessions(), []);
});

test("a run that ends normally leaves the list; one still running stays", (t) => {
  const { recorded } = setup(t, { enabled: true });
  recordRunningSessions([A, B], () => true);
  assert.deepEqual(recorded(), [A.id, B.id]);
  recordRunningSessions([B], () => true);
  assert.deepEqual(recorded(), [B.id]);
  recordRunningSessions([], () => true);
  assert.deepEqual(recorded(), []);
});

test("a crashed child is dropped after the grace window while omp-web keeps running", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { recorded } = setup(t, { enabled: true });
  recordRunningSessions([A], () => true);
  recordRunningSessions([], () => false);
  assert.deepEqual(recorded(), [A.id], "kept until the grace window passes");
  t.mock.timers.tick(EXIT_GRACE_MS);
  assert.deepEqual(recorded(), []);
});

test("children dying just before the shutdown handler are still resumed", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { listPath } = setup(t, { enabled: true });
  recordRunningSessions([A, B], () => true);
  recordRunningSessions([], () => false);
  markShuttingDown();
  recordRunningSessions([], () => false);
  t.mock.timers.tick(EXIT_GRACE_MS);
  restart();
  assert.deepEqual(takeInterruptedSessions(), [A, B]);
  assert.equal(existsSync(listPath), false, "the list is consumed");
  assert.deepEqual(takeInterruptedSessions(), [], "handed out once");
});

test("a session started before resume runs does not overwrite the previous run's list", (t) => {
  const { listPath, recorded } = setup(t, { enabled: true });
  writeFileSync(listPath, JSON.stringify({ sessions: [A] }));
  recordRunningSessions([B], () => true);
  assert.deepEqual(recorded(), [B.id]);
  assert.deepEqual(takeInterruptedSessions(), [A]);
});

test("entries with an invalid session id are ignored", (t) => {
  const { listPath } = setup(t, { enabled: true });
  writeFileSync(listPath, JSON.stringify({ sessions: [{ id: "../../etc/passwd" }, { id: 7 }, A] }));
  restart();
  assert.deepEqual(takeInterruptedSessions(), [A]);
});
