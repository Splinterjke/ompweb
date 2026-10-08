/**
 * Passive tool context (ported from upstream chat-transcript-plan.ts, PR #220).
 *
 * omp writes rule/guidance reminders as developer messages marked
 * `passiveToolContext`. They are never a transcript row of their own: the
 * text rides on the last tool card of the tool batch it follows, exactly as
 * omp's terminal renders it. Lives apart from the segment planners so
 * session-reader, ChatWindow and MessageView can share it without a cycle.
 */

import { stripAnsi } from "./ansi";
import type { AgentMessage, AssistantMessage, CustomMessage, ToolResultMessage } from "./types";

/**
 * customType the session reader gives omp's passive tool context (developer
 * messages marked `passiveToolContext`). It is never a transcript row: its
 * text rides on the last tool card of the tool batch it follows.
 */
export const PASSIVE_TOOL_CONTEXT = "passive-tool-context";

export function isPassiveToolContext(message: AgentMessage): boolean {
  return message.role === "custom" && (message as CustomMessage).customType === PASSIVE_TOOL_CONTEXT;
}

// Long enough for any real guidance; bounds what one hostile entry puts in the DOM.
const PASSIVE_TOOL_CONTEXT_MAX = 2000;

/**
 * Display text: no ANSI, control, zero-width or bidi-override characters.
 * Line breaks and indentation survive (rule reminders carry paragraphs and code
 * blocks); trailing spaces, blank-line runs and outer blank lines are dropped.
 * Tolerates malformed content from imported or hand-edited session files.
 */
export function sanitizePassiveToolContext(content: unknown): string {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.flatMap((block) => (block?.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("\n")
      : "";
  // split/trimEnd, not a `\s+$`-style regex: those backtrack quadratically on long
  // whitespace runs, and session files are untrusted input.
  return stripAnsi(text)
    .replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .trimEnd()
    .slice(0, PASSIVE_TOOL_CONTEXT_MAX)
    .trimEnd();
}

// Keeps an attached result's identity stable across recomputes so memoized
// tool cards do not re-render for every new message.
const resultsWithContext = new WeakMap<ToolResultMessage, ToolResultMessage>();

/**
 * Index committed tool results by tool call id and attach each passive tool
 * context to the last tool call (call order) of the batch it follows, as
 * omp's terminal does. A batch stays open through its tool results; any
 * other message closes it, so context after a non-tool message is dropped
 * instead of landing on an earlier, unrelated card.
 */
export function collectToolResults(messages: AgentMessage[]): Map<string, ToolResultMessage> {
  const results = new Map<string, ToolResultMessage>();
  let lastToolCallId: string | undefined;
  for (const message of messages) {
    if (message.role === "toolResult") {
      const result = message as ToolResultMessage;
      results.set(result.toolCallId, result);
      continue;
    }
    if (message.role === "assistant") {
      lastToolCallId = undefined;
      const content = (message as AssistantMessage).content;
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type === "toolCall") lastToolCallId = block.toolCallId;
      }
      continue;
    }
    const result = lastToolCallId === undefined ? undefined : results.get(lastToolCallId);
    lastToolCallId = undefined;
    if (!result || !isPassiveToolContext(message)) continue;
    const text = sanitizePassiveToolContext((message as CustomMessage).content);
    if (!text) continue;
    let attached = resultsWithContext.get(result);
    if (attached?.passiveContext !== text) {
      attached = { ...result, passiveContext: text };
      resultsWithContext.set(result, attached);
    }
    results.set(result.toolCallId, attached);
  }
  return results;
}
