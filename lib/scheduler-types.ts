/**
 * Shared scheduler types — pure, no Node imports, safe on the client
 * (Sidebar panel + modal) and the server (store, engine, API routes).
 * ScheduleSpec / ScheduleUnit live in ./schedule (pure math, also client-safe).
 */
import type { ScheduleSpec } from "./schedule";
export type SchedulerStatus = "ok" | "error" | "timeout" | "missed" | "skipped";

/** "script" (default, backward compatible) runs a script path; "prompt"
 * runs `omp -p <instructions>` against a model. */
export type SchedulerKind = "script" | "prompt";

export interface RunRecord {
  id: string;
  /** The scheduled slot time (for scheduled runs) or the manual trigger time. */
  scheduledAt: string;
  startedAt: string;
  finishedAt?: string;
  status: SchedulerStatus;
  exitCode?: number;
  /** True when the run started notably after its slot (tick delay). */
  late?: boolean;
  /** True for runs triggered by the user instead of the schedule. */
  manual?: boolean;
  /** Bounded tails of the child output (last OUTPUT_TAIL_MAX chars each).
   *  Prompt-type runs capture only a small tail (model output is not
   *  stored for display). */
  stdout?: string;
  stderr?: string;
  /** Session created by this run (prompt-type, session mode). Lets the UI
   *  link from the run log to the session and the sidebar mark it. */
  sessionId?: string;
}

export interface SchedulerEntry {
  id: string;
  name: string;
  /** Entry kind. Absent on entries written before prompts existed —
   *  treated as "script". */
  kind: SchedulerKind;
  /** Script path (required when kind is "script"; absent for prompts). */
  script?: string;
  args: string[];
  /** Prompt type: instructions text sent on every run. */
  prompt?: string;
  /** Prompt type: provider for the model (undefined = default). */
  provider?: string;
  /** Prompt type: model id (undefined = default). */
  modelId?: string;
  /** Prompt type: thinking level passed via `--thinking` (undefined =
   *  the model default, no flag sent). */
  thinkingLevel?: string;
  /** Prompt type: workspace (cwd) the omp session starts in (undefined =
   *  the dated default-cwd directory). Validated as an existing directory
   *  by the API; the engine mkdirs it defensively before spawn. */
  cwd?: string;
  /** Session mode: the persistent session this automation resumes. Set after
   *  the first successful run; cleared runs create a new one each time. */
  sessionId?: string;
  /** Prompt type: run in OMP no-session mode (ephemeral, no session file). */
  noSession?: boolean;
  /** Prompt type: clear the session context before the prompt is sent. */
  clearContext?: boolean;
  /** Prompt type: compact the session context before the prompt is sent.
   *  Mutually exclusive with clearContext (UI + validation). */
  compactContext?: boolean;
  schedule: ScheduleSpec;
  enabled: boolean;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
  /** Next slot the engine will fire at (null while disabled). */
  nextRunAt: string | null;
  /** Human description kept in sync with the schedule (server-rendered). */
  human: string;
  /** Newest first, capped at RUNS_CAP. */
  runs: RunRecord[];
}

export interface SchedulerFile {
  version: 1;
  schedulers: SchedulerEntry[];
}

/** Entry as served by the API: store entry + live running flag. */
export type SchedulerWithState = SchedulerEntry & { running: boolean };

/** Fully-qualified `provider/model` argument value for prompt runs. The modal
 *  stores `modelId` fully qualified (`provider/id`), so re-prefixing the
 *  provider would double it (`prov/prov/model`). A modelId already prefixed
 *  with the provider is used as-is; a bare id gets the prefix; no model
 *  returns null. Shared by the engine's spawn args and the panel's meta chip. */
export function modelFlagValue(provider?: string, modelId?: string): string | null {
  if (!modelId) return null;
  if (!provider || modelId.startsWith(`${provider}/`)) return modelId;
  return `${provider}/${modelId}`;
}
