import { existsSync } from "fs";
import { homedir } from "os";
import { clearBackendErrors, recordBackendError, recentBackendErrors } from "./backend-errors";
import { validateAgentImages } from "./image-attachments";
import { invalidateModelsCache } from "./models-cache";
import { RpcCommandError, RpcCommandTimeoutError, type RpcFrame } from "./omp/rpc-process";
import { createRpcProcess, type RpcProcessLike } from "./omp/rust-rpc-process";
import { getAgentEnvOverrides } from "./omp/agent-env";
import { readNativeSettings } from "./omp/settings-config";
import { scanSessionInfo } from "./omp/session-files";
import { sanitizeSessionTitle } from "./session-title";
import { cacheSessionPath, invalidateSessionListCache, readSessionHeader, resolveSessionPath } from "./session-reader";
import { markShuttingDown, recordRunningSessions, RESUME_PROMPT, takeInterruptedSessions } from "./session-resume";
import { clearChatActionRunState, dispatchChatEvent, type ChatEventPayload } from "./chat-event-actions-dispatcher";
import { taskCompletedDiff } from "./todo-completion";
import { createMessageUpdateCoalescer } from "./message-update-coalescer";
import { samePath } from "./paths";
import { PRESET_FULL } from "./tool-presets";
import type {
  BashResultInfo,
  OmpModel,
  RpcAvailableSlashCommand,
  RpcSessionState,
  SessionStatsInfo,
  TodoPhase,
  WebSessionState,
} from "./pi-types";
import type { CrossSessionHostToolCall, ExitedRpcSession, ExtensionWidgetItem } from "./types";
import { isRecord } from "./type-guards";
import { parseSkillDiagnosticsSnapshot, type SkillDiagnosticsSnapshot } from "./skill-diagnostics";

// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type EventListener = (event: AgentEvent) => void;

interface CompactionResultLike {
  summary?: string;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  /** omp ≥17.4 reports the real post-compaction count when available. */
  tokensAfter?: number;
}

const IDLE_DESTROY_MS = 10 * 60 * 1000;
/**
 * How long a session may sit with **no web UI attached** before its omp child is
 * torn down. IDLE_DESTROY_MS (10min) is the backstop for a session that keeps
 * receiving traffic; this is the much faster path for "the user closed the tab
 * and walked away", so abandoned children don't hold a slot for 10 minutes.
 *
 * The floor is set by the *client*, not the server: when an SSE stream dies the
 * browser retries with capped backoff (`EVENT_STREAM_RETRY_MAX_MS` = 30s in
 * `hooks/useAgentSession-stream.ts`), and a backgrounded tab clamps its timers
 * to ~1/min. A window anywhere near 60s therefore races the reconnect and turns
 * a returning tab into a 409 "Session is not managed by omp-web" plus a cold
 * respawn. 120s keeps ~2x the retry ceiling and still reclaims 5x faster than
 * the idle backstop. Set `OMP_WEB_DISCONNECT_DESTROY_MS=0` to disable reaping
 * and fall back to IDLE_DESTROY_MS alone.
 */
const DISCONNECT_DESTROY_MS = process.env.OMP_WEB_DISCONNECT_DESTROY_MS !== undefined
  ? Math.max(0, Number(process.env.OMP_WEB_DISCONNECT_DESTROY_MS) || 0)
  : 120_000;
const READY_TIMEOUT_MS = 120_000;
const MCP_LIST_TIMEOUT_MS = 15_000;
/** State reads drive UI reconciliation and must never leave a stale spinner
 * waiting on a child that has stopped responding. */
const GET_STATE_TIMEOUT_MS = 5_000;
const SET_MODEL_TIMEOUT_MS = 30_000;
/** Prompt execution continues over frames; this cap applies only to accepting
 * the prompt command, not to model generation. */
const PROMPT_ACK_TIMEOUT_MS = 30_000;
/** Title generation is an LLM call on omp's side. */
const GENERATE_TITLE_TIMEOUT_MS = 60_000;
const RENAME_POLL_INTERVAL_MS = 500;
const RENAME_POLL_TIMEOUT_MS = 20_000;
const AWAITING_AGENT_START_TIMEOUT_MS = 10_000;

// ── RPC 健康信号 ──────────────────────────────────────────────────────────
// 记录 omp 子进程异常退出与"会话分裂"（--resume 后 omp 返回了不同的会话，
// 说明会话文件正被其他 omp/ompweb 实例占用——旧实例扰乱新实例的典型症状）。
// /api/diagnostics 与顶栏健康指示据此反映"消息能否真正发出"。
// 实现收编在 lib/backend-errors.ts（Phase 1）：RPC 失败只是后端错误的一种
// kind，host 不可用/崩溃/session 扫描失败同样入环，App 级横幅据此可见。
export function recordRpcFailure(detail: string): void {
  recordBackendError("rpc_failure", detail);
}

/** 最近 windowMs 内的 RPC 失败（默认 60s，供健康指示使用）。 */
export function recentRpcFailures(windowMs = 60_000): Array<{ at: number; detail: string }> {
  return recentBackendErrors(windowMs, "rpc_failure");
}

/** Clear failures after an explicit recovery action succeeded. */
export function clearRpcFailures(): void {
  clearBackendErrors();
}

const RESTARTING_MESSAGE = "This session is restarting — retry in a moment.";
const BASH_EXCLUDE_MESSAGE =
  "omp cannot run a shell command with its output excluded from the model context (`!!`): the RPC bash command has no exclusion option, so the output would silently enter the context anyway. Run it with a single `!` to share the output with the model, or use a terminal outside omp web.";

/**
 * Failure raised by omp-web itself (not by omp) carrying a stable snake_case
 * code. API routes forward `{ error, code }` so the client dictionary can
 * localize it via `errors.<code>` while unknown codes fall back to the text.
 */
export class WebRpcError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "WebRpcError";
    this.code = code;
  }
}

// Extension UI methods that stay pending until the client answers (replayed to
// newly-attached SSE listeners so dialogs survive reconnects).
const PENDING_UI_METHODS = new Set(["select", "confirm", "input", "editor", "ask", "open_url"]);

/** Reads `.goal.status` from a goal_updated frame or a `goal` command reply,
 *  runtime-narrowing the wire shape (external data). */
function readGoalStatus(source: unknown): string | null {
  if (!source || typeof source !== "object" || !("goal" in source)) return null;
  const goal = source.goal;
  if (!goal || typeof goal !== "object" || !("status" in goal)) return null;
  return typeof goal.status === "string" ? goal.status : null;
}

/** Shape check for an ask-dialog `answers` payload; omp validates the content. */
function isAskAnswers(value: unknown): boolean {
  return Array.isArray(value) && value.every((answer: unknown) =>
    isRecord(answer)
    && typeof answer.id === "string"
    && Array.isArray(answer.selectedOptions)
    && answer.selectedOptions.every((option: unknown) => typeof option === "string")
    && (answer.customInput === undefined || typeof answer.customInput === "string"));
}

// Commands forwarded to omp verbatim (request shape already matches rpc-types).
const PASSTHROUGH_COMMANDS = new Set([
  "abort",
  "abort_and_prompt",
  "set_thinking_level",
  "cycle_thinking_level",
  "cycle_model",
  "get_available_models",
  "set_auto_compaction",
  "set_auto_retry",
  "abort_retry",
  "abort_bash",
  "set_todos",
  "set_steering_mode",
  "set_follow_up_mode",
  "set_interrupt_mode",
  "get_branch_messages",
  "get_messages",
  "get_messages_page",
  "export_html",
  "handoff",
  "get_subagents",
  "get_subagent_messages",
  "set_subagent_subscription",
  "get_login_providers",
  // Ghost-text prediction passthrough. NOTE: no public omp release
  // (verified through v18.3.5, 2026-09-27) registers these RPC commands —
  // the word-completion engine is in-process in the TUI and exposed to Node
  // hosts via the TextPredictor N-API binding instead. These entries are kept
  // for the upstream fork's patched omp build; stock omp answers "Unknown
  // command" and the client degrades to no ghost text. See
  // lib/word-prediction.ts for the full provenance note.
  "predict_word",
  "predict_word_feedback",
  "btw",
  "btw_cancel",
  "get_btw_history",
  // Goal mode (omp ≥18.4.11) and subagent controls (omp ≥18.4.9): raw
  // commands the composer bar / subagent hub send; omp answers, the
  // wrapper only forwards.
  "goal",
  "cancel_subagent",
  "steer_subagent",
]);

// Outlasts omp's cold prediction-daemon start (up to 3 × 30 s start rounds plus a
// 30 s first completion), so omp's answer or error decides; a wedged daemon still
// cannot pin the request forever.
const PREDICT_WORD_TIMEOUT_MS = 125_000;

// pi-web commands with no omp RPC equivalent. The UI tolerates these failing.
const UNSUPPORTED_COMMANDS: Record<string, string> = {
  navigate_tree: "Branch navigation is not supported over the omp RPC protocol",
  clear_queue: "Recalling queued messages is not supported over the omp RPC protocol",
  get_tools: "Per-session tool listing is not supported over the omp RPC protocol",
  set_tools: "Changing tools on a running session is not supported over the omp RPC protocol; tool presets apply to new sessions",
  extension_ui_input: "Extension custom UI is not supported over the omp RPC protocol",
};

// omp aliases "find"->"glob" and has no "ls" tool; the web UI presets still use
// the pi names (lib/tool-presets.ts), so translate before building --tools.
const TOOL_NAME_ALIASES: Record<string, string> = { find: "glob", search: "grep" };
const DROPPED_TOOL_NAMES = new Set(["ls"]);

/** Translate pi-web preset tool names into omp builtin tool names. */
export function mapPresetToolNames(toolNames: string[]): string[] {
  const out: string[] = [];
  for (const raw of toolNames) {
    const lower = raw.toLowerCase();
    if (DROPPED_TOOL_NAMES.has(lower)) continue;
    const mapped = TOOL_NAME_ALIASES[lower] ?? lower;
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}

const FULL_PRESET_KEY = [...PRESET_FULL].map((n) => n.toLowerCase()).sort().join(",");

/** Extra CLI args for spawning `omp --mode rpc-ui` for a session. */
export function buildSessionSpawnArgs(sessionFile: string, toolNames?: string[], advisor = false): string[] {
  const args: string[] = [];
  if (sessionFile) {
    // An absolute path (or anything containing "/") resolves deterministically:
    // omp's createSessionManager opens it directly via SessionManager.open
    // without any interactive resume/fork prompts (main.ts resume handling).
    args.push("--resume", sessionFile);
  } else if (toolNames !== undefined) {
    const presetKey = toolNames.map((n) => n.toLowerCase()).sort().join(",");
    if (toolNames.length === 0) {
      args.push("--no-tools");
    } else if (presetKey === FULL_PRESET_KEY) {
      // "Full" means everything: leave omp's complete default toolset intact
      // rather than restricting it to the (much smaller) pi preset list.
    } else {
      const mapped = mapPresetToolNames(toolNames);
      if (mapped.length > 0) args.push("--tools", mapped.join(","));
    }
  }
  if (advisor) args.push("--advisor");
  return args;
}

function toImageContents(value: unknown): Array<{ type: "image"; data: string; mimeType: string }> | undefined {
  const images = value as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
  return images?.length ? images : undefined;
}

/**
 * Pick a spawn cwd that actually exists. A session records the directory it was
 * created in, but that directory may have been deleted since: spawn() would
 * fail with ENOENT and `omp --cwd <missing>` throws in setProjectDir. omp's own
 * resume path skips the chdir when the recorded project dir is gone and keeps
 * the launch cwd (main.ts), so hand it a live directory and let it decide.
 */
export function resolveSpawnCwd(recordedCwd?: string | null): string {
  return resolveSpawnCwdResult(recordedCwd).cwd;
}

/**
 * Resolve a spawn cwd and report whether it differs from the session's recorded
 * directory. Callers that surface a UI (the SSE resume paths) use the result to
 * emit a notice so the user knows the agent is running somewhere other than the
 * directory the sidebar/header still advertises — a silent wrong-tree fallback
 * would let file tool calls edit an unexpected repo with no signal.
 */
export function resolveSpawnCwdResult(recordedCwd?: string | null): { cwd: string; fellBack: boolean } {
  if (recordedCwd && existsSync(recordedCwd)) return { cwd: recordedCwd, fellBack: false };
  try {
    const serverCwd = process.cwd();
    if (serverCwd && existsSync(serverCwd)) return { cwd: serverCwd, fellBack: true };
  } catch {
    // process.cwd() itself throws when the server's own cwd was removed.
  }
  return { cwd: homedir(), fellBack: true };
}

/** omp's CompactionResult historically omitted any post-compaction token
 * count; approximate it from the summary so the compaction banner can show
 * savings instead of "→ 0 tokens". Newer omp reports a real `tokensAfter` —
 * prefer it when present. */
function patchEstimatedTokensAfter(result: unknown): void {
  if (!result || typeof result !== "object") return;
  const compaction = result as CompactionResultLike;
  if (compaction.estimatedTokensAfter === undefined) {
    // Prefer omp ≥17.4's real post-compaction count; fall back to the
    // summary-length estimate for older builds.
    const rawTokensAfter = typeof compaction.tokensAfter === "number"
      ? Math.max(0, compaction.tokensAfter)
      : (compaction.summary?.length ?? 0) / 4;
    compaction.estimatedTokensAfter = Math.round(rawTokensAfter);
  }
}

// ============================================================================
// AgentSessionWrapper
// Wraps one spawned `omp --mode rpc-ui` process with the interface the rest of
// the app expects (same command surface pi-web's in-process wrapper offered).
// ============================================================================

function titleFromResult(result: unknown): string | null {
  const value = typeof result === "string" ? result : isRecord(result) ? (result.title ?? result.name ?? result.sessionName) : null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

interface IdentityChangeOptions {
  /** The old id still names this wrapper (session moved files, not switched). */
  keepOldId?: boolean;
}

export class AgentSessionWrapper {
  private listeners: EventListener[] = [];
  private pendingUiRequests = new Map<string, AgentEvent>();
  private uiExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private extensionStatuses = new Map<string, string>();
  private extensionWidgets = new Map<string, ExtensionWidgetItem>();
  private promptRunning = false;
  /** In-flight prompt acks keep reconciliation from clearing a new turn. */
  private promptDispatchPendingCount = 0;
  /** OMP can acknowledge just before emitting agent_start. */
  private awaitingAgentStart = false;
  private awaitingAgentStartDeadline = 0;
  /** A non-terminal agent_end announces an async continuation (e.g. a
   *  backgrounded bash job): the turn resumes with a later agent_start —
   *  sometimes minutes later. The flag stays set until that continuation's
   *  turn ends terminally (or the session is aborted/restarted/destroyed),
   *  so state reconciliation does not clear promptRunning while the job is
   *  pending and clients keep their SSE stream attached. */
  private continuationPending = false;
  /** True while a terminal agent_end from an interrupted turn is still
   *  incoming: abort / abort_and_prompt ends the current turn, but that end
   *  is not a completion — conversation_interrupted already fired from the
   *  command. Consumed by the interrupted turn's terminal agent_end so it
   *  does not dispatch conversation_completed; cleared on the next
   *  agent_start so a no-op abort (no active turn) cannot swallow the next
   *  real run's completion. */
  private _interruptEndPending = false;
  /** True while the current turn is a resume of an async continuation: it
   *  started right after a non-terminal agent_end (e.g. a backgrounded bash
   *  job finished and omp injected the result). Such a turn is not a
   *  user-prompt completion, so its terminal agent_end does not fire
   *  conversation_completed. */
  private _continuationRun = false;
  /** A terminal agent_end completed a user-prompted turn; the completion
   *  dispatch waits one frame for the `prompt_result` that follows it (omp
   *  emits both, the result via setImmediate) so the settle flag decides
   *  when `conversation_completed` fires. */
  private _completionPending = false;
  /** The prompt did not settle (`prompt_result.sessionSettled:false`, omp
   *  >= 18.5): background work (async subagents, jobs, deliveries) can
   *  still wake the session, so `conversation_completed` is held until the
   *  `session_settled` frame — or, if that never arrives, the next
   *  agent_start, so the event fires late but is never lost. */
  private _completionDeferred = false;
  /** Last goal status seen from the child (goal_updated frames and `goal`
   *  command replies). Drives whether a pause/drop must also stop a running
   *  goal-driven turn. */
  private _goalStatus: string | null = null;
  /** True while the active run was started by a host (web) prompt; false for
   *  child-initiated runs (goal continuation, async wake). A host goal
   *  pause/drop interrupts only non-host runs — never the user's own prompt. */
  private _hostRun = false;
  private bashRunning = false;
  private streaming = false;
  private compacting = false;
  private fastModeEnabled = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Lazily-armed deadline for tearing down a session nobody is watching. */
  private reapTimer: ReturnType<typeof setTimeout> | null = null;
  private reapDeadline = 0;
  private lastActivityAt = 0;
  /** In-flight `send()` calls: the reaper must never dispose the child out from
   * under a command that is still awaiting its response. */
  private pendingCommands = 0;
  /** The start handshake (ready + protocol negotiation + get_state) is in flight. */
  private handshaking = false;
  private readonly disconnectDestroyMs: number;
  private onDestroyCallback: (() => void) | null = null;
  private onIdentityChangeCallback: ((oldId: string, newId: string, options?: IdentityChangeOptions) => void) | null = null;
  /** omp reported a `session-persistence` notice: its next identity change is
   * the same conversation moving to a sibling file, not a session switch. */
  private sessionMovePending = false;
  private unsubscribeFrames: (() => void) | null = null;
  private initPromise: Promise<void> | null = null;
  private restarting = false;
  private mcpListWaiter: { resolve: (text: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private _alive = true;
  /** Host tools the web UI registered via set_host_tools (agent-callable). */
  private hostToolNames: Set<string> = new Set();
  /** host_tool_call ids awaiting a host_tool_result from the browser. */
  private pendingHostTools: Map<string, AgentEvent> = new Map();
  /** URI schemes the web UI registered via set_host_uri_schemes. */
  private hostUriSchemes: Map<string, { writable?: boolean }> = new Map();
  /** host_uri_request ids awaiting a host_uri_result from the browser. */
  private pendingHostUris: Map<string, AgentEvent> = new Map();
  /** Last observed `get_state.todoPhases` snapshot — the baseline for the
   * `task_completed` diff (a todo tool call transitions tasks; the next
   * snapshot shows which became completed). */
  private _todoPhases: TodoPhase[] | null = null;
  /** Resolves once an in-flight destroyAndWait finishes; null when idle. Read
   * by startRpcSession so a replacement spawn awaits the old child's exit. */
  destroyPromise: Promise<void> | null = null;
  private _sessionId = "";
  private _sessionFile = "";
  private _sessionName: string | undefined;
  /** Most recent assistant text reply (captured at message_end) — fed to
   *  chat event actions as the $last_reply variable. */
  private _lastAssistantReply: string | null = null;
  private proc: RpcProcessLike;
  /** Process whose exit is expected because reload/restart is deliberately
   *  disposing it — its exit must not be recorded as a crash. */
  private expectedExitProc: RpcProcessLike | null = null;
  readonly cwd: string;
  /** Whether the child was spawned with --advisor. The flag is spawn-time
   * only (no runtime RPC toggles it), so applying a changed advisor setting
   * means replacing an idle child on the next startRpcSession call. */
  readonly advisorSpawned: boolean;
  /** The cwd recorded in the session file header; null for brand-new sessions
   * or when the header lacks one. Used to detect a spawn fallback so a notice
   * can warn the user the agent is running in a different directory. */
  private readonly recordedCwd: string | null;

  // Plain field assignments (not TS parameter properties) keep this module
  // runnable under Node's strip-only TypeScript mode for probes/tests.
  constructor(
    proc: RpcProcessLike,
    cwd: string,
    recordedCwd?: string | null,
    advisorSpawned = false,
    expectedSessionId = "",
    /** Test seam: the real value is DISCONNECT_DESTROY_MS (120s), far too long
     *  for a unit test. 0 disables reaping for that wrapper. */
    disconnectDestroyMs: number = DISCONNECT_DESTROY_MS,
  ) {
    this.proc = proc;
    this.cwd = cwd;
    this.recordedCwd = recordedCwd ?? null;
    this.advisorSpawned = advisorSpawned;
    this._sessionId = expectedSessionId;
    this.disconnectDestroyMs = disconnectDestroyMs;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  get sessionFile(): string {
    return this._sessionFile;
  }

  isAlive(): boolean {
    return this._alive && this.proc.isAlive;
  }

  isRunning(): boolean {
    return this.isAlive() && (this.promptRunning || this.streaming || this.compacting || this.bashRunning);
  }

  /** A web UI (SSE stream) is currently attached to this session. */
  hasSubscribers(): boolean {
    return this.listeners.length > 0;
  }

  /**
   * Any real use of the session: an attached UI, a command from an API route, or
   * a frame from the child. `resetIdleTimer()` is the single choke point for all
   * three (start(), handleFrame(), send()), so driving reaping from here means
   * the deadline can never drift away from what the session is actually doing.
   *
   * Deliberately does NOT touch a timer: only the *deadline* moves, and
   * `armReap` keeps at most one timer alive, so a 100fps token stream costs a
   * timestamp write instead of clearTimeout/setTimeout churn.
   */
  private noteActivity(): void {
    this.lastActivityAt = Date.now();
    this.reapDeadline = this.lastActivityAt + this.disconnectDestroyMs;
    this.armReap();
  }

  private armReap(): void {
    if (this.reapTimer || this.disconnectDestroyMs <= 0) return;
    if (this.hasSubscribers() || !this.isAlive()) return;
    this.reapTimer = setTimeout(() => {
      this.reapTimer = null;
      this.reapIfDisconnected();
    }, Math.max(0, this.reapDeadline - Date.now()));
    // Never pin the event loop for a cleanup deadline (cf. the MCP waiter and
    // lib/session-resume.ts): an unref'd reap must not delay process exit.
    this.reapTimer.unref?.();
  }

  /**
   * Tear the child down only when nobody can observe the loss. Every condition
   * here is a hard invariant, not a heuristic:
   *  - a subscriber means an open HTTP 200 stream that `destroy()` would leave
   *    half-open (the route holds its own detach + heartbeat), so the run would
   *    vanish silently and the tab would only notice via a later 409;
   *  - isRunning() covers an in-flight turn that no listener is watching;
   *  - handshaking covers a spawn that has not finished its startup handshake;
   *  - pendingCommands covers a route command (predict_word, mcp list, export)
   *    whose response the child still owes us;
   *  - the deadline check absorbs activity that landed while this fired.
   * Anything else keeps the session and re-arms for the remaining window.
   */
  private reapIfDisconnected(): void {
    if (!this.isAlive() || this.hasSubscribers() || this.isRunning()
      || this.handshaking || this.pendingCommands > 0) {
      this.armReap();
      return;
    }
    if (Date.now() < this.reapDeadline) {
      this.reapDeadline = this.lastActivityAt + this.disconnectDestroyMs;
      this.armReap();
      return;
    }
    this.destroy();
  }

  hasActiveTurn(): boolean {
    return this.isAlive() && (this.promptRunning || this.streaming);
  }

  start(): void {
    this.unsubscribeFrames = this.proc.onFrame((frame) => this.handleFrame(frame));
    this.resetIdleTimer();
    notifyRunningChange();
  }

  /** Resolves once the child announced readiness and identity is known. */
  waitUntilReady(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.initialize();
    return this.initPromise;
  }

  private async initialize(): Promise<void> {
    // READY_TIMEOUT_MS and the reap window are the same order of magnitude, so
    // the handshake itself counts as in-flight work: a child that is slow to
    // announce itself must be torn down by its own startup timeout (which
    // reports a real error), never by the reaper.
    this.handshaking = true;
    try {
      const ready = await this.proc.waitReady(READY_TIMEOUT_MS);
      await this.proc.negotiateProtocol(ready);
      // Subscribe to subagent lifecycle/progress/event frames so the UI can show
      // a live subagent roster. Older omp builds may not know the command —
      // degrade silently (the UI falls back to no subagent info).
      await this.proc.sendCommand({ type: "set_subagent_subscription", level: "events" }).catch(() => {});
      // Opt into omp's all-questions ask dialog; older omp rejects the command
      // and keeps the per-question select/editor fallback.
      // Bounded like get_state so a child that never answers cannot stall startup.
      await this.proc.sendCommand({ type: "set_ask_dialog", enabled: true }, GET_STATE_TIMEOUT_MS).catch(() => {});
      const state = await this.getStateWithTimeout();
      this.applyIdentity(state);
      // Warn when the spawn cwd differs from the session's recorded directory.
      // This happens when the recorded cwd was deleted (removed worktree, moved
      // repo, different machine): resolveSpawnCwd silently substituted a live
      // directory so omp can spawn, but without a notice the user would see the
      // sidebar/header still advertise the (gone) recorded path while file tool
      // calls operate on a different tree.
      if (this.recordedCwd && this.recordedCwd !== this.cwd) {
        this.emit({
          type: "notice",
          level: "warning",
          message: `This session's working directory no longer exists; the agent is running in ${this.cwd}.`,
        });
      }
    } finally {
      this.handshaking = false;
      // The handshake is real activity, so the reap clock restarts from here
      // rather than from spawn (a slow start must not eat the whole window).
      this.noteActivity();
    }
  }

  private applyIdentity(state: RpcSessionState): void {
    const oldId = this._sessionId;
    this._sessionId = state.sessionId;
    this._sessionFile = state.sessionFile ?? "";
    // omp's get_state carries no sessionName; keep whatever we already know.
    if (state.sessionName) this._sessionName = state.sessionName;
    this.streaming = state.isStreaming;
    this.compacting = state.isCompacting;
    this.fastModeEnabled = state.fastModeEnabled ?? state.fastMode ?? this.fastModeEnabled;
    if (this._sessionFile) cacheSessionPath(this._sessionId, this._sessionFile);
    // omp >= 18.5 moves a session it does not own onto a sibling file on its
    // first write (`session-persistence` notice). The conversation continues,
    // so stream/run state is kept and only the registry key changes; the old
    // id stays routable (other tabs still address it).
    if (this.sessionMovePending && oldId && this._sessionId !== oldId) {
      this.sessionMovePending = false;
      this.onIdentityChangeCallback?.(oldId, this._sessionId, { keepOldId: true });
      invalidateSessionListCache();
    }
  }

  /** Whether omp answered `generate_title` with "Unknown command" (cached per child). */
  private generateTitleUnsupported = false;

  /**
   * Ask omp to generate a title for this session with its own title generator.
   * Prefers the native `generate_title` RPC command and falls back to the
   * argument-less `/rename` slash command. Returns null when omp cannot do
   * either right now (older omp, or the session is mid-run, where `/rename`
   * would be queued as a prompt).
   */
  async generateTitle(): Promise<string | null> {
    if (this.restarting) throw new WebRpcError(RESTARTING_MESSAGE, "session_restarting");
    if (!this.isAlive()) throw new Error("Session is no longer running");
    if (!this.generateTitleUnsupported) {
      try {
        const result = await this.proc.sendCommand<unknown>({ type: "generate_title" }, GENERATE_TITLE_TIMEOUT_MS);
        const title = titleFromResult(result) ?? (await this.readSessionName());
        if (title) this.adoptSessionName(title);
        return title;
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("Unknown command"))) throw error;
        this.generateTitleUnsupported = true;
      }
    }
    // `/rename` without arguments generates a title (omp >= 18.6). It is a
    // prompt, so it must never be sent while a run is in flight.
    if (this.isRunning()) return null;
    const before = (await this.readSessionName()) ?? "";
    await this.send({ type: "prompt", message: "/rename" });
    const deadline = Date.now() + RENAME_POLL_TIMEOUT_MS;
    let title = await this.readSessionName();
    while (!(title && title !== before) && Date.now() < deadline && this.isAlive()) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, RENAME_POLL_INTERVAL_MS);
      await promise;
      title = await this.readSessionName();
    }
    if (title) this.adoptSessionName(title);
    return title;
  }

  private async readSessionName(): Promise<string | null> {
    const state = await this.getStateWithTimeout();
    const name = typeof state.sessionName === "string" ? state.sessionName.trim() : "";
    // get_state on this omp build carries no sessionName; the frame-cached
    // title (updated by `session_info_update`) is the local source of truth.
    return name || (this._sessionName?.trim() || null);
  }

  private adoptSessionName(title: string): void {
    this._sessionName = title;
    invalidateSessionListCache();
    notifyRunningChange({ refreshSessionList: true });
  }

  /** Re-read identity after omp reported that it moved this session to a new file. */
  private async followSessionMove(): Promise<void> {
    this.sessionMovePending = true;
    try {
      const state = await this.getStateWithTimeout();
      if (this._alive) this.applyIdentity(state);
    } catch {
      // The next get_state-driven refresh still applies the pending move.
    } finally {
      // A persistence warning that is not a move changes no identity; do not
      // let it mask a later genuine session switch.
      if (this.sessionMovePending && this._alive) this.sessionMovePending = false;
      notifyRunningChange({ refreshSessionList: true });
    }
  }

  handleProcessExit(
    { code, signal, stderrTail }: { code: number | null; signal: NodeJS.Signals | null; stderrTail: string },
    sourceProc: RpcProcessLike = this.proc,
  ): void {
    // A restart disposes the old child on purpose — not a crash.
    if (!this._alive || sourceProc === this.expectedExitProc) return;
    const detail = (stderrTail.trim().split("\n").pop() ?? "").slice(-500);
    const status = signal ? `signal ${signal}` : `code ${code ?? "null"}`;
    // RustRpcProcess synthesizes this tail when the ompweb-host process itself
    // died (vs the supervised omp child): record the specific kind so the
    // diagnostics panel can name "host crash" instead of a generic RPC failure.
    if (stderrTail.includes("ompweb-host disconnected")) {
      recordBackendError("host_crash", `ompweb-host exited${detail ? `: ${detail}` : ""}`);
    }
    recordRpcFailure(`omp process exited unexpectedly (${status})${detail ? `: ${detail}` : ""}`);
    // Recorded before destroy(): its running-change broadcast must carry the
    // record so sidebars that missed the notice below still see the exit.
    if (this._sessionId) {
      getExitedMap().set(this._sessionId, { id: this._sessionId, cwd: this.cwd, at: Date.now(), code, signal, detail });
    }
    this.emit({
      type: "notice",
      level: "error",
      message: `The omp process for this session exited unexpectedly (${status})${detail ? `: ${detail}` : "."}`,
    });
    // Terminal agent_end so a client mid-stream stops spinning immediately
    // instead of waiting for the reconcile poll.
    if (this.streaming || this.promptRunning) this.emit({ type: "agent_end", isTerminal: true, messages: [] });
    this.destroy();
  }

  private handleFrame(frame: RpcFrame): void {
    this.resetIdleTimer();
    const event = frame as AgentEvent;
    if (event.type === "goal_updated") {
      this._goalStatus = readGoalStatus(event);
    }
    let refreshSessionList = false;

    switch (event.type) {
      case "command_output": {
        // `/mcp list` is a local OMP command. Capture its authoritative text for
        // Settings instead of adding an invisible command to the chat stream.
        const waiter = this.mcpListWaiter;
        if (waiter && typeof event.text === "string") {
          clearTimeout(waiter.timer);
          this.mcpListWaiter = null;
          waiter.resolve(event.text);
          notifyRunningChange();
          return;
        }
        break;
      }
      case "agent_start":
        // Record the run's origin before promptRunning is set: a goal wake or
        // an async resume starts with no host prompt awaiting its start.
        this._hostRun = this.awaitingAgentStart || this.promptDispatchPendingCount > 0;
        this.promptRunning = true;
        this.streaming = true;
        this.awaitingAgentStart = false;
        this.awaitingAgentStartDeadline = 0;
        // A turn that resumes an async continuation (the previous agent_end
        // was non-terminal, e.g. a background job just finished) is not a
        // fresh user-prompt completion.
        this._continuationRun = this.continuationPending;
        this.continuationPending = false;
        // A completion still held back from the previous run fires now
        // rather than being dropped: its `session_settled` never arrived.
        if (this._completionPending || this._completionDeferred) {
          this._completionPending = false;
          this._completionDeferred = false;
          dispatchChatEvent("conversation_completed", this.chatEventPayload({ type: "session_settled", settled: true }));
        }
        // A new run starting means the interrupted turn's end has either
        // been consumed already or was a no-op abort (nothing to interrupt).
        this._interruptEndPending = false;
        // The session file can appear just after the prompt acknowledgement.
        // Invalidate and signal the sidebar now rather than waiting for the
        // agent's first reply or terminal event.
        invalidateSessionListCache();
        refreshSessionList = true;
        // If the file is not on disk yet, the sidebar refresh above may walk
        // the sessions dir before it exists — and the mtime-keyed walk cache
        // then stays stale (NTFS does not bump the sessions-root mtime for
        // files added inside a project subdirectory), hiding the running
        // session from the list until the next invalidation (agent_end).
        // Re-signal once the file actually lands.
        if (this._sessionFile && !existsSync(this._sessionFile)) {
          this.signalWhenSessionFileAppears();
        }
        // Chat event action: user_prompt_sent (one per submitted prompt).
        dispatchChatEvent("user_prompt_sent", this.chatEventPayload());
        break;
      case "agent_end":
        if (event.isTerminal !== false) {
          this.streaming = false;
          this.promptRunning = false;
          this.awaitingAgentStart = false;
          this.awaitingAgentStartDeadline = 0;
          this.continuationPending = false;
          invalidateSessionListCache();
          clearChatActionRunState(this._sessionId);
          // A finished run's todo baseline is stale for the next prompt.
          this._todoPhases = null;
          // An interrupted turn also ends with a terminal agent_end (probe:
          // stopReason null — indistinguishable from a real completion), but
          // it is not a completion: conversation_interrupted already fired
          // from the abort command. Skip the completion dispatch for it.
          const wasInterrupted = this._interruptEndPending;
          this._interruptEndPending = false;
          // A resume turn (after a background job finishes) closes the job,
          // not the conversation — no conversation_completed for it.
          const wasContinuation = this._continuationRun;
          this._continuationRun = false;
          if (!wasInterrupted && !wasContinuation) {
            // The decision moves to the `prompt_result` frame that follows
            // (next tick): it carries whether the session has settled.
            this._completionPending = true;
          }
        } else {
          // The turn is paused for an async continuation (e.g. a
          // backgrounded bash job); it resumes with a later agent_start.
          this.continuationPending = true;
        }
        break;
      case "prompt_result":
        // Terminal per-prompt outcome (omp >= 18.3.1; also sent for
        // local-only slash commands with agentInvoked:false). For agent
        // runs this decides the completion held at agent_end:
        // `sessionSettled:false` (omp >= 18.5) means background work can
        // still wake the session, so the dispatch waits for the
        // `session_settled` frame instead.
        if (event.agentInvoked === true) {
          const wasPending = this._completionPending;
          this._completionPending = false;
          if (wasPending && event.status !== "aborted") {
            if (event.sessionSettled === false) this._completionDeferred = true;
            // Chat event action: conversation_completed (the same signal the
            // built-in completion notification uses).
            else dispatchChatEvent("conversation_completed", this.chatEventPayload({ type: "prompt_result", settled: true }));
          }
        }
        // Local-only prompt (builtin/extension slash command) — no agent run.
        this.promptRunning = false;
        this.awaitingAgentStart = false;
        this.awaitingAgentStartDeadline = 0;
        break;
      case "session_settled":
        // The session went quiet: nothing can wake it anymore (omp >= 18.5).
        // Releases a completion held back by an unsettled prompt_result.
        if (this._completionDeferred) {
          this._completionDeferred = false;
          dispatchChatEvent("conversation_completed", this.chatEventPayload({ type: "session_settled", settled: true }));
        }
        break;
      case "auto_compaction_start":
        this.compacting = true;
        break;
      case "auto_compaction_end":
        this.compacting = false;
        // Same patch the manual `compact` path applies — the client reads
        // event.result.estimatedTokensAfter for the banner.
        patchEstimatedTokensAfter(event.result);
        invalidateSessionListCache();
        // Chat event action: context_compacted (a compaction finished).
        // Compaction is not a conversation turn — it emits no terminal
        // agent_end, so conversation_completed never fires for it.
        dispatchChatEvent("context_compacted", this.chatEventPayload());
        break;
      case "session_info_update":
        if (typeof event.title === "string") this._sessionName = event.title;
        invalidateSessionListCache();
        refreshSessionList = true;
        break;
      case "skill_diagnostics_update":
        this.emit({
          type: "skill_diagnostics_update",
          data: parseSkillDiagnosticsSnapshot(event.data),
        });
        notifyRunningChange();
        return;
      case "response": {
        // Unsolicited failed responses surface async prompt failures (omp
        // reuses the original command id after the immediate ack).
        if (event.success === false && event.command === "prompt") {
          this.promptRunning = false;
          this.awaitingAgentStart = false;
          this.awaitingAgentStartDeadline = 0;
          this.emit({
            type: "prompt_error",
            errorMessage: (event.error as string) ?? "Prompt failed",
            ...(typeof event.code === "string" ? { errorCode: event.code } : {}),
            ...(typeof event.status === "number" || typeof event.status === "string" ? { errorStatus: event.status } : {}),
          });
          // Chat event action: provider_api_error (deduped per run against
          // the level:error notice frames; auto_retry_start is a retry, not
          // a failure — never dispatched here).
          dispatchChatEvent("provider_api_error", this.chatEventPayload());
          notifyRunningChange();
          return;
        }
        break;
      }
      case "notice": {
        if (event.source === "session-persistence") void this.followSessionMove();
        // level:error notices are the other provider_api_error source (e.g.
        // the model request failed and omp reported it as a notice instead of
        // a failed prompt response).
        if (event.level === "error") {
          dispatchChatEvent("provider_api_error", this.chatEventPayload());
        }
        break;
      }
      case "message_end": {
        // Completed message commit: the content-block discriminator
        // ({ type: "thinking" } / { type: "text" } entries in the content
        // array, verified against real session files) decides which chat
        // events fire. assistant_text fires for the final turn's text too —
        // intended per the plan.
        const message = event.message as { role?: string; content?: unknown } | undefined;
        if (message && typeof message === "object") {
          const content = Array.isArray(message.content) ? message.content : [];
          let hasThinking = false;
          let hasText = false;
          for (const block of content) {
            if (typeof block !== "object" || block === null) continue;
            const b = block as { type?: unknown; text?: unknown };
            if (b.type === "thinking") hasThinking = true;
            // A text block that is only whitespace (omp emits "\n" separator
            // blocks between turns) is not real assistant text — it must not
            // fire assistant_text.
            else if (b.type === "text" && typeof b.text === "string" && b.text.trim() !== "") hasText = true;
          }
          if (hasThinking) dispatchChatEvent("thinking_completed", this.chatEventPayload());
          if (message.role === "assistant" && hasText) {
            // Capture the latest assistant text so $last_reply can be
            // substituted into event actions fired later in this run.
            const texts: string[] = [];
            for (const block of content) {
              if (typeof block === "object" && block !== null) {
                const b = block as { type?: unknown; text?: unknown };
                if (b.type === "text" && typeof b.text === "string" && b.text.trim() !== "") texts.push(b.text);
              }
            }
            if (texts.length > 0) this._lastAssistantReply = texts.join("\n");
            dispatchChatEvent("assistant_text", this.chatEventPayload());
          }
        }
        break;
      }
      case "subagent_lifecycle": {
        // Terminal subagent statuses (completed/failed/aborted) are the
        // subagent_completed event; the client's parseSubagentLifecycle
        // uses the same statuses.
        const payload = event.payload as Record<string, unknown> | undefined;
        const status = typeof payload?.status === "string" ? payload.status : "";
        if (status === "completed" || status === "failed" || status === "aborted") {
          dispatchChatEvent("subagent_completed", this.chatEventPayload());
        }
        break;
      }
      case "tool_execution_end": {
        // A todo tool call mutates the todo list; the frame carries no
        // arguments (they are stringified JSON in the tool call), so diff the
        // authoritative get_state.todoPhases against the last snapshot to see
        // which tasks transitioned to completed (task_completed).
        if (event.toolName === "todo") {
          void (async () => {
            try {
              const state = await this.getStateWithTimeout();
              const phases = Array.isArray(state.todoPhases) ? state.todoPhases : [];
              if (taskCompletedDiff(this._todoPhases, phases)) {
                dispatchChatEvent("task_completed", this.chatEventPayload());
              }
              // Store unconditionally: a null baseline is recorded on the
              // first observation (e.g. right after op:"init") so init alone
              // never fires.
              this._todoPhases = phases;
            } catch {
              // get_state can time out; a missed diff only skips one event —
              // never throw into the frame loop.
            }
          })();
        }
        break;
      }
      case "tool_execution_start": {
        // Chat event action: question_asked — the assistant called the `ask`
        // tool (args: { i, questions: [{ id, question, options, … }] }), i.e.
        // it is asking the user something. The start frame is the only tool
        // frame carrying the call arguments (tool_execution_update repeats
        // them but _end carries the result), so the question text is read
        // here. Multiple questions are joined with newlines.
        if (event.toolName === "ask") {
          const args = typeof event.args === "object" && event.args !== null ? (event.args as Record<string, unknown>) : null;
          let question = "";
          if (args) {
            if (Array.isArray(args.questions)) {
              for (const q of args.questions) {
                if (typeof q === "object" && q !== null && typeof (q as Record<string, unknown>).question === "string") {
                  question = question ? `${question}\n${(q as Record<string, unknown>).question}` : String((q as Record<string, unknown>).question);
                }
              }
            }
            // Defensive fallback for a flat single-question shape.
            if (!question) {
              for (const key of ["question", "message", "prompt"]) {
                const v = args[key];
                if (typeof v === "string" && v.trim()) {
                  question = v;
                  break;
                }
              }
            }
          }
          dispatchChatEvent("question_asked", this.chatEventPayload({ type: "question_asked" }, question || undefined));
        }
        break;
      }
      case "extension_ui_request": {
        if (this.trackExtensionUiRequest(event)) {
          notifyRunningChange();
          return;
        }
        break;
      }
      case "host_tool_call": {
        const id = typeof event.id === "string" ? event.id : "";
        const toolName = typeof event.toolName === "string" ? event.toolName : "";
        // Route REGISTERED host tools to an attached UI (the browser answers
        // via host_tool_result). With no tab on this session, hand the call to
        // any open omp-web tab (the user switched sessions mid-run). Otherwise
        // reject immediately so the agent never hangs on a tool nobody will
        // answer.
        if (id && toolName && this.hostToolNames.has(toolName)) {
          if (this.listeners.length > 0) {
            this.pendingHostTools.set(id, event);
            this.emit(event);
            notifyRunningChange();
            return;
          }
          const otherTabs = getHostToolListeners();
          if (otherTabs.size > 0) {
            this.pendingHostTools.set(id, { ...event, webCrossSession: true });
            const args = event.arguments && typeof event.arguments === "object" ? event.arguments as Record<string, unknown> : {};
            const call: CrossSessionHostToolCall = { sessionId: this.sessionId, id, toolName, arguments: args };
            for (const listener of otherTabs) {
              try { listener(call); } catch { /* ignore listener errors */ }
            }
            notifyRunningChange();
            return;
          }
        }
        // Unregistered tool / no listener: reject (emits a notice) and do NOT
        // re-emit the frame — the UI must not answer a call nobody routed.
        this.rejectUnexpectedHostTool(event);
        return;
      }
      case "host_tool_cancel": {
        const targetId = typeof event.targetId === "string" ? event.targetId : "";
        if (targetId && this.pendingHostTools.delete(targetId)) {
          this.emit(event);
          notifyRunningChange();
          return;
        }
        break;
      }
      case "host_uri_request": {
        const id = typeof event.id === "string" ? event.id : "";
        const url = typeof event.url === "string" ? event.url : "";
        // Route registered schemes to an attached UI (the browser answers via
        // host_uri_result); unknown schemes / no listener are rejected so the
        // agent's read/write never hangs.
        const scheme = url.split(":")[0] ?? "";
        const operation = event.operation === "write" ? "write" : "read";
        const registered = this.hostUriSchemes.get(scheme);
        if (id && scheme && registered && (operation !== "write" || registered.writable) && this.listeners.length > 0) {
          this.pendingHostUris.set(id, event);
          this.emit(event);
          notifyRunningChange();
          return;
        }
        this.proc.sendFrame({
          type: "host_uri_result",
          id,
          isError: true,
          error: `URI scheme \"${scheme}\" is not registered by omp-web`,
        });
        return;
      }
      case "host_uri_cancel": {
        const targetId = typeof event.targetId === "string" ? event.targetId : "";
        if (targetId && this.pendingHostUris.delete(targetId)) {
          this.emit(event);
          notifyRunningChange();
          return;
        }
        break;
      }
    }

    this.emit(event);
    notifyRunningChange({ refreshSessionList });
  }

  /** Forget a pending dialog and its expiry timer. */
  private forgetPendingUiRequest(id: string): void {
    this.pendingUiRequests.delete(id);
    const timer = this.uiExpiryTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.uiExpiryTimers.delete(id);
    }
  }

  private clearPendingUiRequests(): void {
    for (const timer of this.uiExpiryTimers.values()) clearTimeout(timer);
    this.uiExpiryTimers.clear();
    this.pendingUiRequests.clear();
  }

  private trackExtensionUiRequest(event: AgentEvent): boolean {
    const method = event.method as string;
    const id = event.id as string;
    if (method === "cancel") {
      this.forgetPendingUiRequest(event.targetId as string);
      return false;
    }
    // Only the “Allow tool: <name>” confirmation is covered. Other extension
    // prompts, including login/editor confirmations, remain interactive.
    let autoApproveExtension = false;
    try {
      autoApproveExtension = readNativeSettings().settings.tools?.approval?.extension === "allow";
    } catch {
      // A malformed config must not prevent normal interactive approval.
    }
    if (method === "confirm" && typeof event.title === "string" && /^allow tool\s*:/i.test(event.title) && autoApproveExtension) {
      this.forgetPendingUiRequest(id);
      this.proc.sendFrame({ type: "extension_ui_response", id, confirmed: true });
      return true;
    }
    if (PENDING_UI_METHODS.has(method)) {
      this.forgetPendingUiRequest(id);
      const timeout = typeof event.timeout === "number" ? event.timeout : undefined;
      if (timeout && timeout > 0) {
        event.expiresAt = Date.now() + timeout;
        const timer = setTimeout(() => this.forgetPendingUiRequest(id), timeout);
        timer.unref?.();
        this.uiExpiryTimers.set(id, timer);
      }
      this.pendingUiRequests.set(id, event);
      return false;
    }
    if (method === "setStatus") {
      const key = event.statusKey as string;
      const text = event.statusText as string | undefined;
      if (text === undefined) this.extensionStatuses.delete(key);
      else this.extensionStatuses.set(key, text);
      return false;
    }
    if (method === "setWidget") {
      const key = event.widgetKey as string;
      const lines = event.widgetLines as string[] | undefined;
      if (lines === undefined) {
        this.extensionWidgets.delete(key);
      } else {
        this.extensionWidgets.set(key, {
          key,
          lines,
          placement: (event.widgetPlacement as "aboveEditor" | "belowEditor" | undefined) ?? "aboveEditor",
        });
      }
    }
    return false;
  }

  /**
   * Settle a host_tool_call the UI did not register (or arrived with no
   * attached listener) with an explicit error so its agent turn cannot hang
   * forever waiting for a response. Registered host tools are routed to
   * listeners in handleFrame (see the host_tool_call case).
   */
  private rejectUnexpectedHostTool(event: AgentEvent): void {
    const id = typeof event.id === "string" ? event.id : "";
    if (!id) return;
    const toolName = typeof event.toolName === "string" ? event.toolName : "unknown";
    this.proc.sendFrame({
      type: "host_tool_result",
      id,
      isError: true,
      result: {
        content: [{
          type: "text",
          text: `Host tool \"${toolName}\" is not available in omp-web. Use OMP's built-in tools within the selected workspace.`,
        }],
      },
    });
    this.emit({ type: "notice", level: "warning", message: `Rejected unavailable host tool: ${toolName}` });
  }

  /**
   * Reject outstanding host tool calls (browser disconnected / destroy): "own" ones went to this session's
   * stream, "cross" ones to other open tabs (see subscribeHostToolCalls).
   */
  private rejectPendingHostTools(message: string, which: "all" | "own" | "cross" = "all"): void {
    for (const [id, event] of this.pendingHostTools) {
      const cross = event.webCrossSession === true;
      if ((which === "own" && cross) || (which === "cross" && !cross)) continue;
      this.pendingHostTools.delete(id);
      this.proc.sendFrame({
        type: "host_tool_result",
        id,
        isError: true,
        result: { content: [{ type: "text", text: message }] },
      });
    }
  }

  /** The last other tab left: settle calls routed to other tabs. */
  rejectCrossSessionHostTools(): void {
    this.rejectPendingHostTools("The web UI disconnected while the agent was waiting for this host tool", "cross");
  }

  /** Reject every outstanding host URI request (browser disconnected / destroy). */
  private rejectPendingHostUris(message: string): void {
    for (const id of this.pendingHostUris.keys()) {
      this.proc.sendFrame({
        type: "host_uri_result",
        id,
        isError: true,
        error: message,
      });
    }
    this.pendingHostUris.clear();
  }

  /**
   * Forward frames to subscribers through the same display-rate coalescer
   * the browser uses, applied one hop earlier: omp emits message_update /
   * tool_execution_update at network rate (30-100+/s) each carrying the
   * FULL accumulated partial, so a long reply would otherwise push every
   * intermediate snapshot over the SSE connection. Folding here sends the
   * latest frame per display window (~20/s) and flushes the fold before
   * any other frame, so the client-visible order is unchanged.
   */
  private readonly frameCoalescer = createMessageUpdateCoalescer((event) => this.dispatchToListeners(event));

  private emit(event: AgentEvent): void {
    this.frameCoalescer.push(event);
  }

  private dispatchToListeners(event: AgentEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // A throwing subscriber (SSE encode failure, UI handler bug) must not
        // starve the remaining subscribers — same isolation RpcProcess and
        // notifyRunningChange apply to their listener sets.
      }
    }
  }
  /** Best-effort display name: the in-memory name (session_info_update /
   *  set_session_name) first, else the session file's display title (title
   *  slot, auto/task summary, or the first-message fallback that the
   *  session list already shows). omp's get_state carries no sessionName
   *  and the title slot is frequently empty — the client's auto-namer runs
   *  only after conversation_completed — so without the file fallback
   *  $session_name would be empty for most sessions. */
  private resolveSessionName(): string | undefined {
    if (this._sessionName) return this._sessionName;
    if (!this._sessionFile) return undefined;
    try {
      const info = scanSessionInfo(this._sessionFile, false);
      return sanitizeSessionTitle(info?.title);
    } catch {
      return undefined;
    }
  }

  /** Build the payload handed to the chat-event dispatcher: the session id,
   *  its display name (notification defaults), and a per-session frame
   *  relay (the notification executor uses it to reach the session's own
   *  SSE stream; it returns how many listeners received the frame). */
  private chatEventPayload(frame?: Record<string, unknown>, question?: string): ChatEventPayload {
    const payload: ChatEventPayload = { sessionId: this._sessionId };
    const sessionName = this.resolveSessionName();
    if (sessionName) payload.sessionName = sessionName;
    if (this._lastAssistantReply) payload.lastAssistantReply = this._lastAssistantReply;
    if (question) payload.question = question;
    if (frame) {
      payload.emitToSession = (f) => {
        let count = 0;
        for (const l of this.listeners) {
          try {
            l(f as AgentEvent);
            count += 1;
          } catch {
            // A throwing subscriber must not block the other streams.
          }
        }
        return count;
      };
    }
    return payload;
  }


  private sessionFileSignalTimer: NodeJS.Timeout | null = null;

  /** Poll briefly for the session file to appear after agent_start, then
   *  invalidate the session-list caches and re-signal the sidebar so the
   *  running session shows up even though the file landed after the first
   *  refresh (see the agent_start case). Bounded (max ~10s) and stops on
   *  destroy. */
  private signalWhenSessionFileAppears(): void {
    if (this.sessionFileSignalTimer) return;
    let attempts = 0;
    const check = () => {
      this.sessionFileSignalTimer = null;
      if (!this._alive || !this._sessionFile) return;
      if (!existsSync(this._sessionFile)) {
        attempts += 1;
        if (attempts < 40) {
          this.sessionFileSignalTimer = setTimeout(check, 250);
        }
        return;
      }
      invalidateSessionListCache();
      notifyRunningChange({ refreshSessionList: true });
    };
    this.sessionFileSignalTimer = setTimeout(check, 250);
  }

  private resetIdleTimer(): void {
    // The single activity choke point: start(), every child frame, and every
    // send() land here, so this is where "someone is using this session" is
    // observed. Tracked first, before anything below can defer or replace the
    // idle timer — it must never hide activity from the reaper.
    this.noteActivity();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.isRunning()) {
        this.resetIdleTimer();
        return;
      }
      this.destroy();
    }, IDLE_DESTROY_MS);
    // A cleanup deadline must not keep the process alive; the registry's
    // process-exit handler disposes every child anyway.
    this.idleTimer.unref?.();
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    this.noteActivity();
    const now = Date.now();
    for (const [id, event] of this.pendingUiRequests) {
      const expiresAt = event.expiresAt as number | undefined;
      if (expiresAt !== undefined && expiresAt <= now) {
        this.forgetPendingUiRequest(id);
        continue;
      }
      listener(event);
    }
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
      // No UI attached anymore: reject outstanding host tool calls so the
      // agent never waits forever on a tool nobody will answer.
      if (this.listeners.length === 0) {
        this.rejectPendingHostTools("The web UI disconnected while the agent was waiting for this host tool", "own");
        this.rejectPendingHostUris("The web UI disconnected while the agent was waiting for this URI request");
        // The last tab left. Start (not extend) the reap clock, so a session
        // that was never watched at all — predict_word, /api/agent/new — is
        // cleaned up on the same schedule as one whose tab just closed.
        this.reapDeadline = Date.now() + this.disconnectDestroyMs;
        this.armReap();
      }
    };
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallback = cb;
  }

  /** Called when a session-changing command re-keyed this wrapper (branch/new_session/switch_session). */
  onIdentityChange(cb: (oldId: string, newId: string, options?: IdentityChangeOptions) => void): void {
    this.onIdentityChangeCallback = cb;
  }

  private async withFinalRunningNotification<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      notifyRunningChange();
    }
  }

  /** Get OMP's own complete MCP inventory and live connection states. */
  async getMcpList(): Promise<string> {
    if (this.restarting) throw new WebRpcError(RESTARTING_MESSAGE, "session_restarting");
    if (!this.isAlive()) throw new Error("Session is no longer running");
    if (this.isRunning()) throw new WebRpcError("Wait for the current run to finish", "session_busy");
    if (this.mcpListWaiter) throw new WebRpcError("MCP list is already loading", "mcp_list_loading");

    this.promptRunning = true;
    notifyRunningChange();
    let resolveOutput!: (text: string) => void;
    let rejectOutput!: (error: Error) => void;
    const output = new Promise<string>((resolve, reject) => {
      resolveOutput = resolve;
      rejectOutput = reject;
    });
    // The timeout, destroy, and sendCommand-failure paths all reject this
    // promise while the only `await output` (success path) may never run —
    // swallow the orphan so it cannot surface as an unhandledRejection.
    void output.catch(() => {});
    const waiter = {
      resolve: resolveOutput,
      reject: rejectOutput,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    waiter.timer = setTimeout(() => {
        if (this.mcpListWaiter !== waiter) return;
        this.mcpListWaiter = null;
        rejectOutput(new WebRpcError("Timed out while loading MCP servers", "mcp_list_timeout"));
      }, MCP_LIST_TIMEOUT_MS);
    // Don't pin the event loop if the caller never awaits (route aborted): the
    // pending-UI timers already unref, this one should too.
    waiter.timer.unref?.();
    this.mcpListWaiter = waiter;

    try {
      await this.proc.sendCommand({ type: "prompt", message: "/mcp list" });
      return await output;
    } catch (error) {
      if (this.mcpListWaiter === waiter) {
        clearTimeout(waiter.timer);
        this.mcpListWaiter = null;
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    } finally {
      if (this.mcpListWaiter === waiter) {
        clearTimeout(waiter.timer);
        this.mcpListWaiter = null;
      }
      this.promptRunning = false;
      notifyRunningChange();
    }
  }

  private buildWebState(state: RpcSessionState): WebSessionState {
    const wasRunning = this.isRunning();

    // Reconcile process-side flags with authoritative child state.
    this.streaming = state.isStreaming;
    this.compacting = state.isCompacting;
    if (state.sessionName) this._sessionName = state.sessionName;
    if (state.sessionId) {
      this._sessionId = state.sessionId;
      this._sessionFile = state.sessionFile ?? this._sessionFile;
    }

    // `get_state` is authoritative once no command or browser-owned request
    // is still in flight and no async continuation is pending. A non-terminal
    // agent_end (e.g. a backgrounded bash job) means the turn resumes with a
    // later agent_start — minutes later, not immediately — so while
    // continuationPending the idle reconciliation must not clear promptRunning,
    // or a client re-attaching mid-pause would see an idle session and drop
    // its stream. This is the recovery path for a lost terminal SSE event,
    // while the agent-start grace prevents it from erasing a prompt that was
    // accepted milliseconds earlier.
    const awaitingExpired = !this.awaitingAgentStart || Date.now() >= this.awaitingAgentStartDeadline;
    const hasPendingWork =
      this.promptDispatchPendingCount > 0
      || (this.awaitingAgentStart && !awaitingExpired)
      || this.continuationPending
      || this.mcpListWaiter !== null
      || this.pendingUiRequests.size > 0
      || this.pendingHostTools.size > 0
      || this.pendingHostUris.size > 0;
    if (
      state.isStreaming === false
      && state.isCompacting === false
      && !hasPendingWork
    ) {
      this.promptRunning = false;
      this.awaitingAgentStart = false;
      this.awaitingAgentStartDeadline = 0;
    }

    if (wasRunning && !this.isRunning()) notifyRunningChange();
    const skillDiagnostics = parseSkillDiagnosticsSnapshot(state.skillDiagnostics);
    return {
      sessionId: state.sessionId,
      sessionFile: state.sessionFile ?? "",
      sessionName: this._sessionName,
      isStreaming: state.isStreaming,
      isPromptRunning: this.promptRunning,
      isBashRunning: this.bashRunning,
      isCompacting: state.isCompacting,
      autoCompactionEnabled: state.autoCompactionEnabled,
      autoRetryEnabled: state.autoRetryEnabled,
      interruptMode: state.interruptMode,
      steeringMode: state.steeringMode,
      followUpMode: state.followUpMode,
      model: state.model
        ? {
            id: state.model.id,
            provider: state.model.provider,
            name: state.model.name,
            reasoning: state.model.reasoning,
            thinking: state.model.thinking ? { efforts: state.model.thinking.efforts } : undefined,
          }
        : undefined,
      messageCount: state.messageCount,
      queuedMessageCount: state.queuedMessageCount,
      queuedMessages: state.queuedMessages ?? { steering: [], followUp: [] },
      tokensPerSecond: state.tokensPerSecond ?? null,
      contextUsage: state.contextUsage ?? null,
      systemPrompt: state.systemPrompt?.join("\n\n") ?? "",
      thinkingLevel: state.thinkingLevel ?? "off",
      // The child's per-family tier map is authoritative: it changes when the
      // model switches families (isFastModeEnabled is family-scoped) or when
      // the runtime auto-disables priority (e.g. after an Anthropic reject).
      // The wrapper's own flag is only the spawn-time cache.
      fastModeEnabled: state.fastModeEnabled ?? state.fastMode ?? this.fastModeEnabled,
      fastModeActive: state.fastModeActive,
      // omp < slow-mode RPC reports the legacy name; dual-read so the badge
      // survives both wire spellings (pinned omp 18.6.1 still emits anthropicSlowMode).
      usageLimit: state.usageLimit ?? state.anthropicSlowMode,
      slowModeSupported: state.slowModeSupported ?? false,
      slowModeEnabled: state.slowModeEnabled ?? false,
      slowModeScope: state.slowModeScope,
      ...(skillDiagnostics ? { skillDiagnostics } : {}),
      todoPhases: state.todoPhases ?? [],
      extensionStatuses: Array.from(this.extensionStatuses, ([key, text]) => ({ key, text })),
      extensionWidgets: Array.from(this.extensionWidgets.values()),
    };
  }

  private requireSkillDiagnostics(value: unknown): SkillDiagnosticsSnapshot {
    const snapshot = parseSkillDiagnosticsSnapshot(value);
    if (!snapshot) {
      throw new WebRpcError(
        "Skill diagnostics are unavailable for this OMP session",
        "skill_diagnostics_unsupported",
      );
    }
    return snapshot;
  }

  private async getStateWithTimeout(): Promise<RpcSessionState> {
    return this.proc.sendCommand<RpcSessionState>({ type: "get_state" }, GET_STATE_TIMEOUT_MS);
  }

  /** After branch/new_session/switch_session the child is on a different
   * session file — re-read identity and re-register in the registry. */
  private async refreshIdentityAfterSessionChange(): Promise<string> {
    const oldId = this._sessionId;
    const state = await this.getStateWithTimeout();
    this.applyIdentity(state);
    if (oldId && oldId !== this._sessionId) {
      this.onIdentityChangeCallback?.(oldId, this._sessionId);
    }
    invalidateSessionListCache();
    return this._sessionId;
  }

  /** Full restart of the child process against the same session file. This is
   * omp-web's `reload`: extensions, skills, prompts, and tools are rediscovered
   * on boot, matching a fresh CLI launch. */
  private async restart(): Promise<void> {
    if (this.restarting) throw new WebRpcError(RESTARTING_MESSAGE, "session_restarting");
    const sessionFile = this._sessionFile;
    const resumable = !!sessionFile && existsSync(sessionFile);
    const old = this.proc;
    // Stays true for the whole restart so send() rejects commands that would
    // otherwise hit the disposed or half-built child.
    this.restarting = true;
    this.unsubscribeFrames?.();
    try {
      this.expectedExitProc = old;
      try {
        await old.dispose();
      } finally {
        if (this.expectedExitProc === old) this.expectedExitProc = null;
      }
      if (!this._alive) return;

      this.extensionStatuses.clear();
      this.extensionWidgets.clear();
      this.clearPendingUiRequests();
      this.promptRunning = false;
      this.promptDispatchPendingCount = 0;
      this.awaitingAgentStart = false;
      this.awaitingAgentStartDeadline = 0;
      this.continuationPending = false;
      this.bashRunning = false;
      this.frameCoalescer.reset();
      this.streaming = false;
      this.compacting = false;
      this._interruptEndPending = false;
      this._continuationRun = false;
      this._completionPending = false;
      this._completionDeferred = false;

      let proc: RpcProcessLike;
      try {
        proc = await createRpcProcess({
          cwd: this.cwd,
          sessionId: this.sessionId,
          // Re-read per spawn so a restart picks up environment values the user
          // added in Settings after this session was created (#104).
          env: getAgentEnvOverrides(),
          extraArgs: buildSessionSpawnArgs(resumable ? sessionFile : ""),
          onExit: (info) => {
            if (this.proc === proc) this.handleProcessExit(info, proc);
          },
        });
      } catch (error) {
        // Same classification as startRpcSession: in Rust mode a spawn failure
        // means the host is unavailable — make it App-visible.
        if (process.env.OMPWEB_BACKEND !== "node") {
          recordBackendError("host_unavailable", `session restart failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        throw error;
      }
      this.proc = proc;
      this.unsubscribeFrames = proc.onFrame((frame) => this.handleFrame(frame));
      try {
        const ready = await proc.waitReady(READY_TIMEOUT_MS);
        await proc.negotiateProtocol(ready);
        // The replacement process starts with subscriptions disabled; restore
        // the live roster/transcript event stream before reading its state.
        await proc.sendCommand({ type: "set_subagent_subscription", level: "events" }).catch(() => {});
        await proc.sendCommand({ type: "set_ask_dialog", enabled: true }, GET_STATE_TIMEOUT_MS).catch(() => {});
        const state = await proc.sendCommand<RpcSessionState>({ type: "get_state" }, GET_STATE_TIMEOUT_MS);
        this.applyIdentity(state);
      } catch (error) {
        // Never leave the replacement running with nobody reading its frames.
        this.unsubscribeFrames?.();
        this.unsubscribeFrames = null;
        void proc.dispose();
        // The wrapper has no usable child left; drop it from the registry so the
        // next request starts a fresh session instead of reusing a corpse.
        this.destroy();
        throw error;
      }
    } finally {
      this.restarting = false;
    }
    notifyRunningChange();
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    if (this.restarting) throw new WebRpcError(RESTARTING_MESSAGE, "session_restarting");
    if (!this.isAlive()) throw new Error("Session is no longer running");
    this.resetIdleTimer();
    // Covers the whole command, including the awaits inside it: a route that
    // has an unwatched session in mid-command (predict_word on a keystroke, an
    // export, a follow-up) must never have its child reaped underneath it.
    this.pendingCommands += 1;
    try {
      return await this.dispatchCommand(command);
    } finally {
      this.pendingCommands = Math.max(0, this.pendingCommands - 1);
    }
  }

  private async dispatchCommand(command: Record<string, unknown>): Promise<unknown> {
    const type = command.type as string;

    if (type === "prompt" || type === "steer" || type === "follow_up" || type === "abort_and_prompt") {
      const imageError = validateAgentImages(command.images);
      if (imageError) throw new Error(imageError);
    }

    const unsupported = UNSUPPORTED_COMMANDS[type];
    if (unsupported) throw new RpcCommandError(type, unsupported, "unsupported");

    switch (type) {
      case "prompt": {
        if (this.bashRunning) {
          throw new Error("Cannot send a prompt while a shell command is running");
        }
        const streamingBehavior = command.streamingBehavior as "steer" | "followUp" | undefined;
        if (!streamingBehavior) {
          this.promptRunning = true;
          this.promptDispatchPendingCount += 1;
          this.awaitingAgentStart = false;
          this.awaitingAgentStartDeadline = 0;
          this.continuationPending = false;
          notifyRunningChange();
        }
        try {
          // omp acks immediately; agent output streams as events, completion is
          // agent_end (agent runs) or prompt_result (local-only slash commands).
          const ack = await this.proc.sendCommand<{ agentInvoked?: boolean } | undefined>({
            type: "prompt",
            message: command.message as string,
            ...(toImageContents(command.images) ? { images: toImageContents(command.images) } : {}),
            ...(streamingBehavior ? { streamingBehavior } : {}),
          }, PROMPT_ACK_TIMEOUT_MS);
          // Slash commands fully consumed by a builtin report agentInvoked:false
          // in the ack itself — no prompt_result frame follows.
          if (ack?.agentInvoked === false && !streamingBehavior) {
            this.promptRunning = false;
            this.awaitingAgentStart = false;
            this.awaitingAgentStartDeadline = 0;
            this.emit({ type: "prompt_result", agentInvoked: false });
            notifyRunningChange();
          } else if (!streamingBehavior && ack?.agentInvoked !== false) {
            this.awaitingAgentStart = true;
            this.awaitingAgentStartDeadline = Date.now() + AWAITING_AGENT_START_TIMEOUT_MS;
          }
        } catch (error) {
          this.promptRunning = false;
          this.awaitingAgentStart = false;
          this.awaitingAgentStartDeadline = 0;
          notifyRunningChange();
          if (error instanceof RpcCommandTimeoutError || (error instanceof Error && error.name === "RpcCommandTimeoutError")) {
            // The command was never acknowledged. Dispose the child so the
            // next user action is guaranteed to attach a fresh session.
            await this.destroyAndWait();
            throw new WebRpcError("The OMP session stopped responding and was reset.", "session_unresponsive");
          }
          throw error;
        } finally {
          if (!streamingBehavior) {
            this.promptDispatchPendingCount = Math.max(0, this.promptDispatchPendingCount - 1);
          }
        }
        return null;
      }

      case "steer":
      case "follow_up": {
        await this.proc.sendCommand({
          type,
          message: command.message as string,
          ...(toImageContents(command.images) ? { images: toImageContents(command.images) } : {}),
        });
        return null;
      }

      case "remove_queued_message":
      case "promote_queued_message": {
        // Queue mutations are synchronous control operations, like get_state.
        // Expiry must not abort unrelated work or replay a possibly applied
        // mutation.
        const result = await this.proc.sendCommand(command as { type: string }, GET_STATE_TIMEOUT_MS);
        return result ?? null;
      }

      // abort_and_restore_queue is omp's Esc: it takes queued user input back
      // atomically, then aborts, and returns the withdrawn messages.
      case "abort":
      case "abort_and_restore_queue": {
        // Mark the interrupted turn's upcoming terminal agent_end so it does
        // not dispatch conversation_completed (see agent_end handler).
        this._interruptEndPending = true;
        const result = await this.withFinalRunningNotification(async () => {
          const response: unknown = await this.proc.sendCommand({ type });
          // If the prompt was aborted before the agent loop started, no
          // agent_end will arrive to clear the flag; the streaming flag still
          // tracks a live turn that ends with its own agent_end.
          this.promptRunning = false;
          this.continuationPending = false;
          return response;
        });
        // Chat event action: conversation_interrupted (command accepted by omp).
        dispatchChatEvent("conversation_interrupted", this.chatEventPayload());
        return type === "abort" ? null : result ?? null;
      }

      case "goal": {
        // A goal pause/drop must also stop the child's own run: while the
        // goal was ACTIVE and is driving an in-flight continuation turn, the
        // status change alone only prevents FUTURE wakes — the agent keeps
        // working on the objective and the pause/drop reads as "not working".
        // Host-prompt runs belong to the user's prompt and are stopped only
        // by Stop (the web never interrupts a user-prompted turn here).
        const op = command.op as string;
        const goalWasActive = this._goalStatus === "active";
        const result = await this.proc.sendCommand(command as { type: string });
        this._goalStatus = readGoalStatus(result);
        if ((op === "pause" || op === "drop") && goalWasActive && this.streaming && !this._hostRun) {
          this._interruptEndPending = true;
          await this.withFinalRunningNotification(async () => {
            await this.proc.sendCommand({ type: "abort" });
            this.promptRunning = false;
            this.continuationPending = false;
          });
          dispatchChatEvent("conversation_interrupted", this.chatEventPayload());
        }
        return result ?? null;
      }

      case "get_state": {
        try {
          const state = await this.getStateWithTimeout();
          return this.buildWebState(state);
        } catch (error) {
          if (error instanceof RpcCommandTimeoutError || (error instanceof Error && error.name === "RpcCommandTimeoutError")) {
            await this.destroyAndWait();
            throw new WebRpcError("The OMP session stopped responding and was reset.", "session_unresponsive");
          }
          throw error;
        }
      }

      case "get_skill_diagnostics": {
        const result = await this.proc.sendCommand<unknown>({ type: "get_skill_diagnostics" }, GET_STATE_TIMEOUT_MS);
        return this.requireSkillDiagnostics(result);
      }

      case "set_skill_startup_diagnostics": {
        if (typeof command.enabled !== "boolean") {
          throw new WebRpcError("enabled must be a boolean", "invalid_skill_startup_diagnostics");
        }
        const result = await this.proc.sendCommand<unknown>({
          type: "set_skill_startup_diagnostics",
          enabled: command.enabled,
        }, GET_STATE_TIMEOUT_MS);
        return this.requireSkillDiagnostics(result);
      }

      case "set_model": {
        const { provider, modelId } = command as { provider: string; modelId: string };
        try {
          const model = await this.proc.sendCommand<OmpModel>({ type: "set_model", provider, modelId }, SET_MODEL_TIMEOUT_MS);
          invalidateModelsCache();
          invalidateSessionListCache();
          return { id: model.id, provider: model.provider };
        } catch (error) {
          if (error instanceof RpcCommandTimeoutError) {
            await this.destroyAndWait();
            throw new WebRpcError("The OMP session stopped responding and was reset.", "session_unresponsive");
          }
          throw error;
        }
      }

      case "set_fast_mode": {
        const enabled = command.enabled === true;
        const result = await this.proc.sendCommand<{ enabled?: boolean; active?: boolean }>({ type: "set_fast_mode", enabled });
        this.fastModeEnabled = result?.enabled ?? enabled;
        return { enabled: this.fastModeEnabled, active: result?.active ?? false };
      }

      case "set_slow_mode": {
        const enabled = command.enabled === true;
        const result = await this.proc.sendCommand<{ enabled?: boolean }>({ type: "set_slow_mode", enabled });
        return { enabled: result?.enabled ?? enabled };
      }

      case "fork": {
        // omp's `branch` is pi-web's fork: it creates a branched session file
        // and switches this live process onto it (entryId must be a user
        // message entry, matching the web UI's fork buttons).
        if (this.bashRunning) {
          throw new Error("Cannot fork while a shell command is running");
        }
        const result = await this.proc.sendCommand<{ text: string; cancelled: boolean }>({
          type: "branch",
          entryId: command.entryId as string,
        });
        if (result.cancelled) return { cancelled: true };
        const newSessionId = await this.refreshIdentityAfterSessionChange();
        // `text` is the branched prompt omp hands back for edit-and-resend.
        return { cancelled: false, newSessionId, text: result.text };
      }

      case "new_session":
      case "switch_session": {
        const result = await this.proc.sendCommand<{ cancelled: boolean }>(command as { type: string });
        if (!result.cancelled) {
          const newSessionId = await this.refreshIdentityAfterSessionChange();
          return { cancelled: false, newSessionId };
        }
        return result;
      }

      case "compact": {
        try {
          return await this.withFinalRunningNotification(async () => {
            this.compacting = true;
            notifyRunningChange();
            try {
              const result = await this.proc.sendCommand<CompactionResultLike>({
                type: "compact",
                ...(command.customInstructions ? { customInstructions: command.customInstructions } : {}),
              });
              patchEstimatedTokensAfter(result);
              // Chat event action: context_compacted. sendCommand rejects on a
              // failed response (e.g. "Nothing to compact"), so this only
              // fires when compaction actually happened.
              dispatchChatEvent("context_compacted", this.chatEventPayload());
              return result;
            } finally {
              this.compacting = false;
            }
          });
        } finally {
          invalidateSessionListCache();
        }
      }

      case "abort_compaction":
        // No dedicated RPC command; a plain abort cancels the in-flight turn
        // including compaction work.
        // Same as abort: the interrupted turn's terminal agent_end is not a
        // completion.
        this._interruptEndPending = true;
        await this.withFinalRunningNotification(() => this.proc.sendCommand({ type: "abort" }));
        return null;

      case "set_session_name": {
        const name = (command.name as string | undefined)?.trim();
        if (!name) throw new Error("Session name cannot be empty");
        await this.proc.sendCommand({ type: "set_session_name", name });
        this._sessionName = name;
        invalidateSessionListCache();
        return null;
      }

      case "get_session_stats": {
        const stats = await this.proc.sendCommand<Omit<SessionStatsInfo, "sessionName">>({ type: "get_session_stats" });
        return { ...stats, sessionName: this.resolveSessionName() };
      }

      case "get_last_assistant_text": {
        const data = await this.proc.sendCommand<{ text: string | null }>({ type: "get_last_assistant_text" });
        return { text: data.text ?? "" };
      }

      case "get_commands": {
        const data = await this.proc.sendCommand<{ commands: RpcAvailableSlashCommand[] }>({
          type: "get_available_commands",
        });
        return data;
      }

      case "reload": {
        await this.restart();
        return { success: true };
      }

      case "extension_ui_response": {
        const { id, ...rest } = command as { id: string; [key: string]: unknown };
        const pendingAsk = this.pendingUiRequests.get(id)?.method === "ask";
        // A pending ask accepts only its answers or a cancel; anything else would
        // drop it from reconnect replay while omp rejects the payload.
        if (("answers" in rest || pendingAsk) && !isAskAnswers(rest.answers) && !(pendingAsk && rest.cancelled === true)) {
          throw new WebRpcError("Invalid ask dialog answers", "invalid_ask_answers");
        }
        const wasPending = this.pendingUiRequests.has(id);
        this.forgetPendingUiRequest(id);
        this.proc.sendFrame({ type: "extension_ui_response", id, ...rest });
        // omp sends no cancel for an answered dialog; other tabs on this
        // session would keep showing it, so settle it for them here.
        if (wasPending) this.emit({ type: "extension_ui_request", id: `cancel:${id}`, method: "cancel", targetId: id });
        return null;
      }

      case "bash": {
        // omp's RPC bash command is `{type:"bash", command}` only (rpc-types.ts)
        // — there is no excludeFromContext option anywhere in modes/rpc. Running
        // a `!!` command anyway would put output the user meant to keep private
        // into the model context, so refuse instead of silently ignoring it.
        if (command.excludeFromContext === true) {
          throw new WebRpcError(BASH_EXCLUDE_MESSAGE, "bash_exclude_unsupported");
        }
        if (this.isRunning()) {
          throw new Error("Cannot run a shell command while the session is busy");
        }
        this.bashRunning = true;
        notifyRunningChange();
        try {
          return await this.proc.sendCommand<BashResultInfo>({ type: "bash", command: command.command as string });
        } finally {
          this.bashRunning = false;
          invalidateSessionListCache();
          notifyRunningChange();
        }
      }

      case "set_host_tools": {
        const tools = Array.isArray(command.tools) ? command.tools as Array<{ name?: unknown; [key: string]: unknown }> : [];
        const valid = tools.filter((t) => typeof t.name === "string" && t.name);
        this.hostToolNames = new Set(valid.map((t) => t.name as string));
        await this.proc.sendCommand({ type: "set_host_tools", tools: valid });
        return null;
      }

      case "host_tool_result": {
        if (typeof command.id === "string") this.pendingHostTools.delete(command.id);
        // Fire-and-forget frame: preserves the original request id (sendCommand
        // would mint a fresh id and await a reply the agent never sends).
        this.proc.sendFrame(command as { type: string; [key: string]: unknown });
        return null;
      }

      case "set_host_uri_schemes": {
        const schemes = Array.isArray(command.schemes) ? command.schemes as Array<{ scheme?: unknown; writable?: unknown; [key: string]: unknown }> : [];
        this.hostUriSchemes = new Map();
        for (const entry of schemes) {
          if (typeof entry.scheme === "string" && entry.scheme) {
            this.hostUriSchemes.set(entry.scheme, { writable: entry.writable === true });
          }
        }
        await this.proc.sendCommand({ type: "set_host_uri_schemes", schemes });
        return null;
      }

      case "host_uri_result": {
        if (typeof command.id === "string") this.pendingHostUris.delete(command.id);
        // Fire-and-forget frame: preserves the original request id (sendCommand
        // would mint a fresh id and await a reply the agent never sends).
        this.proc.sendFrame(command as { type: string; [key: string]: unknown });
        return null;
      }

      default: {
        if (PASSTHROUGH_COMMANDS.has(type)) {
          try {
            // Mark the interrupted turn's upcoming terminal agent_end (see
            // the abort case); must be set before the command is sent so the
            // end frame cannot arrive before the flag.
            if (type === "abort_and_prompt") this._interruptEndPending = true;
            const result: unknown = await this.proc.sendCommand(
              command as { type: string },
              type === "abort_and_prompt" ? PROMPT_ACK_TIMEOUT_MS : type === "predict_word" ? PREDICT_WORD_TIMEOUT_MS : undefined,
            );
            if (type === "set_thinking_level") invalidateSessionListCache();
            // Chat event action: conversation_interrupted (the interrupt half
            // of abort_and_prompt was accepted).
            if (type === "abort_and_prompt") dispatchChatEvent("conversation_interrupted", this.chatEventPayload());
            return result ?? null;
          } catch (error) {
            if (type === "abort_and_prompt" && (error instanceof RpcCommandTimeoutError || (error instanceof Error && error.name === "RpcCommandTimeoutError"))) {
              await this.destroyAndWait();
              throw new WebRpcError("The OMP session stopped responding and was reset.", "session_unresponsive");
            }
            throw error;
          }
        }
        throw new Error(`Unsupported command: ${type}`);
      }
    }
  }

  destroy(): void {
    void this.destroyAndWait();
  }

  /** Destroy and resolve only after the omp child has fully exited. Callers
   * that delete the session file afterwards must await this — omp flushes
   * session state on shutdown and would otherwise recreate the file. */
  async destroyAndWait(): Promise<void> {
    // Re-entrant calls join the in-flight dispose; without this a new spawn
    // can overlap the old child's shutdown (see startRpcSession).
    if (this.destroyPromise) return this.destroyPromise;
    if (!this._alive) return;
    this._alive = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.reapTimer) {
      clearTimeout(this.reapTimer);
      this.reapTimer = null;
    }
    if (this.sessionFileSignalTimer) {
      clearTimeout(this.sessionFileSignalTimer);
      this.sessionFileSignalTimer = null;
    }
    this.unsubscribeFrames?.();
    this.clearPendingUiRequests();
    this.continuationPending = false;
    // A session destroyed without a terminal agent_end (idle timeout, delete,
    // crash) must not leave a stale per-run entry in the dispatcher's
    // globalThis Map.
    clearChatActionRunState(this._sessionId);
    this._todoPhases = null;
    if (this.mcpListWaiter) {
      clearTimeout(this.mcpListWaiter.timer);
      this.mcpListWaiter.reject(new Error("Session was closed while loading MCP servers"));
      this.mcpListWaiter = null;
    }
    const disposed = this.proc.dispose().catch(() => {});
    this.destroyPromise = disposed;
    this.pendingHostTools.clear();
    this.hostToolNames.clear();
    this.pendingHostUris.clear();
    this.hostUriSchemes.clear();
    this.emit({ type: "session_destroyed" });
    this.frameCoalescer.reset();
    notifyRunningChange();
    await disposed;
    // Keep this registry entry discoverable until the underlying child has
    // stopped. A concurrent replacement then waits for destroyPromise instead
    // of spawning a second process against the same session journal.
    this.onDestroyCallback?.();
  }
}

// ============================================================================
// Session registry
// ============================================================================
export interface RunningSessionUpdate {
  ids: string[];
  refreshSessionList: boolean;
  exitedSessions: ExitedRpcSession[];
}

declare global {
  var __ompSessions: Map<string, AgentSessionWrapper> | undefined;
  var __ompStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
  var __ompRunningListeners: Set<(update: RunningSessionUpdate) => void> | undefined;
  var __ompHostToolListeners: Set<(call: CrossSessionHostToolCall) => void> | undefined;
  var __ompExitedSessions: Map<string, ExitedRpcSession> | undefined;
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__ompSessions) {
    globalThis.__ompSessions = new Map();
    const cleanup = () => {
      // Children dying from here on are the shutdown, not finished runs.
      markShuttingDown();
      globalThis.__ompSessions?.forEach((session) => session.destroy());
    };
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__ompSessions;
}

function getLocks(): Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> {
  if (!globalThis.__ompStartLocks) globalThis.__ompStartLocks = new Map();
  return globalThis.__ompStartLocks;
}

function getExitedMap(): Map<string, ExitedRpcSession> {
  if (!globalThis.__ompExitedSessions) globalThis.__ompExitedSessions = new Map();
  return globalThis.__ompExitedSessions;
}

export function getExitedRpcSessions(): ExitedRpcSession[] {
  return [...getExitedMap().values()];
}

export function getExitedRpcSession(sessionId: string): ExitedRpcSession | undefined {
  return getExitedMap().get(sessionId);
}

/** Clear the visible crash state once a replacement child is ready. */
export function clearExitedRpcSession(sessionId: string): boolean {
  const cleared = getExitedMap().delete(sessionId);
  if (cleared) notifyRunningChange();
  return cleared;
}

export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {
  return getRegistry().get(sessionId);
}

export function getRunningRpcSessionIds(): string[] {
  const ids = new Set<string>();
  for (const [sessionId, session] of getRegistry()) {
    if (session.isRunning()) ids.add(session.sessionId || sessionId);
  }
  return [...ids];
}

/** Stop all live omp children after an explicit runtime update. The browser will
 * reconnect sessions on demand and start them with the updated executable. */
export async function restartAllRpcSessions(): Promise<number> {
  const sessions = [...new Set(getRegistry().values())];
  // A single session may fail to tear down (e.g. a half-open SSE stream);
  // that must not block restarting the rest.
  await Promise.all(sessions.map((session) => session.destroyAndWait().catch(() => undefined)));
  return sessions.length;
}

// ----------------------------------------------------------------------------
// Running-status broadcaster
//
// Pushes the current set of running session ids to subscribers whenever any
// session's running state may have changed. This lets the sidebar receive live
// updates over SSE instead of polling. Listeners live on globalThis so they
// survive Next.js hot-reload.
// ----------------------------------------------------------------------------

function getRunningListeners(): Set<(update: RunningSessionUpdate) => void> {
  if (!globalThis.__ompRunningListeners) globalThis.__ompRunningListeners = new Set();
  return globalThis.__ompRunningListeners;
}

/** Subscribe to running-session-id changes and session-list refreshes. */
export function subscribeRunningSessions(listener: (update: RunningSessionUpdate) => void): () => void {
  const listeners = getRunningListeners();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// ----------------------------------------------------------------------------
// Cross-session host tool calls
//
// A registered host tool called while no tab watches its session goes to every
// open omp-web tab (over /api/agent/host-tools/events) instead of being rejected.
// ----------------------------------------------------------------------------

function getHostToolListeners(): Set<(call: CrossSessionHostToolCall) => void> {
  if (!globalThis.__ompHostToolListeners) globalThis.__ompHostToolListeners = new Set();
  return globalThis.__ompHostToolListeners;
}

/** Subscribe to host tool calls for sessions no tab is currently watching. */
export function subscribeHostToolCalls(listener: (call: CrossSessionHostToolCall) => void): () => void {
  const listeners = getHostToolListeners();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      for (const session of getRegistry().values()) session.rejectCrossSessionHostTools();
    }
  };
}

let lastRunningSnapshot = "";

/**
 * Recompute the running-session-id set and, when it changes, broadcast it.
 * A session file may first appear after its id starts running, so callers can
 * force one otherwise-identical update to refresh sidebar session metadata.
 */
export function notifyRunningChange({ refreshSessionList = false }: { refreshSessionList?: boolean } = {}): void {
  const ids = getRunningRpcSessionIds();
  const exitedSessions = getExitedRpcSessions();
  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  const snapshot = JSON.stringify([ids.slice().sort(), exitedSessions.slice().sort(byId)]);
  if (snapshot === lastRunningSnapshot && !refreshSessionList) return;
  lastRunningSnapshot = snapshot;
  syncInterruptibleSessions();
  const update: RunningSessionUpdate = { ids, refreshSessionList, exitedSessions };
  for (const listener of getRunningListeners()) {
    try { listener(update); } catch { /* ignore listener errors */ }
  }
}

/** Record which sessions are mid-run, for resume after a restart. */
export function syncInterruptibleSessions(): void {
  const registry = getRegistry();
  const running = new Map<string, { id: string; advisor: boolean }>();
  for (const session of registry.values()) {
    if (session.sessionId && session.isRunning()) running.set(session.sessionId, { id: session.sessionId, advisor: session.advisorSpawned });
  }
  recordRunningSessions([...running.values()], (id) => registry.get(id)?.isAlive() === true);
}

/**
 * Restart the sessions that were mid-run when omp-web last stopped and ask
 * each to continue. Only runs when the auto-resume setting is on.
 */
export async function resumeInterruptedSessions(): Promise<void> {
  await Promise.all(takeInterruptedSessions().map(async ({ id, advisor }) => {
    try {
      const filePath = await resolveSessionPath(id);
      if (!filePath) return;
      const header = readSessionHeader(filePath);
      const { cwd } = resolveSpawnCwdResult(header?.cwd);
      const { session } = await startRpcSession(id, filePath, cwd, undefined, advisor, header?.cwd);
      await session.send({ type: "prompt", message: RESUME_PROMPT });
      console.log(`[omp-web] resumed interrupted session ${id}`);
    } catch (error) {
      console.warn(`[omp-web] could not resume session ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
}

/**
 * Get or create the omp RPC process for the given session.
 * For new sessions (sessionFile === ""), omp generates its own id.
 * Pass toolNames to pre-configure the builtin toolset of a NEW session
 * (empty array = all tools disabled); ignored when resuming.
 */
export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string,
  toolNames?: string[],
  /** Spawn-time --advisor flag. Pass an explicit boolean to replace an idle
   * child whose flag differs; pass undefined to reuse whatever is alive. */
  advisor?: boolean,
  /** The cwd recorded in the session file header, used to detect a spawn
   * fallback (recorded dir gone) and warn the user. Omit for new sessions. */
  recordedCwd?: string | null,
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const registry = getRegistry();
  const locks = getLocks();

  const existing = registry.get(sessionId);
  if (existing?.isAlive()) {
    // --advisor is a spawn-time flag with no runtime RPC. When the caller
    // carries an explicit advisor setting that differs from the live child's,
    // replace the child so the toggle takes effect on the next prompt. Busy
    // children are kept (a mid-run swap would drop in-flight work) and pick
    // the new flag up at the next natural respawn; callers that pass no
    // advisor opinion (undefined) simply reuse whatever is running.
    if (advisor === undefined || existing.advisorSpawned === advisor || existing.isRunning()) {
      return { session: existing, realSessionId: sessionId };
    }
    await existing.destroyAndWait();
  }
  // A wrapper whose omp child is still flushing/exiting must fully dispose
  // before a replacement spawns — two children touching the same .jsonl would
  // race on resume/delete/archive.
  if (existing?.destroyPromise) await existing.destroyPromise;

  // omp >= 18.5 lets only one process own a session file; a second `--resume`
  // child would fork into a new nested session on its first write. Reuse the
  // live wrapper that already reports this file (e.g. after it moved files).
  if (sessionFile && !existing) {
    for (const candidate of new Set(registry.values())) {
      if (candidate.isAlive() && candidate.sessionFile && samePath(candidate.sessionFile, sessionFile)) {
        registry.set(sessionId, candidate);
        return { session: candidate, realSessionId: candidate.sessionId };
      }
    }
  }

  const inflight = locks.get(sessionId);
  if (inflight) return inflight;

  const starting = (async () => {
    // The wrapper needs the process and the process's onExit needs the wrapper;
    // the holder breaks that cycle (onExit only fires once the child dies).
    const holder: { wrapper?: AgentSessionWrapper } = {};
    let proc: RpcProcessLike;
    try {
      proc = await createRpcProcess({
        cwd,
        sessionId: sessionId ?? `session-${Math.random().toString(36).slice(2, 10)}`,
        // User-configured variables for MCP servers and generated configs (#104).
        env: getAgentEnvOverrides(),
        extraArgs: buildSessionSpawnArgs(sessionFile, toolNames, advisor === true),
        onExit: (info) => holder.wrapper?.handleProcessExit(info, proc),
      });
    } catch (error) {
      // Rust 后端下启动失败 = host 不可用（二进制缺失/启动超时/IPC 失败），
      // 记入后端错误环让横幅可见；node 显式回滚模式不计入 host 故障。
      if (process.env.OMPWEB_BACKEND !== "node") {
        recordBackendError("host_unavailable", `session start failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
    const created = new AgentSessionWrapper(proc, cwd, recordedCwd, advisor === true, sessionFile ? sessionId : "");
    holder.wrapper = created;
    created.start();
    try {
      await created.waitUntilReady();
    } catch (error) {
      // Await the child's full exit before the `finally` releases the startup
      // lock: a fire-and-forget destroy() would let a retry spawn a second
      // OMP child while the failed one is still flushing/exiting, and
      // concurrent resume/delete/archive paths could race that old child.
      await created.destroyAndWait();
      throw error;
    }

    const realSessionId = created.sessionId;
    // 会话分裂检测：--resume <file> 后 omp 返回了不同的会话 id，说明该会话
    // 文件正被另一个 omp/ompweb 实例占用（旧实例的孤儿进程持有锁/待定工具
    // 调用）——继续发消息会落到新会话里，UI 看不到任何响应。此时明确报错，
    // 并计入 RPC 健康信号，让顶栏横幅提示用户清理旧实例。
    // 仅对真正的 resume（sessionFile 非空）检测。新建会话（sessionFile === "")
    // 时 sessionId 是 __new__<uuid> 临时键、omp 必然生成全新 id，二者不同是
    // 正常现象；若也套用本检测会把每一次新建会话都误判为 session split。
    if (sessionFile && sessionId && realSessionId && realSessionId !== sessionId) {
      const detail = `session split: requested ${sessionId}, omp resumed as ${realSessionId}`;
      recordRpcFailure(detail);
      await created.destroyAndWait();
      throw new WebRpcError(
        "This session is already in use by another omp instance and cannot be resumed. Close other ompweb/omp instances first (the banner at the top can clean them up in one click), then retry.",
        "session_split",
      );
    }
    created.onDestroy(() => {
      // Drop every key (current id, original id, moved-from aliases).
      for (const [key, wrapper] of registry) if (wrapper === created) registry.delete(key);
    });
    created.onIdentityChange((oldId, newId, options) => {
      if (!options?.keepOldId && registry.get(oldId) === created) registry.delete(oldId);
      registry.set(newId, created);
    });
    registry.set(realSessionId, created);
    // A successful respawn supersedes the crash record.
    clearExitedRpcSession(sessionId);
    if (realSessionId !== sessionId) clearExitedRpcSession(realSessionId);
    return { session: created, realSessionId };
  })().finally(() => locks.delete(sessionId));

  locks.set(sessionId, starting);
  return starting;
}
