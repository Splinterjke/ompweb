// ============================================================================
// Chat event action bus — fans a `chat_event_action` frame out to every
// connected /api/agent/running/events SSE stream. Same globalThis pattern as
// lib/ui-refresh-bus.ts so it survives Next.js dev hot-reload.
//
// Used by the notification executor: the frame is delivered to the session's
// own stream (via a per-session callback the dispatcher passes in) AND to the
// running stream (here), so a browser tab attached only to the sidebar still
// receives it. The return count is how the executor tells "no browser attached"
// apart from a successful delivery.
// ============================================================================

export interface ChatEventActionFrame {
  type: "chat_event_action";
  actionId: string;
  /** The session that fired the action — the client uses it to focus/select
   *  that session when the notification is clicked. */
  sessionId: string;
  title: string;
  message: string;
}

/** A chat action executed (real or Test-button): the client refreshes the
 *  action list so the new lastRun (status dot + detail) shows without a
 *  reload. The authoritative value lives in the store; this is a nudge. */
export interface ChatActionRunFrame {
  type: "chat_action_run";
  actionId: string;
}

type Send = (frame: ChatEventActionFrame | ChatActionRunFrame) => void;

const REGISTRY_KEY = "ompweb:chat-event-action-bus" as const;

type Registry = { sends: Set<Send> };

function registry(): Registry {
  const g = globalThis as Record<string, unknown>;
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = { sends: new Set<Send>() };
  return g[REGISTRY_KEY] as Registry;
}

/**
 * Register a running-events SSE stream for chat_event_action broadcasts.
 * Returns an unsubscribe the stream must call on cleanup (abort/cancel).
 */
export function subscribeChatEventActions(send: Send): () => void {
  const entry = send;
  registry().sends.add(entry);
  return () => {
    registry().sends.delete(entry);
  };
}

/**
 * Push a chat_event_action frame to every connected running-events stream.
 * Returns the number of streams that received it (0 = no browser attached to
 * the running stream).
 */
function broadcast(frame: ChatEventActionFrame | ChatActionRunFrame): number {
  let delivered = 0;
  for (const send of registry().sends) {
    try {
      send(frame);
      delivered += 1;
    } catch {
      // controller already closed — the stream's cleanup drops it.
    }
  }
  return delivered;
}

export function broadcastChatEventAction(frame: ChatEventActionFrame): number {
  return broadcast(frame);
}

/** Push a chat_action_run nudge to every connected running-events stream so
 *  an open action panel refreshes the just-executed action's lastRun. */
export function broadcastChatActionRun(actionId: string): number {
  return broadcast({ type: "chat_action_run", actionId });
}
