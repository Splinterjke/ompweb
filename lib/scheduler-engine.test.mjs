import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import { createJiti } from "jiti";

// Isolate the store in a temp agent dir before any store call resolves it.
const agentDir = mkdtempSync(join(tmpdir(), "omp-scheduler-test-"));
const scriptsDir = mkdtempSync(join(tmpdir(), "omp-scheduler-scripts-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

after(() => {
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(scriptsDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url);
const store = await jiti.import("./scheduler-store.ts");
const engine = await jiti.import("./scheduler-engine.ts");

const TIMEOUT = { timeout: 60_000 };

function writeScript(name, body, { executable = false } = {}) {
  const file = join(scriptsDir, name);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  if (executable) chmodSync(file, 0o755);
  return file;
}

async function waitForRun(id, expectCount = 1, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entry = store.loadSchedulerFile().schedulers.find((e) => e.id === id);
    if (entry && entry.runs.length >= expectCount) return entry;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no run for ${id} within ${timeoutMs}ms`);
}

function iso(msFromNow) {
  return new Date(Date.now() + msFromNow).toISOString();
}

function setupEntry(spec, { script, timeoutMs, nextRunAt, args = [] } = {}) {
  const { file, entry } = store.createSchedulerEntry({
    name: spec,
    script,
    args,
    schedule: { kind: "interval", every: 1, unit: "hours" },
    timeoutMs,
  });
  store.saveSchedulerFile(file);
  if (nextRunAt !== undefined) {
    store.saveSchedulerFile(store.setNextRunAt(entry.id, nextRunAt));
  }
  return entry.id;
}

test("fires a due slot and records an ok run with output", TIMEOUT, async () => {
  const ok = writeScript("ok.sh", "echo hello-scheduler");
  const id = setupEntry("ok", { script: ok, nextRunAt: iso(-10_000) });
  engine.tickSchedulers(new Date());
  const entry = await waitForRun(id);
  const run = entry.runs[0];
  assert.equal(run.status, "ok");
  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /hello-scheduler/);
  // Slot advanced to the future (next hour), not left stale.
  assert.ok(new Date(entry.nextRunAt).getTime() > Date.now());
});

test("records an error run with exit code and stderr tail", TIMEOUT, async () => {
  const fail = writeScript("fail.sh", "echo boom >&2\nexit 3");
  const id = setupEntry("fail", { script: fail, nextRunAt: iso(-10_000) });
  engine.tickSchedulers(new Date());
  const entry = await waitForRun(id);
  const run = entry.runs[0];
  assert.equal(run.status, "error");
  assert.equal(run.exitCode, 3);
  assert.match(run.stderr, /boom/);
});

test("flags a run as late when it starts well after its slot", TIMEOUT, async () => {
  const ok = writeScript("ok2.sh", "echo fine");
  // 100s late: past LATE_MS (90s), within MAX_CATCHUP_MS (2m) → fires, flagged.
  const id = setupEntry("late", { script: ok, nextRunAt: iso(-100_000) });
  engine.tickSchedulers(new Date());
  const entry = await waitForRun(id);
  assert.equal(entry.runs[0].status, "ok");
  assert.equal(entry.runs[0].late, true);
});

test("records missed when the slot is older than the catch-up window", TIMEOUT, async () => {
  const ok = writeScript("ok3.sh", "echo fine");
  const id = setupEntry("missed", { script: ok, nextRunAt: iso(-60 * 60_000) });
  engine.tickSchedulers(new Date());
  const file = store.loadSchedulerFile();
  const entry = file.schedulers.find((e) => e.id === id);
  assert.equal(entry.runs.length, 1);
  assert.equal(entry.runs[0].status, "missed");
  // Nothing spawned: nextRunAt advanced past the stale slot.
  assert.ok(new Date(entry.nextRunAt).getTime() > Date.now());
});

test("skips a slot when the previous run is still active", TIMEOUT, async () => {
  const slow = writeScript("slow.sh", "sleep 3");
  const id = setupEntry("slow", { script: slow, nextRunAt: iso(-10_000) });
  engine.tickSchedulers(new Date()); // starts the run
  // Second due slot while the first run is still sleeping.
  store.saveSchedulerFile(store.setNextRunAt(id, iso(-5_000)));
  engine.tickSchedulers(new Date());
  const entry = await waitForRun(id, 2);
  const statuses = entry.runs.map((r) => r.status).sort();
  assert.ok(statuses.includes("skipped"), `expected a skipped run, got ${statuses}`);
});

test("manual run executes on demand and does not move nextRunAt", TIMEOUT, async () => {
  const ok = writeScript("ok4.sh", "echo manual");
  const id = setupEntry("manual", { script: ok, nextRunAt: iso(3_600_000) });
  const result = engine.triggerManualRun(id);
  assert.deepEqual(result, { ok: true });
  assert.equal(engine.isSchedulerRunning(id), true);
  // A manual trigger while running is refused (serial per scheduler).
  assert.deepEqual(engine.triggerManualRun(id), { ok: false, error: "already_running" });
  const entry = await waitForRun(id);
  assert.equal(entry.runs[0].status, "ok");
  assert.equal(entry.runs[0].manual, true);
  assert.match(entry.runs[0].stdout, /manual/);
  // Schedule slot untouched.
  assert.ok(new Date(entry.nextRunAt).getTime() > Date.now() + 3_000_000 - 10_000);
  engine.__resetSchedulerEngineForTests();
});

test("child PATH is repaired: parent dirs first, tool dirs appended, no duplicates", TIMEOUT, async () => {
  const script = writeScript("pathdump.sh", 'echo "$PATH"');
  const id = setupEntry("path", { script, nextRunAt: iso(3_600_000) });
  engine.triggerManualRun(id);
  const entry = await waitForRun(id);
  assert.equal(entry.runs[0].status, "ok");
  const childDirs = entry.runs[0].stdout.trim().split(delimiter);
  const parentDirs = [...new Set((process.env.PATH ?? "").split(delimiter).filter(Boolean))];
  // The parent's PATH stays at the front, in its original order.
  assert.deepEqual(childDirs.slice(0, parentDirs.length), parentDirs);
  // npm's install dir is repaired into the child's PATH (absent from the
  // server's minimal PATH — the regression that broke `npm` in scripts).
  assert.ok(childDirs.includes("/opt/node24/bin"), `child PATH: ${entry.runs[0].stdout}`);
  // No directory is duplicated.
  assert.equal(new Set(childDirs).size, childDirs.length);
  engine.__resetSchedulerEngineForTests();
});

test("timeout kills the child and records status=timeout", { timeout: 90_000 }, async () => {
  const slow = writeScript("slow2.sh", "sleep 8");
  const id = setupEntry("timeout", { script: slow, nextRunAt: iso(-10_000), timeoutMs: store.MIN_TIMEOUT_MS });
  engine.tickSchedulers(new Date());
  const entry = await waitForRun(id);
  const run = entry.runs[0];
  assert.equal(run.status, "timeout");
  assert.ok(run.finishedAt, "run must be closed out");
  // No child left behind.
  assert.equal(engine.isSchedulerRunning(id), false);
  engine.__resetSchedulerEngineForTests();
});

test("spawn failure (missing script) records an error run", TIMEOUT, async () => {
  const id = setupEntry("gone", { script: join(scriptsDir, "does-not-exist.sh"), nextRunAt: iso(-10_000) });
  engine.tickSchedulers(new Date());
  const entry = await waitForRun(id);
  assert.equal(entry.runs[0].status, "error");
  assert.ok(entry.runs[0].stderr, "spawn error should surface in stderr");
});

test("listSchedulersWithState reflects live running flags", TIMEOUT, async () => {
  const slow = writeScript("slow3.sh", "sleep 2");
  const id = setupEntry("state", { script: slow, nextRunAt: iso(-10_000) });
  engine.tickSchedulers(new Date());
  const listed = engine.listSchedulersWithState().find((e) => e.id === id);
  assert.equal(listed.running, true);
  await waitForRun(id);
  const after = engine.listSchedulersWithState().find((e) => e.id === id);
  assert.equal(after.running, false);
  engine.__resetSchedulerEngineForTests();
});

test("getEngineStartedAt returns the process start timestamp and updates after reset", TIMEOUT, async () => {
  const before = Date.now();
  engine.ensureSchedulerEngine();
  const startedAt = engine.getEngineStartedAt();
  const ts = new Date(startedAt).getTime();
  assert.ok(Number.isFinite(ts), "engineStartedAt is a finite timestamp");
  assert.ok(ts >= before - 5_000, "engineStartedAt is not in the past");
  assert.ok(ts <= Date.now() + 5_000, "engineStartedAt is not in the future");
  // A fresh engine (post-reset) reports a new, later start time.
  engine.__resetSchedulerEngineForTests();
  const restartedAt = new Date(engine.getEngineStartedAt()).getTime();
  assert.ok(restartedAt >= ts, "restart advances engineStartedAt");
});
