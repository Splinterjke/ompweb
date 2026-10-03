import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  clearLastOpenSession,
  clearLastOpenSessionGlobal,
  getLastOpenSession,
  getLastOpenSessionGlobal,
  setLastOpenSession,
  setLastOpenSessionGlobal,
  workspaceKeyOf,
} = await jiti.import("./workspace-memory.ts");

function createStorage(values = {}) {
  const entries = new Map(Object.entries(values));
  return {
    getItem(key) { return entries.get(key) ?? null; },
    setItem(key, value) { entries.set(key, value); },
    removeItem(key) { entries.delete(key); },
    entries,
  };
}

test("remembers the last session for each project independently", () => {
  const storage = createStorage();
  setLastOpenSession("project-a", "session-a", storage);
  setLastOpenSession("project-b", "session-b", storage);

  assert.equal(getLastOpenSession("project-a", storage), "session-a");
  assert.equal(getLastOpenSession("project-b", storage), "session-b");
  clearLastOpenSession("project-a", storage);
  assert.equal(getLastOpenSession("project-a", storage), null);
  assert.equal(getLastOpenSession("project-b", storage), "session-b");
});

test("uses the shared project root so worktrees restore the same workspace", () => {
  assert.equal(workspaceKeyOf({ cwd: "D:/repo-worktrees/feature", projectRoot: "D:/repo" }), "D:/repo");
  assert.equal(workspaceKeyOf({ cwd: "D:/scratch" }), "D:/scratch");
});

test("restores and clears path aliases left by older desktop builds", () => {
  const storage = createStorage();
  storage.setItem("omp-web:last-open-by-project", JSON.stringify({
    ["D:/Repo/"]: "session-a",
  }));
  assert.equal(getLastOpenSession("d:/repo", storage), "session-a");
  clearLastOpenSession("d:/repo", storage);
  assert.equal(getLastOpenSession("D:/Repo", storage), null);
});

test("tracks the globally last-opened session across workspaces", () => {
  const storage = createStorage();
  setLastOpenSessionGlobal("session-a", storage);
  setLastOpenSessionGlobal("session-b", storage);
  assert.equal(getLastOpenSessionGlobal(storage), "session-b");
});

test("clears the global last-open only when it still holds the stale id", () => {
  const storage = createStorage();
  setLastOpenSessionGlobal("session-a", storage);
  clearLastOpenSessionGlobal("session-b", storage);
  assert.equal(getLastOpenSessionGlobal(storage), "session-a");
  clearLastOpenSessionGlobal("session-a", storage);
  assert.equal(getLastOpenSessionGlobal(storage), null);
});
