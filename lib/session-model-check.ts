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
 * Read the last default-role `model_change` entry from a session file. A
 * bounded tail read covers the common case (the model was switched recently);
 * when the tail window holds no entry, a long session that never changed its
 * model keeps the entry near the head, so the whole file is streamed once as
 * a fallback. Returns null when the file records no restorable model (a
 * brand-new or role-only file) — callers must treat that as "nothing to
 * check", never as a failure.
 */
/** Match one JSONL line against the saved-model rule; null when it is not the entry. */
function matchSavedModelLine(line: string): SavedSessionModel | null {
  if (!line.includes('"model_change"')) return null;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!entry || typeof entry !== "object") return null;
  const record = entry as { type?: unknown; model?: unknown; role?: unknown };
  if (record.type !== "model_change" || typeof record.model !== "string" || !record.model) return null;
  // `role:"title"`, `role:"subagent:*"` … entries name OTHER models than
  // the one a resume restores; only the default-role entry is the
  // session's saved model.
  if (record.role !== undefined && record.role !== "default") return null;
  const full = record.model;
  const slash = full.indexOf("/");
  if (slash <= 0 || slash === full.length - 1) return null;
  return { full, provider: full.slice(0, slash), modelId: full.slice(slash + 1) };
}

/**
 * Fallback for files whose tail window holds no entry: stream the whole file
 * forward in chunks (the fd's own position, so it never races the tail read's
 * explicit offsets) and keep the LAST default-role match. Only whole lines
 * are matched (a trailing fragment without a newline is the file's last line
 * and counts); memory stays bounded by the chunk size.
 */
function scanWholeFileForSavedModel(fd: number): SavedSessionModel | null {
  const CHUNK_BYTES = 1024 * 1024;
  const chunk = Buffer.alloc(CHUNK_BYTES);
  const EMPTY = Buffer.alloc(0);
  let carry = EMPTY;
  let pos = 0;
  let last: SavedSessionModel | null = null;
  for (;;) {
    const got = readSync(fd, chunk, 0, CHUNK_BYTES, pos);
    if (got <= 0) break;
    pos += got;
    const data = carry === EMPTY ? chunk.subarray(0, got) : Buffer.concat([carry, chunk.subarray(0, got)]);
    let start = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== 0x0a) continue;
      const found = matchSavedModelLine(data.toString("utf8", start, i).trim());
      if (found) last = found;
      start = i + 1;
    }
    // Copy: `chunk` is overwritten by the next readSync.
    carry = start < data.length ? Buffer.from(data.subarray(start)) : EMPTY;
  }
  if (carry.length > 0) {
    const found = matchSavedModelLine(carry.toString("utf8").trim());
    if (found) last = found;
  }
  return last;
}

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
      const found = matchSavedModelLine(lines[i].trim());
      if (found) return found;
    }
    // A long session that never switched models keeps its entry before the
    // tail window — stream the whole file instead of reporting "no model".
    if (offset > 0) return scanWholeFileForSavedModel(fd);
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

interface Availability {
  at: number;
  keys: Set<string>;
  /** modelId -> every live provider offering it, for rename detection. */
  providersByModelId: Map<string, Set<string>>;
}

let availability: Availability | null = null;
let availabilityInFlight: Promise<Availability | null> | null = null;

/** Invalidate the availability snapshot (after a login/logout/model change). */
export function invalidateModelAvailability(): void {
  availability = null;
}

async function loadAvailability(): Promise<Availability | null> {
  if (availability && Date.now() - availability.at < AVAILABILITY_TTL_MS) return availability;
  if (availabilityInFlight) return availabilityInFlight;
  const load = (async (): Promise<Availability | null> => {
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
      const providersByModelId = new Map<string, Set<string>>();
      for (const model of response.models) {
        if (!model || typeof model !== "object") continue;
        const { id, provider } = model as { id?: unknown; provider?: unknown };
        if (typeof id !== "string" || typeof provider !== "string") continue;
        if (disabled.has(provider)) continue;
        keys.add(`${provider}/${id}`);
        let owners = providersByModelId.get(id);
        if (!owners) providersByModelId.set(id, (owners = new Set()));
        owners.add(provider);
      }
      availability = { at: Date.now(), keys, providersByModelId };
      return availability;
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
  | { status: "unavailable"; model: string }
  /** The saved model's provider is gone but its model id exists under
   * exactly one live provider — a rename; spawn with it as the binding. */
  | { status: "rebind"; model: string; replacement: { provider: string; modelId: string } };

/**
 * Resolve a dead `provider/modelId` against the live catalog: a repair is
 * only recognized when the model id belongs to exactly one live provider
 * (and that provider is not the dead one). Anything ambiguous — zero, two,
 * or the same provider — keeps the explicit rebind dialog.
 */
export function resolveUniqueRename(
  saved: { provider: string; modelId: string },
  providersByModelId: Map<string, Set<string>>,
): { provider: string; modelId: string } | undefined {
  const owners = providersByModelId.get(saved.modelId);
  if (!owners || owners.size !== 1 || owners.has(saved.provider)) return undefined;
  const [provider] = owners;
  return { provider, modelId: saved.modelId };
}

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
  const availability = await loadAvailability();
  if (!availability) return { status: "skip" };
  if (availability.keys.has(saved.full)) return { status: "available", model: saved.full };
  const replacement = resolveUniqueRename(saved, availability.providersByModelId);
  return replacement
    ? { status: "rebind", model: saved.full, replacement }
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

/**
 * Model-switch repair: `set_model` against a session whose saved model is
 * unrestorable IS the rebind — the model the user just picked replaces it,
 * so the cold spawn must start bound to it instead of failing the pre-flight
 * on a model the UI has already rejected. The subsequent `set_model` command
 * then records the `model_change` entry, making the switch permanent.
 * An explicit `startup` body field always wins over this derivation.
 */
export function modelSwitchRepairBinding(command: {
  type?: unknown;
  provider?: unknown;
  modelId?: unknown;
}): SessionStartupBinding | undefined {
  if (command.type !== "set_model") return undefined;
  return parseSessionStartupBinding({
    modelOverride: { provider: command.provider, modelId: command.modelId },
  });
}
