/**
 * Shared validation + normalization of `todoPhases` snapshots — the single
 * source of truth behind BOTH feeds of the Tasks hub bar: the live
 * `get_state.todoPhases` snapshot (`lib/rpc-manager.ts` buildWebState) and the
 * on-disk history scan (`lib/session-reader.ts` getTodoPhasesFromEntries).
 *
 * INSURANCE UNTIL NATIVE OMP RESOLVES THE ISSUE: omp <= 18.8.9 accepts a
 * `todo init` call whose `items` are not plain strings and stringifies each
 * entry into the task text, so a model that nests its phase structure inside
 * `items` — e.g. {"op":"init","items":[{"phase":"Implement","items":["…"]}]},
 * observed with a vLLM-hosted model in session 01a12770-b83b-750b-a684-88c3753275fe —
 * lands tasks whose content is that whole JSON object verbatim (the "unparsed
 * JSON" Tasks bar), and a later `rm` cleanup leaves a phase with zero tasks
 * behind (the ghost "0 / 0 complete" bar). Until upstream validates `items`
 * are strings and prunes emptied phases, normalizeTodoPhases() below re-expands
 * that JSON into real phases/tasks and drops empty phases so the UI never
 * renders either artifact. Once upstream fixes it this rescue path becomes
 * dead code — keep the structural validation part regardless.
 */
import type { TodoItem, TodoPhase } from "./pi-types";
import { isRecord } from "./type-guards";

/** Accepted task statuses on the wire (omp's todo store). A static lookup
 * table, so a Record literal — not a Set. */
const VALID_TODO_STATUSES: Record<string, true> = {
  pending: true,
  in_progress: true,
  completed: true,
  blocked: true,
  abandoned: true,
};

/**
 * Structural validation shared by every feed: returns null for anything that
 * is not a well-formed phase array (the session-reader walk then falls back
 * to an older snapshot). Moved from `session-reader.ts` so the live
 * `get_state` feed validates the same way history does.
 */
export function parseTodoPhases(value: unknown): TodoPhase[] | null {
  if (!Array.isArray(value)) return null;
  const phases: TodoPhase[] = [];
  for (const phase of value) {
    if (!isRecord(phase) || typeof phase.name !== "string" || !Array.isArray(phase.tasks)) return null;
    const tasks: TodoItem[] = [];
    for (const task of phase.tasks) {
      if (!isRecord(task) || typeof task.content !== "string" || typeof task.status !== "string" || VALID_TODO_STATUSES[task.status] !== true) return null;
      if (task.blocker !== undefined && typeof task.blocker !== "string") return null;
      tasks.push({
        content: task.content,
        status: task.status as TodoItem["status"],
        ...(typeof task.blocker === "string" ? { blocker: task.blocker } : {}),
      });
    }
    phases.push({ name: phase.name, tasks });
  }
  return phases;
}

/** Only contents this short are even parsed for the JSON rescue below. */
const RESCUE_CONTENT_LIMIT = 8192;
/** Bound the recursion over nested {phase, items} objects. */
const RESCUE_MAX_DEPTH = 3;

type Rescued = {
  /** Tasks that belong to the phase the mangled task lived in. */
  inline: TodoItem[];
  /** Phases the mangled JSON declared for itself ({phase, items} entries). */
  named: Array<{ name: string; tasks: TodoItem[] }>;
};

/**
 * Collect string items as tasks and nested {phase, items} objects as their own
 * phases. Non-phase-shaped entries keep the stringified text omp itself
 * stored — the rescue must not invent content, only undo the stringify.
 */
function flattenItems(items: unknown[], status: TodoItem["status"], depth: number, defaultName: string, out: Rescued) {
  for (const item of items) {
    if (typeof item === "string") {
      out.inline.push({ content: item, status });
      continue;
    }
    if (isRecord(item) && Array.isArray(item.items) && depth <= RESCUE_MAX_DEPTH) {
      const name = typeof item.phase === "string" && item.phase.trim() ? item.phase.trim() : defaultName;
      const nested: Rescued = { inline: [], named: [] };
      flattenItems(item.items, "pending", depth + 1, name, nested);
      pushExtra(out.named, name, nested.inline);
      for (const deeper of nested.named) pushExtra(out.named, deeper.name, deeper.tasks);
      continue;
    }
    if (isRecord(item) || typeof item === "number" || typeof item === "boolean") {
      out.inline.push({ content: JSON.stringify(item), status });
    }
  }
}

/** Append to the first same-named phase, else open a new one; empty skipped. */
function pushExtra(extras: Array<{ name: string; tasks: TodoItem[] }>, name: string, tasks: TodoItem[]) {
  if (tasks.length === 0) return;
  const existing = extras.find((extra) => extra.name === name);
  if (existing) existing.tasks.push(...tasks);
  else extras.push({ name, tasks });
}

/** Undo one stringified `init` item; null when the content is not that shape. */
function rescueTask(task: TodoItem, hostPhaseName: string): Rescued | null {
  if (task.content.length > RESCUE_CONTENT_LIMIT) return null;
  const trimmed = task.content.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.items)) return null;
  const explicitName = typeof parsed.phase === "string" && parsed.phase.trim() ? parsed.phase.trim() : null;
  const out: Rescued = { inline: [], named: [] };
  flattenItems(parsed.items, task.status, 1, explicitName ?? hostPhaseName, out);
  // A declared phase name means the string items belong to THAT phase, not to
  // the host phase omp filed the mangled task under ("Tasks" by default).
  if (explicitName) pushExtra(out.named, explicitName, out.inline.splice(0, out.inline.length));
  return out;
}

/**
 * Validate + normalize a raw snapshot from omp (`get_state.todoPhases` or a
 * persisted todo toolResult): null when structurally invalid, otherwise the
 * rescued phase list — mangled JSON task contents re-expanded (see the file
 * header insurance note) and phases left without tasks dropped, so an
 * emptied list never renders as a ghost "0 / 0 complete" bar.
 */
export function normalizeTodoPhases(value: unknown): TodoPhase[] | null {
  const phases = parseTodoPhases(value);
  if (!phases) return null;
  const extras: Array<{ name: string; tasks: TodoItem[] }> = [];
  const out: TodoPhase[] = [];
  for (const phase of phases) {
    const tasks: TodoItem[] = [];
    for (const task of phase.tasks) {
      const rescued = rescueTask(task, phase.name);
      if (!rescued) {
        tasks.push(task);
        continue;
      }
      tasks.push(...rescued.inline);
      for (const named of rescued.named) pushExtra(extras, named.name, named.tasks);
    }
    out.push({ ...phase, tasks });
  }
  for (const extra of extras) {
    const existing = out.find((phase) => phase.name === extra.name);
    if (existing) existing.tasks.push(...extra.tasks);
    else out.push({ name: extra.name, tasks: extra.tasks });
  }
  return out.filter((phase) => phase.tasks.length > 0);
}
