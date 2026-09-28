import assert from "node:assert/strict";
import { after, test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

// Isolate the session tree in a temp agent dir before any call resolves it.
const agentDir = mkdtempSync(join(tmpdir(), "omp-watcher-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url);
const watcher = await jiti.import("./session-watcher.ts");

const sessionsDir = join(agentDir, "sessions", "-project");
mkdirSync(sessionsDir, { recursive: true });

after(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

/** Write a session file with an omp-compliant name + header. */
function writeSession(id) {
  const name = `2026-01-01T00-00-00-000Z_${id}.jsonl`;
  const header = JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: join(tmpdir(), "omp-watcher-cwd"),
  });
  const entry = JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hello" } });
  const file = join(sessionsDir, name);
  writeFileSync(file, `${header}\n${entry}\n`);
  return file;
}

/** Rewrite the file in place with the same size — what a rename does to the
 * title slot (fixed 256-byte slot, mtime refresh, size unchanged). */
function sameSizeOverwrite(file) {
  const buf = Buffer.from(readFileSync(file));
  buf.write("X", 0);
  writeFileSync(file, buf);
}

function appendEntry(file, n) {
  appendFileSync(file, JSON.stringify({ type: "message", id: `e${n}`, parentId: null, message: { role: "user", content: `msg ${n}` } }) + "\n");
}

async function waitFor(fn, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`condition not met within ${timeoutMs}ms`);
}

test("same-size in-place rewrite (rename) is not external activity; growth is", async () => {
  const id = "aaaa1111-aaaa-4aaa-8aaa-aaaa11111111";
  const file = writeSession(id);
  const seen = [];
  const unsubscribe = watcher.subscribeSessionFileChanges((ids) => seen.push([...ids]));
  try {
    // First write: the watcher has no size baseline yet ("new") — it refreshes
    // the list but must not light the running badge.
    appendEntry(file, 2);
    await waitFor(() => seen.flat().includes(id));
    assert.equal(watcher.getExternallyActiveIds(5000).includes(id), false);

    // A rename: same-size in-place rewrite. The list must still refresh (the
    // new title has to show), but no activity may be recorded.
    sameSizeOverwrite(file);
    const flushesBefore = seen.length;
    await waitFor(() => seen.length > flushesBefore);
    assert.ok(seen[flushesBefore].includes(id), "rename must still trigger a list refresh");
    assert.equal(watcher.getExternallyActiveIds(5000).includes(id), false, "rename must not mark the session externally active");

    // A real append (file grew) after the baseline exists is external activity.
    appendEntry(file, 3);
    await waitFor(() => watcher.getExternallyActiveIds(5000).includes(id));
  } finally {
    unsubscribe();
  }
});

test("session in a project dir created after subscribing is still watched", async () => {
  // Regression: the watcher used to be a single recursive fs.watch, which on
  // Node >= 20 lstats entries internally and crashed (uncaught EIO) under
  // WSL2 dentry races. The per-directory design must pick up subdirectories
  // that appear only after the root watch is live.
  const id = "cccc3333-cccc-4ccc-8ccc-cccc33333333";
  const lateDir = join(agentDir, "sessions", "-late-project");
  const seen = [];
  const unsubscribe = watcher.subscribeSessionFileChanges((ids) => seen.push([...ids]));
  try {
    mkdirSync(lateDir, { recursive: true });
    const name = `2026-01-01T00-00-00-000Z_${id}.jsonl`;
    const file = join(lateDir, name);
    writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: join(tmpdir(), "omp-watcher-cwd") })}\n`);
    appendEntry(file, 2);
    await waitFor(() => seen.flat().includes(id));
  } finally {
    unsubscribe();
  }
});

test("isExternallyActive ignores a fresh mtime that a rename produced", async () => {
  const id = "bbbb2222-bbbb-4bbb-8bbb-bbbb22222222";
  const file = writeSession(id);
  const seen = [];
  const unsubscribe = watcher.subscribeSessionFileChanges((ids) => seen.push([...ids]));
  try {
    // The rename rewrite is observed by the watcher, which stores the
    // post-rename size as the baseline.
    sameSizeOverwrite(file);
    await waitFor(() => seen.flat().includes(id));

    // mtime is fresh, but the size did not change: not externally active.
    assert.equal(await watcher.isExternallyActive(id, 5000), false);

    // A real append is external activity.
    appendEntry(file, 2);
    await waitFor(() => watcher.getExternallyActiveIds(5000).includes(id));
    assert.equal(await watcher.isExternallyActive(id, 5000), true);
  } finally {
    unsubscribe();
  }
});

test("parseHeldSession resolves omp --resume command lines", () => {
  const id = "cccc3333-cccc-4ccc-8ccc-cccc33333333";
  const rel = join("-project", `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  const abs = join(agentDir, "sessions", rel);

  // Absolute --resume path (the form the web spawns its children with).
  assert.deepEqual(
    watcher.parseHeldSession(["/root/.local/bin/omp", "--mode", "rpc-ui", "--cwd", "/work/x", "--resume", abs], null),
    { id, file: abs },
  );
  // Relative --resume path resolved against the process cwd (the form a
  // terminal `omp --resume ./file.jsonl` uses).
  assert.deepEqual(
    watcher.parseHeldSession(["omp", "--resume", `./${rel}`], join(agentDir, "sessions")),
    { id, file: abs },
  );
  // Bare session id (the form a terminal user types): resolved through the
  // sessions tree. A fresh, unique id avoids ambiguity with the
  // -late-project file the earlier test wrote under the same id.
  const id2 = "eeee7777-eeee-4eee-8eee-eeee77777777";
  writeSession(id2);
  assert.deepEqual(
    watcher.parseHeldSession(["omp", "--resume", id2], null),
    { id: id2, file: join(agentDir, "sessions", "-project", `2026-01-01T00-00-00-000Z_${id2}.jsonl`) },
  );
  // Unknown id: not held.
  assert.equal(watcher.parseHeldSession(["omp", "--resume", "eeee5555-eeee-4eee-8eee-eeee55555555"], null), null);
  // Relative path with an unknown cwd is unresolvable, not a hit.
  assert.equal(watcher.parseHeldSession(["omp", "--resume", rel], null), null);
  // Not an omp process.
  assert.equal(watcher.parseHeldSession(["/bin/bash", "-c", "sleep 10"], null), null);
  // omp without --resume (a fresh session, or a utility process).
  assert.equal(watcher.parseHeldSession(["omp", "--mode", "rpc-ui", "--cwd", "/work/ompweb"], null), null);
  // --resume pointing outside the sessions tree.
  assert.equal(watcher.parseHeldSession(["omp", "--resume", "/tmp/foo.jsonl"], null), null);
  // A non-session file inside the tree (e.g. a subagent transcript).
  assert.equal(
    watcher.parseHeldSession(["omp", "--resume", join(agentDir, "sessions", "-project", "subagent-123.jsonl")], null),
    null,
  );
});

function finalAssistantEntry(n) {
  return JSON.stringify({ type: "message", id: `f${n}`, parentId: null, message: { role: "assistant", content: [{ type: "text", text: `done ${n}` }], stopReason: "stop" } });
}

function toolCallEntry(n) {
  return JSON.stringify({ type: "message", id: `t${n}`, parentId: null, message: { role: "assistant", content: [{ type: "text", text: `step ${n}` }, { type: "toolCall", id: `call${n}`, name: "bash", arguments: { command: "sleep 2" } }] } });
}

function toolResultEntry(n) {
  return JSON.stringify({ type: "message", id: `r${n}`, parentId: null, message: { role: "toolResult", toolCallId: `call${n}`, toolName: "bash", content: [{ type: "text", text: `step ${n} done` }] } });
}

test("heldTurnInFlight reads the committed tail state", () => {
  const id = "ffff6666-ffff-4fff-8fff-ffff66666666";
  const file = writeSession(id);
  // Tail is the user message the fixture writes: the turn just started.
  assert.equal(watcher.heldTurnInFlight(file), true);
  // A final assistant message (no tool call) closes the turn.
  appendFileSync(file, finalAssistantEntry(1) + "\n");
  assert.equal(watcher.heldTurnInFlight(file), false);
  // Non-message entries after the final (omp writes session_exit on exit)
  // do not reopen the turn.
  appendFileSync(file, JSON.stringify({ type: "session_exit", id: "x1", parentId: null }) + "\n");
  assert.equal(watcher.heldTurnInFlight(file), false);
  // A new turn: user message, then an assistant whose tool call is still
  // pending, then the tool result — each keeps the turn in flight.
  appendFileSync(file, JSON.stringify({ type: "message", id: "u2", parentId: null, message: { role: "user", content: "again" } }) + "\n");
  assert.equal(watcher.heldTurnInFlight(file), true);
  appendFileSync(file, toolCallEntry(2) + "\n");
  assert.equal(watcher.heldTurnInFlight(file), true);
  appendFileSync(file, toolResultEntry(2) + "\n");
  assert.equal(watcher.heldTurnInFlight(file), true);
  appendFileSync(file, finalAssistantEntry(2) + "\n");
  assert.equal(watcher.heldTurnInFlight(file), false);
  // Missing file: not in flight.
  assert.equal(watcher.heldTurnInFlight(join(sessionsDir, "nope.jsonl")), false);
});

test("heldTurnInFlight survives a 128KB chunk boundary", () => {
  const id = "aaaa7777-aaaa-4aaa-8aaa-aaaa77777777";
  const file = writeSession(id);
  // Pad past the 128KB tail window with a single long non-message line so
  // the read starts mid-line: the first line of the chunk is a truncated
  // fragment that must be skipped, not misread.
  appendFileSync(file, JSON.stringify({ type: "custom", id: "pad", parentId: null, pad: "x".repeat(130 * 1024) }) + "\n");
  appendFileSync(file, JSON.stringify({ type: "message", id: "u3", parentId: null, message: { role: "user", content: "boundary" } }) + "\n");
  assert.equal(watcher.heldTurnInFlight(file), true);
  appendFileSync(file, finalAssistantEntry(3) + "\n");
  assert.equal(watcher.heldTurnInFlight(file), false);
});

test("fresh external write committing a final assistant message is not externally active", async () => {
  const id = "bbbb8888-bbbb-4bbb-8bbb-bbbb88888888";
  const file = writeSession(id);
  const seen = [];
  const unsubscribe = watcher.subscribeSessionFileChanges((ids) => seen.push([...ids]));
  try {
    sameSizeOverwrite(file);
    await waitFor(() => seen.flat().includes(id));
    // The external run commits its final assistant message — the turn is
    // over, even though the write is fresh and the size changed.
    appendFileSync(file, finalAssistantEntry(4) + "\n");
    await waitFor(() => watcher.getExternallyActiveIds(5000).includes(id));
    assert.equal(await watcher.isExternallyActive(id, 5000), false);
  } finally {
    unsubscribe();
  }
});

const FAKE_HOLDER = `
import json, os, sys, time
F = sys.argv[sys.argv.index("--resume") + 1]
with open(os.environ["FAKE_PID_FILE"], "w") as f:
    f.write(str(os.getpid()))
with open(F, "a") as f:
    f.write(json.dumps({"type": "message", "id": "h1", "parentId": None, "message": {"role": "user", "content": "held"}}) + "\\n")
time.sleep(10)
`;

// The /proc scan pre-filter requires basename(argv[0]) === "omp" (a shebang
// script would leave argv[0] as the interpreter and be invisible), so the
// fake holder is a SYMLINK named "omp" pointing at the python3 binary.
function linkFakeOmp(holderBin) {
  if (existsSync(holderBin)) return; // shared fakebin/omp symlink (idempotent)
  const py = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
  const resolved = spawnSync("sh", ["-c", `readlink -f ${JSON.stringify(py)}`], { encoding: "utf8" }).stdout.trim();
  symlinkSync(resolved || py, holderBin);
}

test("idle holder after its final write does not keep the session running", async () => {
  const id = "cccc9999-cccc-4ccc-8ccc-cccc99999999";
  const file = writeSession(id);
  const holderDir = join(agentDir, "fakebin");
  const holderBin = join(holderDir, "omp");
  const pidFile = join(agentDir, "fake-holder.pid");
  mkdirSync(holderDir, { recursive: true });
  // fake holder: an executable symlink named "omp" -> python3 binary, running
  // a script that appends one user entry and then idles (a terminal-style
  // holder waiting for input).
  const holderScript = join(agentDir, "fake-holder.py");
  writeFileSync(holderScript, FAKE_HOLDER);
  linkFakeOmp(holderBin);
  // setsid + immediate sh exit reparents the holder to init so it is NOT
  // classified as web-owned (its parent must differ from this process).
  const sh = spawn("sh", ["-c", `setsid ${holderBin} ${holderScript} --mode rpc-ui --cwd ${sessionsDir} --resume ${file} >/dev/null 2>&1 &`], { stdio: "ignore", env: { ...process.env, FAKE_PID_FILE: pidFile } });
  sh.unref();
  let holderPid = 0;
  try {
    await waitFor(() => {
      try {
        const pid = readFileSync(pidFile, "utf8").trim();
        if (pid) holderPid = Number(pid);
      } catch {
        // not written yet
      }
      return holderPid > 0;
    }, 8000);
    // Live holder: the file tail is a user message (fixture "hello" or the
    // holder's "held"), so the session is in the pending-turn set.
    await waitFor(() => watcher.heldSessionsWithPendingTurn().includes(id), 8000);
    // The holder commits its final answer and goes idle (a terminal waiting
    // for input, or a leftover child after its turn finished): the tail
    // closes the turn, so the session must drop out of the pending-turn set.
    // Wait for the holder's own user entry (written just after the pidfile)
    // so it cannot land after our final append and flip the tail back to
    // in-flight.
    await waitFor(() => readFileSync(file, "utf8").includes('"content": "held"'), 8000);
    appendFileSync(file, finalAssistantEntry(5) + "\n");
    await waitFor(() => !watcher.heldSessionsWithPendingTurn().includes(id), 8000);
    // And the state route's check agrees: quiet file + idle holder = idle.
    assert.equal(await watcher.isExternallyActive(id, 1000), false);
  } finally {
    if (holderPid) {
      try {
        process.kill(holderPid, "SIGKILL");
      } catch {
        // already exited
      }
    }
  }
});

const FAKE_HOLDER_ID = `
import json, os, sys, time
F = os.environ["FAKE_FILE"]
with open(os.environ["FAKE_PID_FILE"], "w") as f:
    f.write(str(os.getpid()))
with open(F, "a") as f:
    f.write(json.dumps({"type": "message", "id": "h2", "parentId": None, "message": {"role": "user", "content": "held-id"}}) + "\\n")
time.sleep(10)
`;

test("holder resumed by bare session id (terminal form) is detected", async () => {
  const id = "dddd0000-dddd-4ddd-8ddd-dddd00000000";
  const file = writeSession(id);
  const holderDir = join(agentDir, "fakebin");
  const holderBin = join(holderDir, "omp");
  const pidFile = join(agentDir, "fake-holder-id.pid");
  mkdirSync(holderDir, { recursive: true });
  const holderScript = join(agentDir, "fake-holder-id.py");
  writeFileSync(holderScript, FAKE_HOLDER_ID);
  linkFakeOmp(holderBin);
  // The terminal user's form: `omp --resume <session-id>` — no file path on
  // the command line, and an unrelated cwd (resolution must not need it).
  const sh = spawn("sh", ["-c", `setsid ${holderBin} ${holderScript} --mode rpc-ui --cwd /work/nowhere --resume ${id} >/dev/null 2>&1 &`], { stdio: "ignore", env: { ...process.env, FAKE_PID_FILE: pidFile, FAKE_FILE: file } });
  sh.unref();
  let holderPid = 0;
  try {
    await waitFor(() => {
      try {
        const pid = readFileSync(pidFile, "utf8").trim();
        if (pid) holderPid = Number(pid);
      } catch {
        // not written yet
      }
      return holderPid > 0;
    }, 8000);
    // A terminal run resumed by bare id must be detected as the holder even
    // though no file path is on the command line.
    await waitFor(() => watcher.heldSessionsWithPendingTurn().includes(id), 8000);
  } finally {
    if (holderPid) {
      try {
        process.kill(holderPid, "SIGKILL");
      } catch {
        // already exited
      }
    }
  }
});

test("stale holder (file quiet past STALE_HOLDER_MS) drops out of the pending-turn set", async () => {
  const id = "eeee1111-eeee-4eee-8eee-eeee11111111";
  const file = writeSession(id);
  const holderDir = join(agentDir, "fakebin");
  const holderBin = join(holderDir, "omp");
  const pidFile = join(agentDir, "fake-holder-stale.pid");
  mkdirSync(holderDir, { recursive: true });
  const holderScript = join(agentDir, "fake-holder-stale.py");
  writeFileSync(holderScript, FAKE_HOLDER);
  linkFakeOmp(holderBin);
  const sh = spawn("sh", ["-c", `setsid ${holderBin} ${holderScript} --mode rpc-ui --cwd ${sessionsDir} --resume ${file} >/dev/null 2>&1 &`], { stdio: "ignore", env: { ...process.env, FAKE_PID_FILE: pidFile } });
  sh.unref();
  let holderPid = 0;
  try {
    await waitFor(() => {
      try {
        holderPid = Number(readFileSync(pidFile, "utf8").trim());
      } catch {
        // not written yet
      }
      return holderPid > 0;
    }, 8000);
    // Fresh mtime (the holder just wrote) -> the live holder is detected.
    await waitFor(() => watcher.heldSessionsWithPendingTurn().includes(id), 8000);
    // Simulate the holder going silent (crashed API call / hung tool): backdate
    // the file mtime well past STALE_HOLDER_MS. The scan cache expires every 5s,
    // so the next scan must drop the stale holder.
    const past = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(file, past, past);
    await waitFor(() => !watcher.heldSessionsWithPendingTurn().includes(id), 8000);
    // The state route's check agrees: quiet stale holder = not externally active.
    assert.equal(await watcher.isExternallyActive(id, 1000), false);
  } finally {
    if (holderPid) {
      try {
        process.kill(holderPid, "SIGKILL");
      } catch {
        // already exited
      }
    }
  }
});
