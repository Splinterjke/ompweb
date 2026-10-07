import { closeSync, fstatSync, openSync, readSync } from "fs";
import { runUtilityCommand } from "./omp/rpc-utility";
import { readDisabledProviders } from "./omp/model-roles";

/** The model a session file last recorded for the main (default) role. */
export interface SavedSessionModel {
  /** Wire form `provider/modelId`. */
  full: string;
  provider: string;
  modelId: string;
}

/** Spawn-time binding for a session start (client `startup` body field). */
export interface SessionStartupBinding {
  /** Bind the resumed session to this model instead of its saved one, like
   * `--model` at startup — omp then skips the saved-model restore check. */
  modelOverride?: { provider: string; modelId: string };
  /** Start even though the pre-flight found the saved model unavailable
   * (the user overrode the warning — omp still fail-closes on its own). */
  forceModelCheck?: boolean;
}

const TAIL_BYTES = 512 * 1024;
const AVAILABILITY_TTL_MS = 60_000;
const MODELS_RPC_TIMEOUT_MS = 60_000;

/**
 * Read the last default-role `model_change` entry from a session file via a
 * bounded tail read (session files can be tens of MB; the saved model is
 * always near the tail). Returns null when the file records no restorable
 * model (a brand-new or role-only file) — callers must treat that as
 * "nothing to check", never as a failure.
 */
export function readSessionSavedModel(filePath: string): SavedSessionModel | null {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const { size } = fstatSync(fd);
    const len = Math.min(size, TAIL_BYTES);
    const offset = size - len;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, offset);
    const lines = buf.toString("utf8").split("\n");
    // A tail read starts mid-line; that fragment can never be a full entry.
    if (offset > 0) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.includes('"model_change"')) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!entry || typeof entry !== "object") continue;
      const record = entry as { type?: unknown; model?: unknown; role?: unknown };
      if (record.type !== "model_change" || typeof record.model !== "string" || !record.model) continue;
      // `role:"title"`, `role:"subagent:*"` … entries name OTHER models than
      // the one a resume restores; only the default-role entry is the
      // session's saved model.
      if (record.role !== undefined && record.role !== "default") continue;
      const full = record.model;
      const slash = full.indexOf("/");
      if (slash <= 0 || slash === full.length - 1) continue;
      return { full, provider: full.slice(0, slash), modelId: full.slice(slash + 1) };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The fd is best-effort; nothing to clean up after a failed open.
      }
    }
  }
}

let availability: { at: number; keys: Set<string> } | null = null;
let availabilityInFlight: Promise<Set<string> | null> | null = null;

/** Invalidate the availability snapshot (after a login/logout/model change). */
export function invalidateModelAvailability(): void {
  availability = null;
}

async function loadAvailableModelKeys(): Promise<Set<string> | null> {
  if (availability && Date.now() - availability.at < AVAILABILITY_TTL_MS) return availability.keys;
  if (availabilityInFlight) return availabilityInFlight;
  const load = (async (): Promise<Set<string> | null> => {
    try {
      const response = await runUtilityCommand<{ models?: unknown }>(
        { type: "get_available_models" },
        MODELS_RPC_TIMEOUT_MS,
      );
      if (!Array.isArray(response.models)) return null;
      let disabled: Set<string>;
      try {
        disabled = readDisabledProviders();
      } catch {
        disabled = new Set();
      }
      const keys = new Set<string>();
      for (const model of response.models) {
        if (!model || typeof model !== "object") continue;
        const { id, provider } = model as { id?: unknown; provider?: unknown };
        if (typeof id !== "string" || typeof provider !== "string") continue;
        if (disabled.has(provider)) continue;
        keys.add(`${provider}/${id}`);
      }
      availability = { at: Date.now(), keys };
      return keys;
    } catch {
      return null;
    } finally {
      availabilityInFlight = null;
    }
  })();
  availabilityInFlight = load;
  return load;
}

export type SavedModelCheck =
  /** Nothing to decide: no saved model, or availability is unknown. */
  | { status: "skip" }
  | { status: "available"; model: string }
  | { status: "unavailable"; model: string };

/**
 * Pre-flight for omp's fail-closed model restore (omp ≥ 18.6.3): `--resume`
 * in rpc-ui mode exits with `Could not restore model <p/id>` instead of
 * starting, and in Rust host mode the child's stderr is discarded, so the
 * reason would be lost. Checking the model against the same list the composer
 * offers lets the UI offer a rebind up front. A "skip" (list fetch failed)
 * never blocks a start; a false negative only costs one failed spawn.
 */
export async function checkSavedSessionModel(filePath: string): Promise<SavedModelCheck> {
  const saved = readSessionSavedModel(filePath);
  if (!saved) return { status: "skip" };
  const keys = await loadAvailableModelKeys();
  if (!keys) return { status: "skip" };
  return keys.has(saved.full)
    ? { status: "available", model: saved.full }
    : { status: "unavailable", model: saved.full };
}

/**
 * Classify a failed session spawn's message (Node mode keeps omp's stderr
 * tail; Rust mode loses it, so the pre-flight is the primary detector).
 */
export function classifyStartupFailure(
  message: string,
): { kind: "model"; model: string } | { kind: "missing"; path: string } | null {
  const model = /Could not restore model (\S+)/.exec(message);
  if (model) return { kind: "model", model: model[1].replace(/[.,;:]$/, "") };
  const missing = /Session "([^"]+)" not found/.exec(message);
  if (missing) return { kind: "missing", path: missing[1] };
  return null;
}

const MODEL_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** Validate the client's optional `startup` body field into a binding. */
export function parseSessionStartupBinding(value: unknown): SessionStartupBinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as { modelOverride?: unknown; forceModelCheck?: unknown };
  const binding: SessionStartupBinding = {};
  if (raw.modelOverride !== undefined && raw.modelOverride !== null) {
    if (typeof raw.modelOverride !== "object") return undefined;
    const { provider, modelId } = raw.modelOverride as { provider?: unknown; modelId?: unknown };
    if (
      typeof provider !== "string" || typeof modelId !== "string"
      || !MODEL_SEGMENT.test(provider) || !MODEL_SEGMENT.test(modelId)
    ) {
      return undefined;
    }
    binding.modelOverride = { provider, modelId };
  }
  if (raw.forceModelCheck === true) binding.forceModelCheck = true;
  return binding.modelOverride || binding.forceModelCheck ? binding : undefined;
}
