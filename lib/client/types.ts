// Transport-agnostic client contracts (5.0 doc 01). UI code consumes these
// interfaces; adapters (HTTP/SSE today, Remote WS / LocalHost / fixtures
// later) implement them. No Next route types, no Node/DOM-specific objects
// beyond standard fetch primitives may appear here.

import type { AgentEventFrame, ConnectedFrame, SessionDestroyedFrame } from "@/lib/contracts/agent-envelope";
import type { SessionInfo } from "@/lib/types";
import type { GitCommitFileDiff, GitGraphRow } from "@/lib/git-log";
import type { GitStatusResponse } from "@/lib/git-types";
import type { GitHubRepoStatus } from "@/lib/github";
import type { NativeSettings } from "@/lib/omp/settings-config";
import type { ScheduleSpec } from "@/lib/schedule";
import type { SchedulerWithState } from "@/lib/scheduler-types";
import type { ActionSpec, ChatEventAction, ChatEventActionInput, ChatEventActionPatch } from "@/lib/chat-event-action-types";

/** Unified error shape (doc 01 contract rule 3): UI branches on `code`. */
export interface ClientError {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export function toClientError(payload: { error?: string; code?: string }, fallbackStatus = 0): ClientError {
  return {
    code: payload.code ?? `http_${fallbackStatus || 0}`,
    message: payload.error ?? "Request failed",
    retryable: fallbackStatus === 0 || fallbackStatus >= 500 || fallbackStatus === 429,
  };
}

export type SubscriptionState = "connecting" | "open" | "closed";

/**
 * Unified subscription handle (doc 01 contract rule 6). 4.x SSE has no cursor
 * yet; `lastCursor` stays null until the Remote WS adapter (doc 02/03) lands.
 */
export interface EventSubscription {
  close(): void;
  readonly state: SubscriptionState;
  /** True when the underlying transport is live (EventSource.OPEN). */
  readonly isOpen: boolean;
  readonly lastCursor: null | { hostEpoch: string; streamId: string; seq: number };
  /** Re-issue the underlying request (used by reconcile, doc 10 visibility). */
  resync(): void;
}

export interface AgentSessionEvents {
  onOpen?: () => void;
  onConnected?: (frame: ConnectedFrame) => void;
  onEvent?: (frame: AgentEventFrame) => void;
  onDestroyed?: (frame: SessionDestroyedFrame) => void;
  /** fatal=true means the transport closed for good (no auto-reconnect). */
  onDown?: (info: { fatal: boolean }) => void;
  onError?: (error: ClientError) => void;
}

export interface AgentClient {
  /** POST /api/agent/[id] RPC command (prompt/abort/steer/compact/...). */
  sendCommand<T = unknown>(sessionId: string, command: Record<string, unknown>): Promise<T>;
  /** Per-session SSE event stream. */
  subscribeSessionEvents(sessionId: string, handlers: AgentSessionEvents): EventSubscription;
  /** Sidebar running-session id stream. */
  subscribeRunningSessions(handlers: {
    onIds?: (ids: string[]) => void;
    onError?: (error: ClientError) => void;
  }): EventSubscription;
}

export interface SessionClient {
  list(): Promise<SessionInfo[]>;
  getContext(sessionId: string, leafId?: string | null): Promise<unknown>;
  rename(sessionId: string, name: string): Promise<void>;
  archive(sessionId: string): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

/**
 * Cross-component session-change channel (5.0 W1: the "sessions changed on
 * disk" side-channel is part of the client contract so adapters own it).
 */
export interface SystemClient {
  subscribeSessionsChanged(listener: (sessionIds: string[]) => void): () => void;
}

/** GET /api/github/status payload (repo + branch state). */
export interface GitHubStatusPayload {
  repo?: GitHubRepoStatus | null;
  git?: GitHubRepoStatus["git"];
  /** Why the repo is empty: "workspace_not_allowed" | "not_github" | undefined. */
  reason?: "workspace_not_allowed" | "not_github";
}

/** Git domain (doc 16 route 1 surface; route 10 swaps the backing to Rust). */
export interface GitClient {
  /** GET /api/github/status?cwd=&refresh= — workspace repo/branch state. */
  status(cwd: string, options?: { refresh?: boolean }): Promise<GitHubStatusPayload>;
  /** GET /api/git/status?cwd= — local working-tree changes (files + counts). */
  changes(cwd: string): Promise<GitStatusResponse>;
  /** POST /api/git/commit — commit workspace changes; resolves { hash? }. */
  commit(cwd: string, message: string): Promise<{ hash?: string }>;
  /** POST /api/git/push — push current branch; resolves { branch? }. */
  push(cwd: string): Promise<{ branch?: string }>;
  branches(cwd: string): Promise<{ name: string; current: boolean }[]>;
  checkout(cwd: string, branch: string): Promise<{ branch?: string }>;
  /** GET /api/git/log?cwd=&limit= — commit history + graph geometry. */
  log(cwd: string, limit?: number): Promise<{ rows: GitGraphRow[]; maxLane: number }>;
  /** GET /api/git/diff?cwd=&hash=&file= — per-file diff of one commit. */
  commitDiff(cwd: string, hash: string, file: string): Promise<GitCommitFileDiff>;
}
/**
 * Native OMP settings (GET /api/omp-settings): the ~/.omp/agent/config.yml
 * shape. Read-only surface — consumers needing the settings without a
 * settings panel (e.g. the compaction strategy label).
 */
export interface OmpSettingsClient {
  /** GET /api/omp-settings — current settings document. */
  list(): Promise<{ path: string; settings: NativeSettings }>;
}

/** One schema-driven native setting (GET /api/native-settings). */
export interface NativeSettingRow {
  key: string;
  value: unknown;
  type: string;
  description?: string;
  redacted?: boolean;
}

/** Native OMP settings domain (5.1): schema-driven full config via the omp
 *  CLI, proxied by /api/native-settings. Transport-agnostic like git above. */
export interface NativeSettingsClient {
  /** GET /api/native-settings — full schema + configured values. */
  list(): Promise<{ settings: NativeSettingRow[]; path: string | null }>;
  /** PUT /api/native-settings — write one key via `omp config set`. */
  set(key: string, value: unknown): Promise<{ ok: boolean }>;
  /** POST /api/native-settings — reset one key to OMP's schema default. */
  reset(key: string): Promise<{ ok: boolean }>;
}

/** Create/update input for a scheduler entry (subset of the entry fields). */
export interface SchedulerInput {
  name?: string;
  script: string;
  args?: string[];
  schedule: ScheduleSpec;
  enabled?: boolean;
  timeoutMs?: number;
}
/** Partial update for PATCH /api/schedulers/[id] — any subset of the fields. */
export interface SchedulerPatch {
  name?: string;
  script?: string;
  args?: string[];
  schedule?: ScheduleSpec;
  enabled?: boolean;
  timeoutMs?: number;
}
/** Script-scheduler domain: store CRUD, manual run, script-path validation,
 *  next-run preview. All routes answer raw bodies (no {success,data} envelope). */
export interface SchedulerClient {
  /** GET /api/schedulers — every entry with live run state plus the engine's
   * process-start time (used to ignore stale pre-restart failures). */
  list(): Promise<{ schedulers: SchedulerWithState[]; engineStartedAt: string }>;
  /** POST /api/schedulers — create; 400 with a stable code on validation failure. */
  create(input: SchedulerInput): Promise<{ scheduler: SchedulerWithState }>;
  /** PATCH /api/schedulers/[id] — any subset of the entry fields. */
  update(id: string, input: SchedulerPatch): Promise<{ scheduler: SchedulerWithState }>;
  /** DELETE /api/schedulers/[id]. */
  remove(id: string): Promise<{ success: boolean }>;
  /** POST /api/schedulers/[id]/run — immediate manual run; 409 while one is active. */
  runNow(id: string): Promise<{ started: boolean }>;
  /** POST /api/schedulers/[id]/clear-runs — empty the run history. */
  clearRuns(id: string): Promise<{ success: boolean }>;
  /** POST /api/schedulers/preview — human description + next run for a spec. */
  preview(schedule: ScheduleSpec): Promise<{ ok: boolean; human: string; nextRunAt: string | null }>;
  /** POST /api/schedulers/validate — script path check (exists + runnable). */
  validateScript(script: string): Promise<{ ok: boolean; path?: string; shell?: string }>;
}

/** Chat event actions (chat-event-actions.json): named actions fired on chat
 *  lifecycle events. Store CRUD only — firing happens server-side in the RPC
 *  frame loop; the client only receives notification frames over SSE. All
 *  routes answer raw bodies (no {success,data} envelope). */
export interface ChatEventActionClient {
  /** GET /api/chat-event-actions. */
  list(): Promise<{ actions: ChatEventAction[] }>;
  /** POST /api/chat-event-actions — create; 400 with a stable code on
   *  validation failure (name/events/http/bash/scheduled). */
  create(input: ChatEventActionInput): Promise<{ action: ChatEventAction }>;
  /** PATCH /api/chat-event-actions/[id] — any subset, re-validated. */
  update(id: string, input: ChatEventActionPatch): Promise<{ action: ChatEventAction }>;
  /** DELETE /api/chat-event-actions/[id]. */
  remove(id: string): Promise<{ success: boolean }>;
  /** POST /api/chat-event-actions/test — run one spec once, return its
   *  outcome. Optional (fixture/remote adapters may omit it). */
  test?(input: { action: ActionSpec }): Promise<{ ok: boolean; detail?: string }>;
}

export interface OmpwebClient {
  agent: AgentClient;
  sessions: SessionClient;
  system: SystemClient;
  git: GitClient;
  ompSettings: OmpSettingsClient;
  nativeSettings: NativeSettingsClient;
  schedulers: SchedulerClient;
  chatActions: ChatEventActionClient;
}
