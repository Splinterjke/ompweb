// HttpSseAdapter: the 4.x-faithful OmpwebClient implementation over Next API
// routes + EventSource (doc 01 Slice 2). Behavior mirrors the existing call
// sites exactly — same endpoints, same envelope parsing, same error mapping —
// so useAgentSession can consume the interface without behavior change.

import type {
  AgentClient,
  AgentSessionEvents,
  ChatEventActionClient,
  EventSubscription,
  OmpwebClient,
  SessionClient,
  SubscriptionState,
  SystemClient,
} from "./types";
import { toClientError } from "./types";
import type {
  GitClient,
  GitHubStatusPayload,
  NativeSettingsClient,
  NativeSettingRow,
  OmpSettingsClient,
  SchedulerClient,
  SchedulerInput,
  SchedulerPatch,
} from "./types";
import type { ScheduleSpec } from "@/lib/schedule";
import type { SchedulerWithState } from "@/lib/scheduler-types";
import type { ActionSpec, ChatEventAction, ChatEventActionInput, ChatEventActionPatch } from "@/lib/chat-event-action-types";
import type { SessionInfo } from "@/lib/types";
import type { GitCommitFileDiff, GitGraphRow } from "@/lib/git-log";
import type { NativeSettings } from "@/lib/omp/settings-config";
import { subscribeSessionsChanged } from "../session-change-bus";

/** Same envelope contract as lib/agent-client.ts. */
interface ApiBody<T> {
  success?: boolean;
  data?: T;
  error?: string;
  code?: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as ApiBody<T>;
  if (!res.ok || body.error) throw toClientError(body, res.status);
  return body.data as T;
}

class SseSubscription implements EventSubscription {
  private es: EventSource | null;
  #state: SubscriptionState = "connecting";
  #userClosed = false;
  constructor(
    url: string,
    private handlers: { onOpen?: () => void; onFatalClose?: () => void },
    wire: (es: EventSource) => void,
  ) {
    this.es = new EventSource(url);
    this.es.onopen = () => {
      this.#state = "open";
      this.handlers.onOpen?.();
    };
    wire(this.es);
    this.es.onerror = () => {
      // EventSource retries by itself; surface state but keep the handle.
      const fatal = this.#userClosed || this.es?.readyState === EventSource.CLOSED;
      this.#state = fatal ? "closed" : "connecting";
      if (fatal && !this.#userClosed) this.handlers.onFatalClose?.();
    };
  }
  get state(): SubscriptionState {
    return this.#state;
  }
  get isOpen(): boolean {
    return this.es?.readyState === EventSource.OPEN;
  }
  get lastCursor(): null {
    return null;
  }
  close(): void {
    // Deliberate close is NOT a fatal down (mirrors EventSource semantics:
    // close() does not fire onerror).
    this.#userClosed = true;
    this.es?.close();
    this.es = null;
    this.#state = "closed";
  }
  resync(): void {
    // 4.x SSE has no replay: resync == reconnect.
    const url = this.es?.url;
    if (url) {
      this.close();
      // Recreated by the owning hook when it observes state === "closed".
    }
  }
}

class HttpAgentClient implements AgentClient {
  async sendCommand<T = unknown>(sessionId: string, command: Record<string, unknown>): Promise<T> {
    return request<T>(`/api/agent/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
  }
  subscribeSessionEvents(sessionId: string, handlers: AgentSessionEvents): EventSubscription {
    return new SseSubscription(
      `/api/agent/${encodeURIComponent(sessionId)}/events`,
      { onOpen: () => handlers.onOpen?.(), onFatalClose: () => handlers.onDown?.({ fatal: true }) },
      (es) => {
        es.onmessage = (ev) => {
          let frame: unknown;
          try {
            frame = JSON.parse(ev.data);
          } catch {
            handlers.onError?.({ code: "invalid_json", message: "Malformed SSE frame", retryable: false });
            return;
          }
          const type = (frame as { type?: string }).type;
          if (type === "connected") handlers.onConnected?.(frame as never);
          else if (type === "session_destroyed") handlers.onDestroyed?.(frame as never);
          else handlers.onEvent?.(frame as never);
        };
      },
    );
  }
  subscribeRunningSessions(handlers: { onIds?: (ids: string[]) => void; onError?: (error: never) => void }): EventSubscription {
    return new SseSubscription(
      "/api/agent/running/events",
      {},
      (es) => {
        es.onmessage = (ev) => {
          try {
            const frame = JSON.parse(ev.data) as { type?: string; runningSessionIds?: string[] };
            if (frame.type === "running" && Array.isArray(frame.runningSessionIds)) {
              handlers.onIds?.(frame.runningSessionIds);
            }
          } catch {
            /* tolerate malformed keepalives */
          }
        };
      },
    );
  }
}

class HttpSessionClient implements SessionClient {
  async list(): Promise<SessionInfo[]> {
    // The list route answers a raw body ({sessions, runningSessionIds}) —
    // NOT the {success,data} envelope; the adapter maps it faithfully.
    const res = await fetch("/api/sessions", { cache: "no-store" });
    const body = (await res.json().catch(() => ({}))) as
      | SessionInfo[]
      | { sessions?: SessionInfo[]; error?: string; code?: string };
    if (!res.ok || (!Array.isArray(body) && body.error)) {
      throw toClientError(Array.isArray(body) ? {} : body, res.status);
    }
    if (Array.isArray(body)) return body;
    return Array.isArray(body.sessions) ? body.sessions : [];
  }
  async getContext(sessionId: string, leafId?: string | null): Promise<unknown> {
    const query = leafId ? `?leafId=${encodeURIComponent(leafId)}` : "";
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/context${query}`, { cache: "no-store" });
    // The context route answers a raw `{ context }` body (no envelope).
    const body = (await res.json().catch(() => ({}))) as { context?: unknown; data?: unknown; error?: string; code?: string };
    if (!res.ok || body.error) throw toClientError(body, res.status);
    if (body.context !== undefined) return body.context;
    if (body.data !== undefined) return body.data;
    return body;
  }
  async rename(sessionId: string, name: string): Promise<void> {
    await request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  }
  async archive(sessionId: string): Promise<void> {
    await request(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, { method: "POST" });
  }
  async delete(sessionId: string): Promise<void> {
    await request(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  }
}

class HttpSystemClient implements SystemClient {
  subscribeSessionsChanged(listener: (sessionIds: string[]) => void): () => void {
    return subscribeSessionsChanged(listener);
  }
}

/** Raw-body helpers: the git routes answer payloads WITHOUT the
 * {success,data} envelope (mirroring the legacy component call sites). */
async function rawRequest<T extends { error?: string }>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as T;
  if (!res.ok || body.error) throw toClientError(body, res.status);
  return body;
}

class HttpGitClient implements GitClient {
  async status(cwd: string, options: { refresh?: boolean } = {}): Promise<GitHubStatusPayload> {
    const refresh = options.refresh ? "&refresh=1" : "";
    // rawRequest already threw on body.error; strip the field for the typed
    // payload surface.
    const body = await rawRequest<GitHubStatusPayload & { error?: string }>(
      `/api/github/status?cwd=${encodeURIComponent(cwd)}${refresh}`,
      { cache: "no-store" },
    );
    delete (body as { error?: string }).error;
    return body;
  }
  async commit(cwd: string, message: string): Promise<{ hash?: string }> {
    return rawRequest<{ hash?: string; error?: string }>("/api/git/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, message }),
    });
  }
  async push(cwd: string): Promise<{ branch?: string }> {
    return rawRequest<{ branch?: string; error?: string }>("/api/git/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
  }
  async branches(cwd: string): Promise<{ name: string; current: boolean }[]> {
    const body = await rawRequest<{ branches?: { name: string; current: boolean }[]; error?: string }>(`/api/git/branches?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
    return body.branches ?? [];
  }
  async checkout(cwd: string, branch: string): Promise<{ branch?: string }> {
    return rawRequest<{ branch?: string; error?: string }>("/api/git/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, branch }) });
  }
  async log(cwd: string, limit = 400): Promise<{ rows: GitGraphRow[]; maxLane: number }> {
    const body = await rawRequest<{ rows?: GitGraphRow[]; maxLane?: number; error?: string }>(`/api/git/log?cwd=${encodeURIComponent(cwd)}&limit=${Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 400}`, { cache: "no-store" });
    return { rows: body.rows ?? [], maxLane: body.maxLane ?? 1 };
  }
  async commitDiff(cwd: string, hash: string, file: string): Promise<GitCommitFileDiff> {
    return rawRequest<GitCommitFileDiff & { error?: string }>(`/api/git/diff?cwd=${encodeURIComponent(cwd)}&hash=${encodeURIComponent(hash)}&file=${encodeURIComponent(file)}`, { cache: "no-store" });
  }
}

/** Schema-driven native OMP settings (5.1) — /api/native-settings proxies the
 *  omp CLI so config.yml writes and schema validation stay in OMP. */
class HttpNativeSettingsClient implements NativeSettingsClient {
  async list(): Promise<{ settings: NativeSettingRow[]; path: string | null }> {
    const body = await rawRequest<{ settings?: NativeSettingRow[]; path?: string | null; error?: string }>("/api/native-settings", { cache: "no-store" });
    return { settings: body.settings ?? [], path: body.path ?? null };
  }
  async set(key: string, value: unknown): Promise<{ ok: boolean }> {
    await rawRequest<{ error?: string }>("/api/native-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
    return { ok: true };
  }
  async reset(key: string): Promise<{ ok: boolean }> {
    await rawRequest<{ error?: string }>("/api/native-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    return { ok: true };
  }
}

/** Script schedulers — /api/schedulers* answer raw bodies like the git routes. */
class HttpSchedulerClient implements SchedulerClient {
  async list(): Promise<{ schedulers: SchedulerWithState[]; engineStartedAt: string }> {
    const body = await rawRequest<{ schedulers?: SchedulerWithState[]; engineStartedAt?: string; error?: string }>("/api/schedulers", { cache: "no-store" });
    return { schedulers: body.schedulers ?? [], engineStartedAt: body.engineStartedAt ?? new Date(0).toISOString() };
  }
  async create(input: SchedulerInput): Promise<{ scheduler: SchedulerWithState }> {
    const body = await rawRequest<{ scheduler?: SchedulerWithState; error?: string }>("/api/schedulers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!body.scheduler) throw toClientError(body, 500);
    return { scheduler: body.scheduler };
  }
  async update(id: string, input: SchedulerPatch): Promise<{ scheduler: SchedulerWithState }> {
    const body = await rawRequest<{ scheduler?: SchedulerWithState; error?: string }>(`/api/schedulers/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!body.scheduler) throw toClientError(body, 500);
    return { scheduler: body.scheduler };
  }
  async remove(id: string): Promise<{ success: boolean }> {
    await rawRequest<{ error?: string }>(`/api/schedulers/${encodeURIComponent(id)}`, { method: "DELETE" });
    return { success: true };
  }
  async runNow(id: string): Promise<{ started: boolean }> {
    const body = await rawRequest<{ started?: boolean; error?: string }>(`/api/schedulers/${encodeURIComponent(id)}/run`, { method: "POST" });
    if (!body.started) throw toClientError(body, 500);
    return { started: true };
  }
  async clearRuns(id: string): Promise<{ success: boolean }> {
    await rawRequest<{ error?: string }>(`/api/schedulers/${encodeURIComponent(id)}/clear-runs`, { method: "POST" });
    return { success: true };
  }
  async preview(schedule: ScheduleSpec): Promise<{ ok: boolean; human: string; nextRunAt: string | null }> {
    const res = await fetch("/api/schedulers/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schedule }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; human?: string; nextRunAt?: string | null; error?: string };
    if (!res.ok || !body.ok) {
      // The 400 body carries the schedule error code in `error` (no `code` field).
      throw toClientError({ code: body.error, error: body.error ?? "invalid_schedule" }, res.status);
    }
    return { ok: true, human: body.human ?? "", nextRunAt: body.nextRunAt ?? null };
  }
  async validateScript(script: string): Promise<{ ok: boolean; path?: string; shell?: string }> {
    const res = await fetch("/api/schedulers/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; path?: string; shell?: string; error?: string };
    if (!res.ok || !body.ok) {
      // The 400 body carries the validation code in `error` (no `code` field).
      throw toClientError({ code: body.error, error: body.error ?? "invalid_request" }, res.status);
    }
    return { ok: true, path: body.path, shell: body.shell };
  }
}

/** Chat event actions — /api/chat-event-actions* answer raw bodies like the
 *  git routes. */
class HttpChatEventActionClient implements ChatEventActionClient {
  async list(): Promise<{ actions: ChatEventAction[] }> {
    const body = await rawRequest<{ actions?: ChatEventAction[]; error?: string }>("/api/chat-event-actions", { cache: "no-store" });
    return { actions: body.actions ?? [] };
  }
  async create(input: ChatEventActionInput): Promise<{ action: ChatEventAction }> {
    const body = await rawRequest<{ action?: ChatEventAction; error?: string; code?: string }>("/api/chat-event-actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!body.action) throw toClientError(body, 500);
    return { action: body.action };
  }
  async update(id: string, input: ChatEventActionPatch): Promise<{ action: ChatEventAction }> {
    const body = await rawRequest<{ action?: ChatEventAction; error?: string; code?: string }>(`/api/chat-event-actions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!body.action) throw toClientError(body, 500);
    return { action: body.action };
  }
  async remove(id: string): Promise<{ success: boolean }> {
    await rawRequest<{ error?: string }>(`/api/chat-event-actions/${encodeURIComponent(id)}`, { method: "DELETE" });
    return { success: true };
  }
  async test(input: { action: ActionSpec }): Promise<{ ok: boolean; detail?: string }> {
    const body = await rawRequest<{ ok?: boolean; detail?: string; error?: string; code?: string }>("/api/chat-event-actions/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (typeof body.ok !== "boolean") throw toClientError(body, 500);
    return { ok: body.ok, ...(body.detail ? { detail: body.detail } : {}) };
  }
}
/** Native OMP settings (GET /api/omp-settings) — the config.yml shape, read-only. */
class HttpOmpSettingsClient implements OmpSettingsClient {
  async list(): Promise<{ path: string; settings: NativeSettings }> {
    const body = await rawRequest<{ path?: string; settings?: NativeSettings; error?: string }>("/api/omp-settings", { cache: "no-store" });
    return { path: body.path ?? "", settings: body.settings ?? {} };
  }
}

export function createHttpSseClient(): OmpwebClient {
  return {
    agent: new HttpAgentClient(),
    sessions: new HttpSessionClient(),
    system: new HttpSystemClient(),
    git: new HttpGitClient(),
    ompSettings: new HttpOmpSettingsClient(),
    nativeSettings: new HttpNativeSettingsClient(),
    schedulers: new HttpSchedulerClient(),
    chatActions: new HttpChatEventActionClient(),
  };
}
