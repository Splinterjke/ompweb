import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  ARCHIVE_OLDER_THAN_BUCKET_MS,
  isArchiveOlderThanBucket,
  selectSessionsForBulkArchive,
} = await jiti.import("./archive-older-than.ts");
const { comparableProjectPath } = await jiti.import("./comparable-path.ts");

const PROJECT = "/work/repo";
const KEY = comparableProjectPath(PROJECT);
const CUTOFF = Date.parse("2026-09-01T00:00:00.000Z");

function session(id, overrides = {}) {
  return {
    id,
    cwd: PROJECT,
    projectRoot: PROJECT,
    modified: "2026-08-01T00:00:00.000Z", // old by default
    ...overrides,
  };
}

function select(sessions, opts = {}) {
  return selectSessionsForBulkArchive(sessions, {
    projectKey: KEY,
    cutoffMs: CUTOFF,
    externallyHeld: new Set(),
    ...opts,
  });
}

test("buckets are fixed-length week/month durations", () => {
  const DAY = 24 * 60 * 60 * 1000;
  assert.deepEqual(ARCHIVE_OLDER_THAN_BUCKET_MS, {
    "1w": 7 * DAY,
    "2w": 14 * DAY,
    "1m": 30 * DAY,
    "3m": 90 * DAY,
  });
  assert.equal(isArchiveOlderThanBucket("2w"), true);
  assert.equal(isArchiveOlderThanBucket("5w"), false);
  assert.equal(isArchiveOlderThanBucket("toString"), false);
  assert.equal(isArchiveOlderThanBucket(7), false);
});

test("selects only aged sessions of the matching project", () => {
  const result = select([
    session("old"),
    session("fresh", { modified: "2026-09-20T00:00:00.000Z" }),
    session("other", { cwd: "/work/other", projectRoot: "/work/other" }),
    session("broken", { modified: "not-a-date" }),
  ]);
  assert.deepEqual(result.targets.map((s) => s.id), ["old"]);
  assert.deepEqual(result.skipped, []);
});

test("matching is project-root aware (worktree sessions group with the main repo)", () => {
  const result = select([
    session("wt", { cwd: "/work/repo-wt/feature", projectRoot: PROJECT }),
  ]);
  assert.deepEqual(result.targets.map((s) => s.id), ["wt"]);
});

test("sessions exactly at the cutoff are not archived", () => {
  const result = select([session("edge", { modified: new Date(CUTOFF).toISOString() })]);
  assert.deepEqual(result.targets, []);
});

test("externally held sessions are skipped, not archived", () => {
  const result = select([session("a"), session("b")], {
    externallyHeld: new Set(["a"]),
  });
  assert.deepEqual(result.targets.map((s) => s.id), ["b"]);
  assert.deepEqual(result.skipped, [{ id: "a", reason: "external" }]);
});

test("a parent with a surviving newer child is skipped", () => {
  const result = select([
    session("parent"),
    session("child", { parentSessionId: "parent", modified: "2026-09-20T00:00:00.000Z" }),
  ]);
  assert.deepEqual(result.targets, []);
  assert.deepEqual(result.skipped, [{ id: "parent", reason: "children" }]);
});

test("a parent with a surviving externally-held child is skipped", () => {
  const result = select(
    [session("parent"), session("child", { parentSessionId: "parent" })],
    { externallyHeld: new Set(["child"]) },
  );
  assert.deepEqual(result.targets, []);
  assert.deepEqual(
    result.skipped.sort((x, y) => x.id.localeCompare(y.id)),
    [
      { id: "child", reason: "external" },
      { id: "parent", reason: "children" },
    ],
  );
});

test("skip propagates transitively up the ancestor chain", () => {
  // grandparent -> parent -> child, child survives (newer): both ancestors skip.
  const result = select([
    session("grandparent"),
    session("parent", { parentSessionId: "grandparent" }),
    session("child", { parentSessionId: "parent", modified: "2026-09-20T00:00:00.000Z" }),
  ]);
  assert.deepEqual(result.targets, []);
  assert.deepEqual(
    result.skipped.map((s) => s.id).sort(),
    ["grandparent", "parent"],
  );
});

test("archived child chains do not block their parents", () => {
  const result = select([
    session("grandparent"),
    session("parent", { parentSessionId: "grandparent" }),
    session("child", { parentSessionId: "parent" }),
  ]);
  assert.deepEqual(result.skipped, []);
  // Children first so a parent file never moves before its child's pointer.
  assert.deepEqual(result.targets.map((s) => s.id), ["child", "parent", "grandparent"]);
});

test("siblings ordered stably and unrelated trees are untouched", () => {
  const result = select([
    session("root-old"),
    session("keep", { cwd: "/work/other", projectRoot: "/work/other", modified: "2026-08-01T00:00:00.000Z" }),
    session("sib-a", { parentSessionId: "root-old" }),
    session("sib-b", { parentSessionId: "root-old" }),
  ]);
  assert.deepEqual(result.targets.map((s) => s.id), ["sib-a", "sib-b", "root-old"]);
  assert.deepEqual(result.skipped, []);
});
