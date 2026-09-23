import { spawn, type ChildProcess } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { getAgentDir } from "./omp/paths";
import { repairedChildPath } from "./omp/omp-cli";
import { triggerManualRun } from "./scheduler-engine";
import { recordActionRun } from "./chat-event-action-store";
import { broadcastChatActionRun, broadcastChatEventAction } from "./chat-event-action-bus";
import type { ActionSpec, ChatActionRun, ChatEventAction } from "./chat-event-action-types";

// ============================================================================
// Action executors — one per ActionSpec type (http / bash / scheduled /
// notification). Each is fire-and-forget: the dispatcher never awaits the
// result, and every executor records its own lastRun (ok/detail). A single
// action's failure must never affect another action or the frame loop.
//
// Timeouts mirror the hook 30s-handler budget idea from the plan: 10s http,
// 60s bash (+ 5s kill grace, like the scheduler engine).
// ============================================================================

const HTTP_TIMEOUT_MS = 10_000;
const BASH_TIMEOUT_MS = 60_000;
const BASH_KILL_GRACE_MS = 5_000;
/** Cap for a detail string stored on lastRun. */
const DETAIL_MAX = 4_096;

export interface ChatEventPayload {
  sessionId: string;
  /** Session display name (best-effort; the notification defaults use it). */
  sessionName?: string;
  /** The assistant's most recent text reply in this session (best-effort;
   *  captured at message_end). Available to actions as $last_reply. */
  lastAssistantReply?: string;
  /** The text of the assistant's question (the `ask` tool's prompt) that
   *  triggered this event. Present only for the `question_asked` event.
   *  Available to actions as $question. */
  question?: string;
  /** Push a frame onto this session's own SSE stream. Returns the number of
   *  listeners that received it. Absent (or a no-op returning 0) when the
   *  session wrapper is gone — the running-stream broadcast is still
   *  attempted. */
  emitToSession?: (frame: Record<string, unknown>) => number;
}

export type Executor = (action: ChatEventAction, payload: ChatEventPayload) => Promise<void> | void;

function record(action: ChatEventAction, ok: boolean, detail?: string): void {
  const run: ChatActionRun = { at: new Date().toISOString(), ok, ...(detail ? { detail: detail.slice(-DETAIL_MAX) } : {}) };
  try {
    recordActionRun(action.id, run);
  } catch {
    // lastRun is cosmetic; never let a store error surface from an executor.
  }
  // Nudge open panels so the fresh lastRun renders without a reload. A
  // delivery failure (no browser attached) is harmless — the store has it.
  try {
    broadcastChatActionRun(action.id);
  } catch {
    /* bus gone */
  }
}

/* ─────────────────────────── event-data variables ─────────────────────────── */

/**
 * Substitute $event-data variables in an action field. Supported:
 * $session_name, $session_id, $last_reply, $question. Unknown $names are
 * left as-is (a typo in a body is user content, not an error). No variable
 * in the string -> the original is returned untouched (zero-copy fast path).
 */
export function interpolateEventVars(value: string, payload: ChatEventPayload): string {
  if (!value.includes("$")) return value;
  const vars: Record<string, string> = {
    session_name: payload.sessionName ?? "",
    session_id: payload.sessionId,
    last_reply: payload.lastAssistantReply ?? "",
    question: payload.question ?? "",
  };
  return value.replace(/\$([a-z_]+)/g, (whole, name: string) => (name in vars ? vars[name] : whole));
}
/* ─────────────────────────── http ─────────────────────────── */

/** Parse a user-supplied header block: "Name: value" per line. Blank and
 *  malformed lines are skipped; on duplicate keys the FIRST wins. */
export function parseHeaderLines(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (key in out) continue; // first wins on duplicate (case-insensitive)
    out[key] = value;
  }
  return out;
}

const CONTENT_TYPES = { json: "application/json", xml: "application/xml", text: "text/plain" } as const;

/**
 * Substitute $event-data variables in an HTTP request body. For JSON bodies
 * (the POST/PUT default) the template is parsed and variables are substituted
 * in string values only, so JSON.stringify re-escapes newlines, quotes and
 * backslashes coming from $last_reply/$question — a raw text substitution
 * would produce an invalid body. If the template is not valid JSON, the raw
 * substitution is applied (the body may not be JSON at all).
 */
function interpolateBody(body: string, contentType: keyof typeof CONTENT_TYPES, payload: ChatEventPayload): string {
  if (contentType !== "json") return interpolateEventVars(body, payload);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return interpolateEventVars(body, payload);
  }
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return interpolateEventVars(value, payload);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) out[key] = walk(val);
      return out;
    }
    return value;
  };
  return JSON.stringify(walk(parsed), null, 2);
}

async function executeHttp(action: ChatEventAction, payload: ChatEventPayload): Promise<void> {
  const spec = action.action;
  if (spec.type !== "http") return;
  try {
    const headers = parseHeaderLines(spec.headers ?? "");
    let body: string | undefined;
    const bodyContentType = spec.bodyContentType ?? "json";
    if (spec.body) {
      // $event-data variables ($session_name, $session_id, $last_reply,
      // $question) are substituted from the firing event's payload; JSON
      // bodies are re-serialized so substituted text stays valid JSON.
      body = interpolateBody(spec.body, bodyContentType, payload);
      if ((spec.method === "POST" || spec.method === "PUT") && !headers["content-type"]) {
        headers["Content-Type"] = CONTENT_TYPES[bodyContentType];
      }
    }
    const res = await fetch(spec.url, {
      method: spec.method,
      headers,
      ...(body !== undefined && spec.method !== "GET" && spec.method !== "HEAD" ? { body } : {}),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      redirect: "follow",
    });
    const tail = (await res.text().catch(() => "")).slice(-2_048);
    record(action, res.ok, `HTTP ${res.status}${tail ? ` — ${tail}` : ""}`);
  } catch (err) {
    const detail = err instanceof Error ? (err.name === "TimeoutError" ? `timeout after ${HTTP_TIMEOUT_MS / 1000}s` : err.message) : String(err);
    record(action, false, detail);
  }
}

/* ─────────────────────────── bash ─────────────────────────── */

function runBash(child: ChildProcess, action: ChatEventAction, cleanup: () => void): void {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, BASH_KILL_GRACE_MS).unref?.();
  }, BASH_TIMEOUT_MS);
  child.on("close", (code) => {
    clearTimeout(timer);
    const ok = code === 0 && !timedOut;
    record(action, ok, ok ? undefined : `exit ${code ?? 1}${timedOut ? " (timed out)" : ""}`);
    cleanup();
  });
}

function executeBash(action: ChatEventAction, payload: ChatEventPayload): void {
  const spec = action.action;
  if (spec.type !== "bash") return;
  void payload;
  let cleanup = () => {};
  const spawnChild = (cmd: string, args: string[], cwd: string) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, PATH: repairedChildPath(process.env.PATH) },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      cleanup();
      record(action, false, String(err instanceof Error ? err.message : err));
      return;
    }
    runBash(child, action, cleanup);
  };

  if (spec.scriptPath) {
    const shell = /\.(sh|bash|zsh)$/i.test(path.basename(spec.scriptPath)) ? "bash" : "exec";
    spawnChild(shell === "bash" ? "bash" : spec.scriptPath, shell === "bash" ? [spec.scriptPath] : [], path.dirname(spec.scriptPath));
  } else if (spec.scriptText) {
    // Inline text: write to a temp file under the agent dir, run via bash,
    // delete after. (bash -c would work too, but the file path keeps the
    // script's own relative references intact and matches the .sh behavior.)
    const dir = mkdtempSync(path.join(getAgentDir(), "chat-action-"));
    const file = path.join(dir, "action.sh");
    try {
      writeFileSync(file, `${spec.scriptText}\n`);
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      record(action, false, String(err instanceof Error ? err.message : err));
      return;
    }
    cleanup = () => rmSync(dir, { recursive: true, force: true });
    spawnChild("bash", [file], dir);
  } else {
    record(action, false, "no script");
  }
}

/* ─────────────────────────── scheduled ─────────────────────────── */

function executeScheduled(action: ChatEventAction, payload: ChatEventPayload): void {
  const spec = action.action;
  if (spec.type !== "scheduled") return;
  void payload;
  const result = triggerManualRun(spec.schedulerId);
  if (!result.ok) {
    // "already running" is a normal busy state, not an error — the run is
    // recorded with ok:false + a detail the panel can show, and the
    // scheduler's own history carries the actual outcome.
    record(action, false, result.error === "already_running" ? "scheduler busy" : result.error);
    return;
  }
  record(action, true, "started");
}

/* ─────────────────────────── notification ─────────────────────────── */

function executeNotification(action: ChatEventAction, payload: ChatEventPayload): void {
  const spec = action.action;
  if (spec.type !== "notification") return;
  // Defaults mirror the built-in completion notification (appShell.*): the
  // session's name as the title, a generic "task finished" body.
  const title = spec.title || payload.sessionName || "Session complete";
  const message = spec.message || "Task finished.";
  const frame = { type: "chat_event_action" as const, actionId: action.id, sessionId: payload.sessionId, title, message };
  let delivered = 0;
  if (payload.emitToSession) {
    try {
      delivered += payload.emitToSession(frame);
    } catch {
      // session stream gone — the running-stream broadcast still runs.
    }
  }
  delivered += broadcastChatEventAction(frame);
  record(action, delivered > 0, delivered > 0 ? undefined : "no browser attached");
}

/* ─────────────────────────── registry + test seam ─────────────────────────── */

const EXECUTORS: Record<ActionSpec["type"], Executor> = {
  notification: executeNotification,
  http: executeHttp,
  bash: executeBash,
  scheduled: executeScheduled,
};

export function executeChatAction(action: ChatEventAction, payload: ChatEventPayload): void {
  try {
    EXECUTORS[action.action.type]?.(action, payload);
  } catch (err) {
    // A throwing executor must not take down the frame loop or other actions.
    record(action, false, String(err instanceof Error ? err.message : err));
  }
}

/** Test seam: swap an executor (or the whole table) without touching the
 *  dispatcher. Pass null to restore the real table. */
export function __setActionExecutorsForTests(executors: Partial<Record<ActionSpec["type"], Executor>> | null): void {
  if (executors === null) {
    Object.assign(EXECUTORS, { notification: executeNotification, http: executeHttp, bash: executeBash, scheduled: executeScheduled });
    return;
  }
  for (const [k, v] of Object.entries(executors)) {
    EXECUTORS[k as ActionSpec["type"]] = v as Executor;
  }
}
