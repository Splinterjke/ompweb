import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { parseGoal, parseGoalResult } = await jiti.import("./goal.ts");

const fullGoal = {
  id: "g1",
  objective: "Ship the release",
  status: "active",
  tokenBudget: 200000,
  tokensUsed: 12000,
  timeUsedSeconds: 45,
  createdAt: 1,
  updatedAt: 2,
};

test("parses a full goal and a goal_updated frame payload", () => {
  assert.deepEqual(parseGoal(fullGoal), {
    id: "g1",
    objective: "Ship the release",
    status: "active",
    tokenBudget: 200000,
    tokensUsed: 12000,
    timeUsedSeconds: 45,
  });
  // The frame carries the same pair at the top level.
  const frame = parseGoalResult({ type: "goal_updated", goal: fullGoal, state: { enabled: true, mode: "exiting", goal: fullGoal } });
  assert.equal(frame.goal?.id, "g1");
  assert.equal(frame.mode, "exiting");
});

test("rejects malformed goals instead of guessing", () => {
  assert.equal(parseGoal(null), null);
  assert.equal(parseGoal(undefined), null);
  assert.equal(parseGoal({ ...fullGoal, id: "" }), null);
  assert.equal(parseGoal({ ...fullGoal, status: "waiting-for-permission" }), null);
  assert.equal(parseGoal({ ...fullGoal, objective: 7 }), null);
  // Optional/invalid numerics degrade, they do not null the whole goal.
  const degraded = parseGoal({ ...fullGoal, tokenBudget: -1, tokensUsed: "x", timeUsedSeconds: null });
  assert.equal(degraded?.tokenBudget, undefined);
  assert.equal(degraded?.tokensUsed, 0);
  assert.equal(degraded?.timeUsedSeconds, 0);
});

test("empty and unknown RPC results read as no goal", () => {
  assert.deepEqual(parseGoalResult({ goal: null, state: null }), { goal: null });
  assert.deepEqual(parseGoalResult("nope"), { goal: null });
  // A non-null goal with an unknown state mode keeps the goal, drops mode.
  const result = parseGoalResult({ goal: fullGoal, state: { enabled: true, mode: "winding" } });
  assert.equal(result.goal?.status, "active");
  assert.equal(result.mode, undefined);
});
