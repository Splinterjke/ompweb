import assert from "node:assert/strict";
import { after, test } from "node:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
