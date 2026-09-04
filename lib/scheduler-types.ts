/**
 * Shared scheduler types — pure, no Node imports, safe on the client
 * (Sidebar panel + modal) and the server (store, engine, API routes).
 * ScheduleSpec / ScheduleUnit live in ./schedule (pure math, also client-safe).
 */
import type { ScheduleSpec } from "./schedule";
export type SchedulerStatus = "ok" | "error" | "timeout" | "missed" | "skipped";

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
  /** Bounded tails of the child output (last OUTPUT_TAIL_MAX chars each). */
  stdout?: string;
  stderr?: string;
}

export interface SchedulerEntry {
  id: string;
  name: string;
  script: string;
  args: string[];
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
