import { loadActionsForEvent } from "./chat-event-action-store";
import { executeChatAction, type ChatEventPayload } from "./chat-event-actions-executors";
import type { ChatEventType } from "./chat-event-action-types";

export type { ChatEventPayload };

// ============================================================================
// Chat event action dispatcher: the single entry point the RPC frame loop
// (lib/rpc-manager.ts) calls when a chat lifecycle event fires.
//
// Contract (docs/chat-event-actions-plan.md §3 task 3):
//  - loads the enabled actions bound to the event type (pre-filtered +
//    cached in the store, invalidated on every save);
//  - fires each executor FIRE-AND-FORGET — a frame handler must never block
//    on action execution, and one action's failure must not affect others;
//  - NEVER throws into the frame loop (everything is wrapped internally).
//
// provider_api_error arrives as two possible frames (the synthesized
// prompt_error and a level: error notice); the per-run dedupe flag makes the
// FIRST one win and suppresses the second until the next run.
// ============================================================================

declare global {
  var __ompChatActionRunState: Map<string, { apiErrorFired: boolean }> | undefined;
}

function runState(sessionId: string): { apiErrorFired: boolean } {
  const g = globalThis as { __ompChatActionRunState?: Map<string, { apiErrorFired: boolean }> };
  if (!g.__ompChatActionRunState) g.__ompChatActionRunState = new Map();
  const map = g.__ompChatActionRunState!;
  let entry = map.get(sessionId);
  if (!entry) {
    entry = { apiErrorFired: false };
    map.set(sessionId, entry);
  }
  return entry;
}

/** Drop the per-run state for a session (called on terminal events so a
 *  dead session cannot accumulate entries). */
export function clearChatActionRunState(sessionId: string): void {
  const g = globalThis as { __ompChatActionRunState?: Map<string, { apiErrorFired: boolean }> };
  g.__ompChatActionRunState?.delete(sessionId);
}

/**
 * Dispatch one chat event to every enabled action bound to it.
 * Fire-and-forget: returns immediately; executors run asynchronously and
 * record their own lastRun. Safe to call from the frame loop — it cannot
 * throw.
 */
export function dispatchChatEvent(type: ChatEventType, payload: ChatEventPayload): void {
  try {
    // A new run started: the previous run's error dedupe must not leak into
    // this one.
    if (type === "user_prompt_sent") {
      clearChatActionRunState(payload.sessionId);
    }
    // The dedupe flag is only meaningful for provider_api_error: the two
    // possible source frames both map to it, and the first to arrive wins.
    if (type === "provider_api_error") {
      const state = runState(payload.sessionId);
      if (state.apiErrorFired) return;
      state.apiErrorFired = true;
    }
    const actions = loadActionsForEvent(type);
    if (actions.length === 0) return;
    for (const action of actions) {
      // Each action in its own guard: an executor throwing (it shouldn't —
      // executeChatAction wraps internally, but the store read or a future
      // code path might) must not skip the remaining actions.
      try {
        void executeChatAction(action, payload);
      } catch {
        /* isolated above; belt and braces */
      }
    }
  } catch {
    // The dispatcher is best-effort by contract: a frame handler must never
    // see an exception from here.
  }
}

/**
 * The frame-derived events, expressed as the mapping table from the plan:
 *  - user_prompt_sent            ← agent_start
 *  - conversation_completed      ← terminal agent_end (isTerminal !== false)
 *  - conversation_interrupted    ← abort / abort_and_prompt RPC command
 *  - provider_api_error          ← synthesized prompt_error / notice(level:error)
 *  - thinking_completed          ← message_end containing a thinking block
 *  - assistant_text              ← message_end for an assistant message with a text block
 *  - subagent_completed          ← subagent_lifecycle with a terminal status
 *
 * `payload` carries at least `sessionId` (plus the session display name for
 * the notification defaults and `emitToSession` for the notification frame's
 * per-session delivery). Extra keys are ignored by the executors.
 */
