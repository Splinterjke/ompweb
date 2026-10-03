import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, type Stats } from "fs";
import { homedir } from "os";
import path from "path";
import { getAgentDir } from "./omp/paths";
import { humanizeSchedule, nextRunAfter, validateSchedule, type ScheduleSpec } from "./schedule";
import type { SchedulerEntry, SchedulerFile, RunRecord, SchedulerStatus, SchedulerKind } from "./scheduler-types";

// Re-exported so existing server-side imports keep working.
export type { SchedulerEntry, SchedulerFile, RunRecord, SchedulerStatus, SchedulerKind } from "./scheduler-types";

export const MIN_TIMEOUT_MS = 5_000;
export const OUTPUT_TAIL_MAX = 262_144;
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const MAX_TIMEOUT_MS = 2 * 3_600_000;
/** Max runs kept per scheduler (newest first); older records are trimmed. */
const RUNS_CAP = 50;

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/** Error carrying a stable code (errors.* key) for client localization. */
export class SchedulerStoreError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

export function getSchedulersPath(): string {
  return path.join(getAgentDir(), "schedulers.json");
}

export function isValidSchedulerId(id: string): boolean {
  return ID_RE.test(id);
}

function newId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ─────────────────────────── loading ─────────────────────────── */

const EMPTY_FILE: SchedulerFile = { version: 1, schedulers: [] };

/** Tolerant load: missing/corrupt/foreign-shaped input yields an empty file
 *  rather than failing the whole API (mirrors parseProjectRegistry). Malformed
 *  individual entries are dropped; valid ones survive a partial corruption. */
export function parseSchedulerFile(raw: string): SchedulerFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY_FILE };
  }
  if (typeof parsed !== "object" || parsed === null) return { ...EMPTY_FILE };
  const file = parsed as { schedulers?: unknown };
  if (!Array.isArray(file.schedulers)) return { ...EMPTY_FILE };
  const schedulers: SchedulerEntry[] = [];
  for (const item of file.schedulers) {
    const entry = normalizeEntry(item);
    if (entry) schedulers.push(entry);
  }
  return { version: 1, schedulers };
}

function normalizeEntry(item: unknown): SchedulerEntry | null {
  if (typeof item !== "object" || item === null) return null;
  const e = item as Record<string, unknown>;
  if (typeof e.id !== "string" || !ID_RE.test(e.id)) return null;
  if (typeof e.name !== "string" || !e.name.trim()) return null;
  const kind: SchedulerKind = e.kind === "prompt" ? "prompt" : "script";
  if (kind === "script" && (typeof e.script !== "string" || !e.script.trim())) return null;
  if (kind === "prompt" && (typeof e.prompt !== "string" || !e.prompt.trim())) return null;
  try {
    const schedule = validateSchedule(e.schedule);
    const args = Array.isArray(e.args) ? e.args.filter((a): a is string => typeof a === "string") : [];
    const runs = Array.isArray(e.runs) ? e.runs.slice(0, RUNS_CAP).map(normalizeRun).filter((r): r is RunRecord => r !== null) : [];
    const enabled = typeof e.enabled === "boolean" ? e.enabled : true;
    const timeoutMs = typeof e.timeoutMs === "number" && Number.isFinite(e.timeoutMs)
      ? Math.min(MAX_TIMEOUT_MS, Math.max(0, e.timeoutMs))
      : DEFAULT_TIMEOUT_MS;
    const nextRunAt = typeof e.nextRunAt === "string" ? e.nextRunAt : null;
    const createdAt = typeof e.createdAt === "string" ? e.createdAt : new Date().toISOString();
    const updatedAt = typeof e.updatedAt === "string" ? e.updatedAt : createdAt;
    return {
      id: e.id,
      name: e.name,
      kind,
      script: kind === "script" ? (e.script as string) : undefined,
      args,
      prompt: kind === "prompt" ? (e.prompt as string) : undefined,
      provider: typeof e.provider === "string" && e.provider ? e.provider : undefined,
      modelId: typeof e.modelId === "string" && e.modelId ? e.modelId : undefined,
      thinkingLevel:
        kind === "prompt" && typeof e.thinkingLevel === "string" && e.thinkingLevel ? e.thinkingLevel : undefined,
      cwd: kind === "prompt" && typeof e.cwd === "string" && e.cwd ? e.cwd : undefined,
      noSession: kind === "prompt" && typeof e.noSession === "boolean" ? e.noSession : undefined,
      clearContext: kind === "prompt" && typeof e.clearContext === "boolean" ? e.clearContext : undefined,
      compactContext: kind === "prompt" && typeof e.compactContext === "boolean" && !e.clearContext ? e.compactContext : undefined,
      sessionId: kind === "prompt" && !e.noSession && typeof e.sessionId === "string" && e.sessionId ? e.sessionId : undefined,
      schedule,
      enabled,
      timeoutMs,
      createdAt,
      updatedAt,
      nextRunAt: enabled ? nextRunAt : null,
      human: humanizeSchedule(schedule),
      runs,
    };
  } catch {
    return null;
  }
}

function normalizeRun(item: unknown): RunRecord | null {
  if (typeof item !== "object" || item === null) return null;
  const r = item as Record<string, unknown>;
  const status = r.status;
  if (typeof r.id !== "string" || typeof r.scheduledAt !== "string" || typeof r.startedAt !== "string") return null;
  if (status !== "ok" && status !== "error" && status !== "timeout" && status !== "missed" && status !== "skipped") return null;
  return {
    id: r.id,
    scheduledAt: r.scheduledAt,
    startedAt: r.startedAt,
    finishedAt: typeof r.finishedAt === "string" ? r.finishedAt : undefined,
    status,
    exitCode: typeof r.exitCode === "number" ? r.exitCode : undefined,
    late: typeof r.late === "boolean" ? r.late : undefined,
    manual: typeof r.manual === "boolean" ? r.manual : undefined,
    stdout: typeof r.stdout === "string" ? r.stdout.slice(-OUTPUT_TAIL_MAX) : undefined,
    stderr: typeof r.stderr === "string" ? r.stderr.slice(-OUTPUT_TAIL_MAX) : undefined,
    sessionId: typeof r.sessionId === "string" && r.sessionId ? r.sessionId : undefined,
  };
}

export function loadSchedulerFile(): SchedulerFile {
  const file = getSchedulersPath();
  if (!existsSync(file)) return { ...EMPTY_FILE };
  try {
    return parseSchedulerFile(readFileSync(file, "utf8"));
  } catch {
    return { ...EMPTY_FILE };
  }
}

/** Atomic persistence: temp file in the same directory, then rename over the
 *  target. A crash mid-write leaves the previous file intact. */
export function saveSchedulerFile(file: SchedulerFile): void {
  const target = getSchedulersPath();
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), "utf8");
  renameSync(tmp, target);
}

/* ─────────────────────────── mutations (pure) ─────────────────────────── */

export interface CreateSchedulerInput {
  name?: string;
  /** "prompt" entries run `omp -p <prompt>`; "script" (default) runs a script path. */
  kind?: SchedulerKind;
  script?: string;
  args?: string[];
  prompt?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  cwd?: string;
  noSession?: boolean;
  clearContext?: boolean;
  compactContext?: boolean;
  schedule: ScheduleSpec;
  enabled?: boolean;
  timeoutMs?: number;
  /** First slot; defaults to the next run after `now`. */
  nextRunAt?: string;
  now?: Date;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function createSchedulerEntry(input: CreateSchedulerInput): { file: SchedulerFile; entry: SchedulerEntry } {
  const now = input.now ?? new Date();
  const file = loadSchedulerFile();
  const kind: SchedulerKind = input.kind === "prompt" ? "prompt" : "script";
  if (kind === "prompt" && !(input.prompt ?? "").trim()) throw schedulerError("instructions_required");
  if (kind === "prompt" && !(input.name ?? "").trim()) throw schedulerError("name_required");
  if (kind === "script" && !(input.script ?? "").trim()) throw schedulerError("script_required");
  if (input.clearContext && input.compactContext) throw schedulerError("context_mode_conflict");
  // Prompt names are required (checked above); only scripts fall back to a
  // generated name.
  const name = (input.name ?? "").trim() || path.basename(input.script!);
  const schedule = validateSchedule(input.schedule);
  const enabled = input.enabled ?? true;
  const timeoutMs = clampTimeout(input.timeoutMs);
  const args = (input.args ?? []).filter((a) => typeof a === "string" && a.length > 0).slice(0, 32);
  const nextRunAt = input.nextRunAt ?? (enabled ? nextRunIso(schedule, now) : null);
  const entry: SchedulerEntry = {
    id: newId(),
    name,
    kind,
    script: kind === "script" ? input.script!.trim() : undefined,
    args: kind === "script" ? args : [],
    prompt: kind === "prompt" ? input.prompt!.trim() : undefined,
    provider: kind === "prompt" ? optionalString(input.provider) : undefined,
    modelId: kind === "prompt" ? optionalString(input.modelId) : undefined,
    thinkingLevel: kind === "prompt" ? optionalString(input.thinkingLevel) : undefined,
    cwd: kind === "prompt" ? optionalString(input.cwd) : undefined,
    noSession: kind === "prompt" ? optionalBoolean(input.noSession) : undefined,
    clearContext: kind === "prompt" ? optionalBoolean(input.clearContext) : undefined,
    compactContext: kind === "prompt" && !input.clearContext ? optionalBoolean(input.compactContext) : undefined,
    schedule,
    enabled,
    timeoutMs,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    nextRunAt,
    human: humanizeSchedule(schedule),
    runs: [],
  };
  return { file: { version: 1, schedulers: [...file.schedulers, entry] }, entry };
}

export function updateSchedulerEntry(
  id: string,
  patch: {
    name?: string;
    kind?: SchedulerKind;
    script?: string;
    args?: string[];
    prompt?: string;
    provider?: string;
    modelId?: string;
    thinkingLevel?: string;
    cwd?: string;
    noSession?: boolean;
    clearContext?: boolean;
    compactContext?: boolean;
    schedule?: ScheduleSpec;
    enabled?: boolean;
    timeoutMs?: number;
  },
  now = new Date(),
): { file: SchedulerFile; entry: SchedulerEntry } {
  const file = loadSchedulerFile();
  const idx = file.schedulers.findIndex((e) => e.id === id);
  if (idx < 0) throw schedulerError("scheduler_not_found");
  const prev = file.schedulers[idx];
  const kind: SchedulerKind = patch.kind ?? prev.kind ?? "script";
  const schedule = patch.schedule !== undefined ? validateSchedule(patch.schedule) : prev.schedule;
  const script = kind === "script" ? (patch.script ?? prev.script ?? "").trim() : undefined;
  if (kind === "script" && !script) throw schedulerError("script_required");
  const prompt = kind === "prompt" ? (patch.prompt ?? prev.prompt ?? "").trim() : undefined;
  if (kind === "prompt" && !prompt) throw schedulerError("instructions_required");
  const trimmedName = (patch.name ?? prev.name).trim();
  if (kind === "prompt" && !trimmedName) throw schedulerError("name_required");
  const clearContext = kind === "prompt" ? optionalBoolean(patch.clearContext ?? prev.clearContext) : undefined;
  const compactContext = kind === "prompt" && !clearContext ? optionalBoolean(patch.compactContext ?? prev.compactContext) : undefined;
  if (clearContext && compactContext) throw schedulerError("context_mode_conflict");
  const enabled = patch.enabled ?? prev.enabled;
  const entry: SchedulerEntry = {
    ...prev,
    name: trimmedName || path.basename(script!),
    kind,
    script,
    args: kind === "script"
      ? (patch.args !== undefined ? patch.args.filter((a) => typeof a === "string" && a.length > 0).slice(0, 32) : prev.args)
      : [],
    prompt,
    provider: kind === "prompt" ? optionalString(patch.provider ?? prev.provider) : undefined,
    modelId: kind === "prompt" ? optionalString(patch.modelId ?? prev.modelId) : undefined,
    thinkingLevel: kind === "prompt" ? optionalString(patch.thinkingLevel ?? prev.thinkingLevel) : undefined,
    cwd: kind === "prompt" ? optionalString(patch.cwd ?? prev.cwd) : undefined,
    noSession: kind === "prompt" ? optionalBoolean(patch.noSession ?? prev.noSession) : undefined,
    clearContext,
    compactContext,
    schedule,
    enabled,
    timeoutMs: patch.timeoutMs !== undefined ? clampTimeout(patch.timeoutMs) : prev.timeoutMs,
    updatedAt: now.toISOString(),
    nextRunAt: enabled ? nextRunIso(schedule, now) : null,
    human: humanizeSchedule(schedule),
  };
  const schedulers = [...file.schedulers];
  schedulers[idx] = entry;
  return { file: { version: 1, schedulers }, entry };
}

function schedulerError(code: string, message?: string): SchedulerStoreError {
  return new SchedulerStoreError(code, message);
}

export function deleteSchedulerEntry(id: string): SchedulerFile {
  const file = loadSchedulerFile();
  const schedulers = file.schedulers.filter((e) => e.id !== id);
  if (schedulers.length === file.schedulers.length) throw schedulerError("scheduler_not_found");
  return { version: 1, schedulers };
}

/** Default seed: the repo's rebuild script as a manual-launch scheduler.
 * Seeded once at boot (instrumentation) so "Script schedulers" ships with the
 * rebuild workflow instead of requiring a hand entry. Manual launch: no
 * schedule slots, the user triggers runs from the UI. Resolves from the
 * server cwd (dev repo root / the /opt/ompweb install — the deploy mirror
 * ships the script at the install root too). Skips when the script is missing
 * (e.g. a packaged install without it) or an entry is already present. */
const REBUILD_SEED_NAME = "OmpWeb Rebuild & Restart";
const LEGACY_REBUILD_SEED_NAME = "Rebuild & restart";

export function ensureSeedSchedulers(now = new Date()): string | null {
  const file = loadSchedulerFile();
  const script = path.join(process.cwd(), "ompweb-rebuild-restart.sh");
  if (!existsSync(script)) return null;
  // A pre-existing entry may carry the original display name (renamed in
  // the UI or seeded before the name change). Reclaim it so the seed stays
  // unique instead of adding a second rebuild entry.
  const legacyIdx = file.schedulers.findIndex(
    (e) => e.script === script && e.name === LEGACY_REBUILD_SEED_NAME,
  );
  if (legacyIdx >= 0) {
    const schedulers = [...file.schedulers];
    schedulers[legacyIdx] = {
      ...schedulers[legacyIdx],
      name: REBUILD_SEED_NAME,
      updatedAt: now.toISOString(),
    };
    try {
      saveSchedulerFile({ ...file, schedulers });
    } catch (error) {
      console.warn(`[omp-web] scheduler seed rename failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }
  if (file.schedulers.some((e) => e.name === REBUILD_SEED_NAME && e.script === script)) return null;
  const { entry } = createSchedulerEntry({
    name: REBUILD_SEED_NAME,
    script,
    schedule: { kind: "manual" },
    enabled: true,
    // A full npm build comfortably exceeds the default 10 minutes.
    timeoutMs: 20 * 60_000,
    now,
  });
  try {
    saveSchedulerFile({ ...file, schedulers: [...file.schedulers, entry] });
  } catch (error) {
    console.warn(`[omp-web] scheduler seed failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  console.log(`[omp-web] seeded scheduler: ${REBUILD_SEED_NAME} (manual launch)`);
  return entry.id;
}

/** Prepend a run record, capping history. No-op-safe when the entry is gone
 *  (deleted while its run was finishing). */
export function recordRun(id: string, run: RunRecord): SchedulerFile {
  const file = loadSchedulerFile();
  const idx = file.schedulers.findIndex((e) => e.id === id);
  if (idx < 0) return file;
  const entry = file.schedulers[idx];
  const schedulers = [...file.schedulers];
  schedulers[idx] = { ...entry, runs: [run, ...entry.runs].slice(0, RUNS_CAP) };
  return { version: 1, schedulers };
}

/** Set only nextRunAt (the engine advances slots as it fires). */
export function setNextRunAt(id: string, nextRunAt: string | null): SchedulerFile {
  const file = loadSchedulerFile();
  const idx = file.schedulers.findIndex((e) => e.id === id);
  if (idx < 0) return file;
  const schedulers = [...file.schedulers];
  schedulers[idx] = { ...schedulers[idx], nextRunAt };
  return { version: 1, schedulers };
}

/** Set only the persistent session id for a prompt-type entry (the engine
 *  updates it after each successful session-mode run). No-op when the id is
 *  gone so a late-finished run cannot resurrect a deleted entry. */
export function setSchedulerSessionId(id: string, sessionId: string | null): SchedulerFile {
  const file = loadSchedulerFile();
  const idx = file.schedulers.findIndex((e) => e.id === id);
  if (idx < 0) return file;
  const schedulers = [...file.schedulers];
  schedulers[idx] = { ...schedulers[idx], sessionId: sessionId ?? undefined };
  return { version: 1, schedulers };
}

/** Empty a scheduler's run history. Throws when the id is gone. */
export function clearRuns(id: string): SchedulerFile {
  const file = loadSchedulerFile();
  const idx = file.schedulers.findIndex((e) => e.id === id);
  if (idx < 0) throw schedulerError("scheduler_not_found");
  const schedulers = [...file.schedulers];
  schedulers[idx] = { ...schedulers[idx], runs: [] };
  return { version: 1, schedulers };
}

/** Sessions created by prompt-type automation runs, keyed by session id →
 *  scheduler name. The /api/sessions route uses this to mark those sessions
 *  (clock icon in the sidebar). */
export function getAutomationSessions(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const entry of loadSchedulerFile().schedulers) {
    if (entry.kind !== "prompt") continue;
    for (const run of entry.runs) {
      if (run.sessionId) map[run.sessionId] = entry.name;
    }
  }
  return map;
}

function clampTimeout(timeoutMs?: number): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) return DEFAULT_TIMEOUT_MS;
  // 0 means "never kill the run"; otherwise clamp into [MIN_TIMEOUT_MS, MAX_TIMEOUT_MS].
  return timeoutMs === 0 ? 0 : Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(timeoutMs)));
}

function nextRunIso(spec: ScheduleSpec, from: Date): string | null {
  const next = nextRunAfter(spec, from);
  return next ? next.toISOString() : null;
}

/* ─────────────────────────── script validation ─────────────────────────── */

export interface ScriptValidation {
  ok: boolean;
  path: string;
  shell: "bash" | "exec";
  error?: string;
}

/** Expand `~` and validate a user-supplied script path: it must exist and be
 *  a regular file. `.sh`/`.bash`/`.zsh` run via bash; anything else is
 *  exec'd directly and therefore must carry the executable bit. */
export function validateScriptPath(raw: string): ScriptValidation {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: false, path: "", shell: "exec", error: "script_required" };
  const expanded = trimmed.startsWith("~/")
    ? path.join(homedir(), trimmed.slice(2))
    : trimmed === "~"
      ? homedir()
      : trimmed;
  const abs = path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
  let stat: Stats;
  try {
    stat = statSync(abs);
  } catch {
    return { ok: false, path: abs, shell: "exec", error: "script_not_found" };
  }
  if (!stat.isFile()) {
    return { ok: false, path: abs, shell: "exec", error: "script_not_found" };
  }
  const shell: "bash" | "exec" = /\.(sh|bash|zsh)$/i.test(path.basename(abs)) ? "bash" : "exec";
  if (shell === "exec") {
    try {
      accessSync(abs, constants.X_OK);
    } catch {
      return { ok: false, path: abs, shell, error: "script_not_executable" };
    }
  }
  return { ok: true, path: abs, shell };
}
/** Prompt-run workspace validation (POST/PATCH): optional; when set it must
 *  resolve (with `~/` expansion) to an existing directory. Returns the
 *  absolute path, `path: undefined` when unset/blank (→ default cwd), or a
 *  stable `invalid_cwd` error code. */
export function validateWorkspacePath(raw: unknown): { ok: true; path?: string } | { ok: false; error: "invalid_cwd" } {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return { ok: true, path: undefined };
  const expanded = trimmed.startsWith("~/")
    ? path.join(homedir(), trimmed.slice(2))
    : trimmed === "~"
      ? homedir()
      : trimmed;
  const abs = path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
  try {
    if (!statSync(abs).isDirectory()) return { ok: false, error: "invalid_cwd" };
  } catch {
    return { ok: false, error: "invalid_cwd" };
  }
  return { ok: true, path: abs };
}
