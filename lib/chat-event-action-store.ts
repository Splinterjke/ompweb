import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";
import { getAgentDir } from "./omp/paths";
import { loadSchedulerFile, validateScriptPath } from "./scheduler-store";
import { CHAT_EVENT_TYPES, type ActionSpec, type BashActionSpec, type ChatActionRun, type ChatEventAction, type ChatEventActionFile, type ChatEventActionInput, type ChatEventActionPatch, type ChatEventType, type HttpActionSpec, type NotificationActionSpec, type ScheduledActionSpec } from "./chat-event-action-types";

// ============================================================================
// Store for chat event actions (~/.omp/agent/chat-event-actions.json), the
// same shape/conventions as lib/scheduler-store.ts: tolerant load (corrupt
// files yield an empty list, malformed entries are dropped), atomic
// temp-file + rename writes, and a store error carrying a stable `code` the
// API routes surface for client localization.
// ============================================================================

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
/** Cap for lastRun.detail — mirrors the scheduler's OUTPUT_TAIL_MAX. */
export const ACTION_DETAIL_MAX = 4_096;

/** Error carrying a stable code (`chatActions.error.*` key) for the client. */
export class ChatEventActionStoreError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

export function getChatEventActionsPath(): string {
  return path.join(getAgentDir(), "chat-event-actions.json");
}

export function isValidActionId(id: string): boolean {
  return ID_RE.test(id);
}

/* ─────────────────────────── validation (shared by create/patch) ── */

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;
const BODY_CONTENT_TYPES = ["json", "xml", "text"] as const;

function validateEvents(events: unknown): ChatEventType[] {
  if (!Array.isArray(events) || events.length === 0) throw new ChatEventActionStoreError("events_required");
  const out: ChatEventType[] = [];
  for (const e of events) {
    if (typeof e !== "string" || !CHAT_EVENT_TYPES.includes(e as ChatEventType)) {
      throw new ChatEventActionStoreError("event_invalid");
    }
    if (!out.includes(e as ChatEventType)) out.push(e as ChatEventType);
  }
  return out;
}

function validateHttpSpec(spec: Record<string, unknown>): HttpActionSpec {
  // method defaults to GET: the modal always sends one; a bare url is a read.
  const method = typeof spec.method === "string" ? spec.method.toUpperCase() : "GET";
  if (!HTTP_METHODS.includes(method as (typeof HTTP_METHODS)[number])) {
    throw new ChatEventActionStoreError("method_invalid");
  }
  const url = typeof spec.url === "string" ? spec.url.trim() : "";
  if (!url) throw new ChatEventActionStoreError("url_required");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ChatEventActionStoreError("url_invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ChatEventActionStoreError("url_invalid");
  }
  const out: HttpActionSpec = { type: "http", method: method as HttpActionSpec["method"], url };
  if (typeof spec.body === "string" && spec.body) {
    out.body = spec.body;
    if (method === "POST" || method === "PUT") {
      const ctype = spec.bodyContentType;
      if (ctype !== undefined && !BODY_CONTENT_TYPES.includes(ctype as (typeof BODY_CONTENT_TYPES)[number])) {
        throw new ChatEventActionStoreError("body_content_type_invalid");
      }
      if (typeof ctype === "string") out.bodyContentType = ctype as HttpActionSpec["bodyContentType"];
      else out.bodyContentType = "json";
    }
  }
  if (typeof spec.headers === "string" && spec.headers.trim()) out.headers = spec.headers;
  return out;
}

function validateBashSpec(spec: Record<string, unknown>): BashActionSpec {
  const scriptPath = typeof spec.scriptPath === "string" ? spec.scriptPath.trim() : "";
  const scriptText = typeof spec.scriptText === "string" && spec.scriptText.trim() ? spec.scriptText : "";
  if (!scriptPath && !scriptText) throw new ChatEventActionStoreError("script_required");
  const out: BashActionSpec = { type: "bash" };
  if (scriptPath) {
    const check = validateScriptPath(scriptPath);
    if (!check.ok) throw new ChatEventActionStoreError(check.error ?? "script_required");
    out.scriptPath = check.path;
  }
  if (scriptText) out.scriptText = scriptText;
  return out;
}

function validateScheduledSpec(spec: Record<string, unknown>): ScheduledActionSpec {
  const schedulerId = typeof spec.schedulerId === "string" ? spec.schedulerId.trim() : "";
  if (!schedulerId) throw new ChatEventActionStoreError("scheduler_required");
  const exists = loadSchedulerFile().schedulers.some((s) => s.id === schedulerId);
  if (!exists) throw new ChatEventActionStoreError("unknown_scheduler");
  return { type: "scheduled", schedulerId };
}

function validateNotificationSpec(spec: Record<string, unknown>): NotificationActionSpec {
  const out: NotificationActionSpec = { type: "notification" };
  if (typeof spec.title === "string" && spec.title.trim()) out.title = spec.title.trim();
  if (typeof spec.message === "string" && spec.message.trim()) out.message = spec.message.trim();
  return out;
}

/** Validate an ActionSpec-shaped object; returns the normalized spec. */
export function validateActionSpec(spec: unknown): ActionSpec {
  if (typeof spec !== "object" || spec === null) throw new ChatEventActionStoreError("action_required");
  const s = spec as Record<string, unknown>;
  switch (s.type) {
    case "notification":
      return validateNotificationSpec(s);
    case "http":
      return validateHttpSpec(s);
    case "bash":
      return validateBashSpec(s);
    case "scheduled":
      return validateScheduledSpec(s);
    default:
      throw new ChatEventActionStoreError("action_type_invalid");
  }
}

/* ─────────────────────────── loading ─────────────────────────── */

const EMPTY_FILE: ChatEventActionFile = { version: 1, actions: [] };

/** Tolerant load (mirrors parseSchedulerFile): missing/corrupt input yields
 *  an empty file; malformed individual entries are dropped. */
export function parseChatEventActionFile(raw: string): ChatEventActionFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY_FILE };
  }
  if (typeof parsed !== "object" || parsed === null) return { ...EMPTY_FILE };
  const file = parsed as { actions?: unknown };
  if (!Array.isArray(file.actions)) return { ...EMPTY_FILE };
  const actions: ChatEventAction[] = [];
  for (const item of file.actions) {
    const action = normalizeAction(item);
    if (action) actions.push(action);
  }
  return { version: 1, actions };
}

function normalizeAction(item: unknown): ChatEventAction | null {
  if (typeof item !== "object" || item === null) return null;
  const a = item as Record<string, unknown>;
  if (typeof a.id !== "string" || !ID_RE.test(a.id)) return null;
  if (typeof a.name !== "string" || !a.name.trim()) return null;
  if (!Array.isArray(a.events) || a.events.length === 0) return null;
  const events: ChatEventType[] = [];
  for (const e of a.events) {
    if (typeof e === "string" && CHAT_EVENT_TYPES.includes(e as ChatEventType) && !events.includes(e as ChatEventType)) {
      events.push(e as ChatEventType);
    }
  }
  if (events.length === 0) return null;
  if (typeof a.action !== "object" || a.action === null) return null;
  const action = a.action as Record<string, unknown>;
  const type = action.type;
  if (type !== "notification" && type !== "http" && type !== "bash" && type !== "scheduled") return null;
  const createdAt = typeof a.createdAt === "string" ? a.createdAt : new Date().toISOString();
  const updatedAt = typeof a.updatedAt === "string" ? a.updatedAt : createdAt;
  const lastRun = normalizeRun(a.lastRun);
  return {
    id: a.id,
    name: a.name,
    events,
    enabled: typeof a.enabled === "boolean" ? a.enabled : true,
    action: { ...(action as object), type } as ActionSpec,
    createdAt,
    updatedAt,
    ...(lastRun ? { lastRun } : {}),
  };
}

function normalizeRun(item: unknown): ChatActionRun | null {
  if (typeof item !== "object" || item === null) return null;
  const r = item as Record<string, unknown>;
  if (typeof r.at !== "string" || typeof r.ok !== "boolean") return null;
  const out: ChatActionRun = { at: r.at, ok: r.ok };
  if (typeof r.detail === "string" && r.detail) out.detail = r.detail.slice(-ACTION_DETAIL_MAX);
  return out;
}

export function loadChatEventActionFile(): ChatEventActionFile {
  const file = getChatEventActionsPath();
  if (!existsSync(file)) return { ...EMPTY_FILE };
  try {
    return parseChatEventActionFile(readFileSync(file, "utf8"));
  } catch {
    return { ...EMPTY_FILE };
  }
}

/** Atomic persistence: temp file in the same directory, then rename. */
export function saveChatEventActionFile(file: ChatEventActionFile): void {
  const target = getChatEventActionsPath();
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), "utf8");
  renameSync(tmp, target);
  invalidateActionsForEventCache();
}

/* ─────────────────────────── mutations ─────────────────────────── */

export type { ChatEventActionInput, ChatEventActionPatch } from "./chat-event-action-types";

export function createChatEventAction(input: ChatEventActionInput): { file: ChatEventActionFile; action: ChatEventAction } {
  const name = input.name.trim();
  if (!name) throw new ChatEventActionStoreError("name_required");
  const events = validateEvents(input.events);
  const action = validateActionSpec(input.action);
  const now = new Date().toISOString();
  const file = loadChatEventActionFile();
  const entry: ChatEventAction = {
    id: `ca-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    events,
    enabled: input.enabled !== false,
    action,
    createdAt: now,
    updatedAt: now,
  };
  return { file: { version: 1, actions: [...file.actions, entry] }, action: entry };
}



export function patchChatEventAction(id: string, patch: ChatEventActionPatch): { file: ChatEventActionFile; action: ChatEventAction } {
  if (!isValidActionId(id)) throw new ChatEventActionStoreError("not_found");
  const file = loadChatEventActionFile();
  const idx = file.actions.findIndex((a) => a.id === id);
  if (idx < 0) throw new ChatEventActionStoreError("not_found");
  const prev = file.actions[idx];
  const name = patch.name !== undefined ? patch.name.trim() : prev.name;
  if (!name) throw new ChatEventActionStoreError("name_required");
  const events = patch.events !== undefined ? validateEvents(patch.events) : prev.events;
  const action = patch.action !== undefined ? validateActionSpec(patch.action) : prev.action;
  const entry: ChatEventAction = {
    ...prev,
    name,
    events,
    action,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    updatedAt: new Date().toISOString(),
  };
  const actions = [...file.actions];
  actions[idx] = entry;
  return { file: { version: 1, actions }, action: entry };
}

export function removeChatEventAction(id: string): ChatEventActionFile {
  if (!isValidActionId(id)) throw new ChatEventActionStoreError("not_found");
  const file = loadChatEventActionFile();
  const actions = file.actions.filter((a) => a.id !== id);
  if (actions.length === file.actions.length) throw new ChatEventActionStoreError("not_found");
  return { version: 1, actions };
}

export function getChatEventAction(id: string): ChatEventAction | null {
  if (!isValidActionId(id)) return null;
  return loadChatEventActionFile().actions.find((a) => a.id === id) ?? null;
}

export function listChatEventActions(): ChatEventAction[] {
  return loadChatEventActionFile().actions;
}

/** Set only lastRun (no-op-safe when the action is gone while a run was
 *  finishing). Never throws into the caller. */
export function recordActionRun(id: string, run: ChatActionRun): void {
  if (!isValidActionId(id)) return;
  const file = loadChatEventActionFile();
  const idx = file.actions.findIndex((a) => a.id === id);
  if (idx < 0) return;
  const actions = [...file.actions];
  const entry = { ...actions[idx], lastRun: { at: run.at, ok: run.ok, ...(run.detail ? { detail: run.detail.slice(-ACTION_DETAIL_MAX) } : {}) } };
  actions[idx] = entry;
  saveChatEventActionFile({ version: 1, actions });
}

/* ─────────────────────── event pre-filter + cache ─────────────────────── */

/**
 * Pre-filtered, cached view of the enabled actions bound to one event type.
 * Invalidated on every store mutation (any save), so a saved action is
 * visible from the very next event. The dispatcher calls this on every
 * frame-derived event, so it must stay cheap: the cache holds the parsed
 * file, and the per-type arrays are built once per invalidation.
 */
declare global {
  var __ompChatActionCache: { type: ChatEventType; actions: ChatEventAction[] }[] | null;
}

function invalidateActionsForEventCache(): void {
  globalThis.__ompChatActionCache = null;
}

export function loadActionsForEvent(type: ChatEventType): ChatEventAction[] {
  if (!CHAT_EVENT_TYPES.includes(type)) return [];
  let cache = globalThis.__ompChatActionCache;
  if (!cache) {
    const file = loadChatEventActionFile();
    cache = CHAT_EVENT_TYPES.map((t) => ({
      type: t,
      actions: file.actions.filter((a) => a.enabled && a.events.includes(t)),
    }));
    globalThis.__ompChatActionCache = cache;
  }
  const entry = cache.find((c) => c.type === type);
  return entry ? entry.actions : [];
}
