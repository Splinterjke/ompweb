// Goal mode wire types and defensive parsers (mirrors of oh-my-pi's RPC
// schema Goal / GoalModeState, omp >= 18.4.11). Every field is validated
// because payloads cross the RPC boundary; an unknown status is treated as
// no goal rather than guessed.

import { isRecord } from "./type-guards";

export type GoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";
export type GoalOp = "get" | "create" | "resume" | "pause" | "drop";

export interface GoalInfo {
  id: string;
  objective: string;
  status: GoalStatus;
  /** Token budget; absent = unbounded. */
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
}

/** `goal` RPC outcome and the `goal_updated` frame payload. */
export interface GoalResult {
  goal: GoalInfo | null;
  /** `"exiting"` while a completed goal unwinds. */
  mode?: "active" | "exiting";
}

const GOAL_STATUSES: GoalStatus[] = ["active", "paused", "budget-limited", "complete", "dropped"];

function asNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function parseGoal(value: unknown): GoalInfo | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || !value.id) return null;
  if (typeof value.objective !== "string") return null;
  const status = GOAL_STATUSES.find((candidate) => candidate === value.status);
  if (!status) return null;
  const tokensUsed = asNonNegativeNumber(value.tokensUsed) ?? 0;
  const timeUsedSeconds = asNonNegativeNumber(value.timeUsedSeconds) ?? 0;
  const tokenBudget = asNonNegativeNumber(value.tokenBudget);
  return {
    id: value.id,
    objective: value.objective,
    status,
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    tokensUsed,
    timeUsedSeconds,
  };
}

/** Reads a `GoalResult`-shaped RPC response (or the `goal_updated` frame,
 *  whose payload carries the same `goal` / `state` pair). */
export function parseGoalResult(value: unknown): GoalResult {
  if (!isRecord(value)) return { goal: null };
  const goal = parseGoal(value.goal);
  const state = isRecord(value.state) ? value.state : null;
  const mode = state?.mode === "active" || state?.mode === "exiting" ? state.mode : undefined;
  return { goal, ...(mode ? { mode } : {}) };
}
