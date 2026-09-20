import type { TodoPhase } from "./pi-types";

/**
 * Pure, unit-testable check for the `task_completed` chat event: did at least
 * one task transition from a non-completed status to "completed" between two
 * `get_state` todo snapshots?
 *
 * The todo tool's arguments are stringified JSON and the `tool_execution_end`
 * frame carries no arguments, so `get_state.todoPhases` is the only reliable
 * source. Tasks carry no stable id in the rpc state, so they are keyed by
 * (phase name, content) — re-adding the same task is treated as the same task.
 *
 * A `null` previous snapshot is the first observation of a session's todo
 * state (e.g. right after `todo` `op:"init"`): it records the baseline and
 * must NOT fire, so a freshly-initialized (or resumed) list never counts as a
 * completion. Fire-and-forget callers store the new snapshot unconditionally.
 */
export function taskCompletedDiff(prev: TodoPhase[] | null, next: TodoPhase[]): boolean {
  if (!Array.isArray(next) || next.length === 0) return false;
  if (!Array.isArray(prev) || prev.length === 0) return false;

  const keyOf = (phase: TodoPhase, task: TodoPhase["tasks"][number]): string =>
    `${phase.name}\u0000${task.content}`;

  const prevStatus = new Map<string, string>();
  for (const phase of prev) {
    for (const task of phase.tasks) {
      prevStatus.set(keyOf(phase, task), task.status);
    }
  }
  for (const phase of next) {
    for (const task of phase.tasks) {
      const before = prevStatus.get(keyOf(phase, task));
      if (before !== undefined && before !== "completed" && task.status === "completed") {
        return true;
      }
    }
  }
  return false;
}
