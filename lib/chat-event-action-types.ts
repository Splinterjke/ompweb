// Chat event actions: user-defined actions that fire on chat lifecycle
// events (docs/chat-event-actions-plan.md). The model mirrors the scheduler
// store (lib/scheduler-store.ts): a versioned JSON file in the agent dir.

/** The nine chat lifecycle events an action can bind to. The single source
 * of truth for the modal's event list and the i18n keys
 * (`chatActions.event.<type>`). */
export type ChatEventType =
  | "conversation_completed"
  | "conversation_interrupted"
  | "assistant_text"
  | "thinking_completed"
  | "subagent_completed"
  | "user_prompt_sent"
  | "provider_api_error"
  | "task_completed"
  | "context_compacted";

export const CHAT_EVENT_TYPES: ChatEventType[] = [
  "conversation_completed",
  "conversation_interrupted",
  "assistant_text",
  "thinking_completed",
  "subagent_completed",
  "user_prompt_sent",
  "provider_api_error",
  "task_completed",
  "context_compacted",
];

export type ChatEventActionType = "notification" | "http" | "bash" | "scheduled";

export type HttpActionSpec = {
  type: "http";
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  url: string;
  body?: string;
  /** Only meaningful for POST/PUT (defaults to "json"). */
  bodyContentType?: "json" | "xml" | "text";
  /** One "Name: value" per line; blank/malformed lines skipped, first wins. */
  headers?: string;
};

export type BashActionSpec = {
  type: "bash";
  /** Reuses the scheduler's path validation (exists + regular file; .sh via
   * bash, else must be executable). Wins over scriptText when both are set. */
  scriptPath?: string;
  /** Inline script text, run via bash from a temp file. */
  scriptText?: string;
};

export type ScheduledActionSpec = {
  type: "scheduled";
  /** Id of an entry in schedulers.json. */
  schedulerId: string;
};

export type NotificationActionSpec = {
  type: "notification";
  title?: string;
  message?: string;
};

export type ActionSpec = NotificationActionSpec | HttpActionSpec | BashActionSpec | ScheduledActionSpec;

/** One recorded action run (the panel's "last run" row). */
export interface ChatActionRun {
  at: string;
  ok: boolean;
  detail?: string;
}

export interface ChatEventAction {
  id: string;
  name: string;
  /** >= 1, subset of CHAT_EVENT_TYPES. */
  events: ChatEventType[];
  enabled: boolean;
  action: ActionSpec;
  createdAt: string;
  updatedAt: string;
  lastRun?: ChatActionRun;
}

/** Partial update for PATCH — any subset of the create fields; an absent
 *  field keeps the stored value. */
export interface ChatEventActionPatch {
  name?: string;
  events?: ChatEventType[];
  action?: ActionSpec;
  enabled?: boolean;
}

/** Create input (name required; events and action are re-validated). */
export interface ChatEventActionInput {
  name: string;
  events: ChatEventType[];
  action: ActionSpec;
  enabled?: boolean;
}

export interface ChatEventActionFile {
  version: 1;
  actions: ChatEventAction[];
}
