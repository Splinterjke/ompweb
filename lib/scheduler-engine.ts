import { randomUUID } from "crypto";
import { spawn, type ChildProcess } from "child_process";
import path from "path";
import {
  loadSchedulerFile,
  OUTPUT_TAIL_MAX,
  recordRun,
  saveSchedulerFile,
  setNextRunAt,
  type RunRecord,
  type SchedulerEntry,
} from "./scheduler-store";
import { repairedChildPath } from "./omp/omp-cli";
import { nextRunAfter } from "./schedule";

// ============================================================================
// Scheduler engine: the in-process cron. One 15-second tick checks every
// enabled scheduler's nextRunAt slot and fires the script when due.
//
// Semantics (informed by T0UGH/agent-cron):
//  - one run per scheduler at a time; a slot that fires while the previous
//    run is still active is recorded as `skipped`, never stacked;
//  - no catch-up chains: after a slot fires (or is skipped/missed) the next
//    slot is always the next future one, so a long outage can never burst;
//  - a slot older than MAX_CATCHUP_MS at engine start (server was down at the
//    scheduled time) is recorded as `missed` — the on-time guarantee check;
//  - a run starting more than LATE_MS after its slot is flagged `late`.
//
// The whole engine (timer + active runs) lives on globalThis, the same
// pattern as rpc-manager, so Next.js hot-reload in dev cannot fork a second
// ticker or orphan a child.
// ============================================================================

const TICK_MS = 15_000;
/** A run starting more than this after its slot is flagged late. */
const LATE_MS = 90_000;
/** A due slot older than this at engine start means the server was down at
 *  the scheduled time — record missed instead of firing a stale run. */
const MAX_CATCHUP_MS = 2 * 60_000;
const KILL_GRACE_MS = 5_000;

interface ActiveRun {
  child: ChildProcess;
  startedAt: Date;
  scheduledAt: Date;
  late: boolean;
  manual: boolean;
  timedOut: boolean;
  out: string;
  err: string;
  timeoutHandle: NodeJS.Timeout | undefined;
  killGrace: NodeJS.Timeout | undefined;
  finalized: boolean;
}

interface SchedulerEngineState {
  started: boolean;
  /** Millisecond timestamp of when this engine process first came up. Used to
   * distinguish runs recorded before a server restart (stale) from recent ones. */
  startedAt: number;
  running: Map<string, ActiveRun>;
  timer: NodeJS.Timeout | null;
}

declare global {
  var __ompSchedulerEngine: SchedulerEngineState | undefined;
}

function getEngineState(): SchedulerEngineState {
  if (!globalThis.__ompSchedulerEngine) {
    globalThis.__ompSchedulerEngine = {
      started: false,
      startedAt: Date.now(),
      running: new Map(),
      timer: null,
    };
  }
  return globalThis.__ompSchedulerEngine;
}

export function isSchedulerRunning(id: string): boolean {
  return getEngineState().running.has(id);
}

/** Start the ticker (idempotent; runs an immediate catch-up tick first). */
export function ensureSchedulerEngine(): void {
  const state = getEngineState();
  if (state.started) return;
  state.started = true;
  safeTick(new Date());
  state.timer = setInterval(() => safeTick(new Date()), TICK_MS);
}

function safeTick(now: Date): void {
  try {
    tickSchedulers(now);
  } catch (err) {
    console.error("[scheduler] tick failed:", err);
  }
}

/** One scheduling pass. Exported so tests can drive it deterministically. */
export function tickSchedulers(now: Date): void {
  const state = getEngineState();
  const file = loadSchedulerFile();
  for (const entry of file.schedulers) {
    if (!entry.enabled || !entry.nextRunAt) continue;
    const slot = new Date(entry.nextRunAt);
    if (Number.isNaN(slot.getTime()) || slot.getTime() > now.getTime()) continue;
    const delay = now.getTime() - slot.getTime();
    // Advance the slot BEFORE firing so a crash mid-run cannot re-fire it,
    // and a long run cannot chain-trigger its own next slots.
    const next = nextRunAfter(entry.schedule, now);
    saveSchedulerFile(setNextRunAt(entry.id, next ? next.toISOString() : null));
    if (state.running.has(entry.id)) {
      persistRun(entry.id, {
        id: randomUUID(),
        scheduledAt: slot.toISOString(),
        startedAt: now.toISOString(),
        finishedAt: now.toISOString(),
        status: "skipped",
      });
      continue;
    }
    if (delay > MAX_CATCHUP_MS) {
      persistRun(entry.id, {
        id: randomUUID(),
        scheduledAt: slot.toISOString(),
        startedAt: now.toISOString(),
        finishedAt: now.toISOString(),
        status: "missed",
      });
      continue;
    }
    startRun(entry, { scheduledAt: slot, late: delay > LATE_MS, manual: false, now });
  }
}

/** Manual trigger from the API. Does not touch the entry's nextRunAt. */
export function triggerManualRun(id: string, now = new Date()): { ok: true } | { ok: false; error: string } {
  const state = getEngineState();
  if (state.running.has(id)) return { ok: false, error: "already_running" };
  const file = loadSchedulerFile();
  const entry = file.schedulers.find((e) => e.id === id);
  if (!entry) return { ok: false, error: "scheduler_not_found" };
  startRun(entry, { scheduledAt: now, late: false, manual: true, now });
  return { ok: true };
}

/* ─────────────────────────── run lifecycle ─────────────────────────── */

interface StartOptions {
  scheduledAt: Date;
  late: boolean;
  manual: boolean;
  now: Date;
}

function startRun(entry: SchedulerEntry, opts: StartOptions): void {
  const state = getEngineState();
  let child: ChildProcess;
  const shell = /\.(sh|bash|zsh)$/i.test(path.basename(entry.script)) ? "bash" : "exec";
  try {
    child = shell === "bash"
      ? spawn("bash", [entry.script, ...entry.args], spawnOptions(entry.script))
      : spawn(entry.script, entry.args, spawnOptions(entry.script));
  } catch (err) {
    persistRun(entry.id, spawnErrorRun(entry.id, opts, err));
    return;
  }

  const active: ActiveRun = {
    child,
    startedAt: opts.now,
    scheduledAt: opts.scheduledAt,
    late: opts.late,
    manual: opts.manual,
    timedOut: false,
    out: "",
    err: "",
    timeoutHandle: entry.timeoutMs > 0 ? setTimeout(() => {
      active.timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      active.killGrace = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, KILL_GRACE_MS);
    }, entry.timeoutMs) : undefined,
    killGrace: undefined,
    finalized: false,
  };
  state.running.set(entry.id, active);

  child.stdout?.on("data", (chunk: Buffer) => {
    active.out = capTail(active.out + chunk.toString("utf8"));
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    active.err = capTail(active.err + chunk.toString("utf8"));
  });
  child.on("error", (err: NodeJS.ErrnoException) => {
    // Spawn-level failure (ENOENT, EACCES...): `close` may never fire, so
    // finalize from here.
    active.err = capTail(active.err + (err.message || String(err)));
    finalizeRun(entry.id, active, 1);
  });
  child.on("close", (code) => {
    finalizeRun(entry.id, active, typeof code === "number" ? code : 1);
  });
}

function spawnOptions(script: string) {
  return {
    cwd: path.dirname(script),
    // The server's own PATH is minimal (container/GUI launchers omit tool
    // dirs like /opt/node24/bin); repair it so scripts can find npm/npx.
    env: { ...process.env, PATH: repairedChildPath(process.env.PATH) },
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
  };
}

function spawnErrorRun(entryId: string, opts: StartOptions, err: unknown): RunRecord {
  return {
    id: randomUUID(),
    scheduledAt: opts.scheduledAt.toISOString(),
    startedAt: opts.now.toISOString(),
    finishedAt: new Date().toISOString(),
    status: "error",
    exitCode: 1,
    manual: opts.manual,
    late: opts.late,
    stderr: String(err instanceof Error ? err.message : err),
  };
}

function finalizeRun(entryId: string, active: ActiveRun, code: number): void {
  if (active.finalized) return;
  active.finalized = true;
  clearTimeout(active.timeoutHandle);
  getEngineState().running.delete(entryId);
  persistRun(entryId, {
    id: randomUUID(),
    scheduledAt: active.scheduledAt.toISOString(),
    startedAt: active.startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    status: active.timedOut ? "timeout" : code === 0 ? "ok" : "error",
    exitCode: code,
    late: active.late,
    manual: active.manual,
    stdout: active.out || undefined,
    stderr: active.err || undefined,
  });
}

function persistRun(entryId: string, run: RunRecord): void {
  try {
    saveSchedulerFile(recordRun(entryId, run));
  } catch (err) {
    console.error("[scheduler] failed to persist run:", err);
  }
}

/** Keep only the last OUTPUT_TAIL_MAX chars of a growing output buffer. */
function capTail(buf: string): string {
  return buf.length > OUTPUT_TAIL_MAX * 2 ? buf.slice(-OUTPUT_TAIL_MAX) : buf;
}

/* ─────────────────────────── state queries ─────────────────────────── */

export type SchedulerWithState = SchedulerEntry & { running: boolean };

/** ISO timestamp of when this engine process first came up (server start).
 * Consumers use it to separate runs recorded before a restart from recent
 * ones, so a stale pre-restart failure doesn't light the error indicator. */
export function getEngineStartedAt(): string {
  return new Date(getEngineState().startedAt).toISOString();
}

export function listSchedulersWithState(): SchedulerWithState[] {
  const running = getEngineState().running;
  return loadSchedulerFile().schedulers.map((e) => ({ ...e, running: running.has(e.id) }));
}

export function getSchedulerWithState(id: string): SchedulerWithState | null {
  const running = getEngineState().running;
  const entry = loadSchedulerFile().schedulers.find((e) => e.id === id);
  return entry ? { ...entry, running: running.has(entry.id) } : null;
}

/** Test seam: stop the ticker and drop engine state (active children, if any,
 *  are left to finish; tests should await them first). */
export function __resetSchedulerEngineForTests(): void {
  const state = globalThis.__ompSchedulerEngine;
  if (!state) return;
  if (state.timer) clearInterval(state.timer);
  state.running.clear();
  state.started = false;
  globalThis.__ompSchedulerEngine = undefined;
}
