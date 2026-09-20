import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { test } from "node:test";

const jiti = createJiti(import.meta.url);
const { taskCompletedDiff } = await jiti.import("./todo-completion.ts");

// Builds a single-phase TODO list (an array of one phase) whose tasks are
// keyed by `${prefix}-${i}` so that prev and next built with the SAME prefix
// describe the same tasks (matching is by content). Status is the
// transition under test.
const phase = (statuses, prefix, name = "P") => [
  { name, tasks: statuses.map((status, i) => ({ content: `${prefix}-${i}`, status })) },
];

test("null baseline (first observation / init) never fires", () => {
  assert.equal(taskCompletedDiff(null, phase(["completed", "completed"], "t")), false);
});

test("empty next snapshot never fires", () => {
  assert.equal(taskCompletedDiff(phase(["completed"], "t"), []), false);
  assert.equal(taskCompletedDiff(null, []), false);
});

test("pending -> completed fires", () => {
  assert.equal(taskCompletedDiff(phase(["pending", "in_progress"], "t"), phase(["completed", "completed"], "t")), true);
});

test("in_progress -> completed fires", () => {
  assert.equal(taskCompletedDiff(phase(["in_progress"], "t"), phase(["completed"], "t")), true);
});

test("blocked -> completed fires", () => {
  assert.equal(taskCompletedDiff(phase(["blocked"], "t"), phase(["completed"], "t")), true);
});

test("completed -> completed does not fire", () => {
  assert.equal(taskCompletedDiff(phase(["completed"], "t"), phase(["completed"], "t")), false);
});

test("completed -> pending (re-open) then back to completed fires", () => {
  // completed -> pending is not a completion
  assert.equal(taskCompletedDiff(phase(["completed"], "t"), phase(["pending"], "t")), false);
  // but the subsequent pending -> completed is
  assert.equal(taskCompletedDiff(phase(["pending"], "t"), phase(["completed"], "t")), true);
});

test("unrelated task completion fires even when others are untouched", () => {
  assert.equal(taskCompletedDiff(phase(["completed", "pending"], "t"), phase(["completed", "completed"], "t")), true);
});

test("no task reached completed (all still pending) does not fire", () => {
  assert.equal(taskCompletedDiff(phase(["pending", "in_progress"], "t"), phase(["pending", "in_progress"], "t")), false);
});

test("a task removed from the list does not fire on its own", () => {
  // t-1 is dropped; with no remaining task reaching completed, it is silent.
  assert.equal(taskCompletedDiff(phase(["pending", "in_progress"], "t"), phase(["in_progress"], "t")), false);
});

test("multiple phases: completion in a later phase fires", () => {
  const prev = [
    { name: "A", tasks: [{ content: "A-0", status: "completed" }] },
    { name: "B", tasks: [{ content: "B-0", status: "in_progress" }] },
  ];
  const next = [
    { name: "A", tasks: [{ content: "A-0", status: "completed" }] },
    { name: "B", tasks: [{ content: "B-0", status: "completed" }] },
  ];
  assert.equal(taskCompletedDiff(prev, next), true);
});

test("same content in two phases is keyed by phase name", () => {
  // A pending "t" in phase A must not be matched against a completed "t" in
  // phase B — they are different tasks.
  const prev = [
    { name: "A", tasks: [{ content: "t", status: "pending" }] },
    { name: "B", tasks: [{ content: "t", status: "completed" }] },
  ];
  const next = [
    { name: "A", tasks: [{ content: "t", status: "completed" }] },
    { name: "B", tasks: [{ content: "t", status: "completed" }] },
  ];
  // Phase A's task genuinely completed, so it fires — but for the right
  // reason (A's own transition), proven by the negative case below.
  assert.equal(taskCompletedDiff(prev, next), true);
  const prevNoA = [
    { name: "A", tasks: [{ content: "t", status: "pending" }] },
    { name: "B", tasks: [{ content: "t", status: "completed" }] },
  ];
  const nextNoA = [
    { name: "A", tasks: [{ content: "t", status: "pending" }] },
    { name: "B", tasks: [{ content: "t", status: "completed" }] },
  ];
  assert.equal(taskCompletedDiff(prevNoA, nextNoA), false);
});
