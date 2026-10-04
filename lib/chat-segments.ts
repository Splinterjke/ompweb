/**
 * Transcript segment planning (upstream port of chat-transcript-plan.ts).
 *
 * Splits one anchored turn into visible text segments and foldable
 * activity segments. Like the omp TUI, agent text is never hidden —
 * each run of activity (thinking, tool calls, notices) between two
 * pieces of text folds into one collapsed row.
 *
 * Pure logic; no JSX. Injectable displayable-blocks predicate so
 * node:test can drive every path without pulling in React.
 */

import type { AssistantContentBlock, AssistantMessage, CustomMessage, AgentMessage } from "./types";

/** A folded activity entry: listed blocks of an assistant message, or a whole non-assistant message. */
export interface ActivityPiece {
  /** Message index in the messages array. */
  index: number;
  /** Subset of the assistant message's content blocks (absent for non-assistant pieces). */
  blocks?: AssistantContentBlock[];
}

export type TranscriptSegment =
  /** Visible agent text/images from one assistant message. `last` marks
   *  text that ends its message; only that segment carries usage and error. */
  | { kind: "text"; index: number; blocks: AssistantContentBlock[]; last: boolean }
  | { kind: "activity"; pieces: ActivityPiece[]; stepCount: number; toolCallCount: number };

export interface PlanOptions {
  /** Mirrors omp's `hideThinkingBlock`: drop thinking blocks entirely. */
  hideThinking?: boolean;
}

// A user message normally anchors a turn. When compaction fires mid-turn,
// the original user prompt is dropped and a compaction summary (role
// "custom", customType "compaction") is inserted in its place; the agent
// then keeps producing tool calls and answers with no user message left
// to anchor them. Treat a compaction summary as an anchor too, otherwise
// every post-compaction message renders standalone and never folds.
export function isGroupAnchor(message: AgentMessage): boolean {
  if (message.role === "user") return true;
  return message.role === "custom" && (message as CustomMessage).customType === "compaction";
}

/** Filter out empty non-deferred non-streaming thinking blocks. */
function displayableBlocks(message: AssistantMessage, hideThinking: boolean): AssistantContentBlock[] {
  return (message.content ?? []).filter((block) => {
    if (block.type === "thinking") {
      if (hideThinking) return false;
      // Empty, non-deferred, non-streaming thinking blocks are invisible.
      return block.deferred || !!block.thinking?.trim();
    }
    return true;
  });
}

/** Split one anchored turn into text and folded-activity segments. */
export function planTurnSegments(
  messages: AgentMessage[],
  userIdx: number,
  endIdx: number,
  options: PlanOptions = {},
): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let activity: Extract<TranscriptSegment, { kind: "activity" }> | null = null;
  const addActivity = (piece: ActivityPiece, toolCalls: number) => {
    if (!activity) {
      activity = { kind: "activity", pieces: [], stepCount: 0, toolCallCount: 0 };
      segments.push(activity);
    }
    activity.pieces.push(piece);
    activity.stepCount += 1;
    activity.toolCallCount += toolCalls;
  };

  for (let idx = userIdx + 1; idx < endIdx; idx++) {
    const msg = messages[idx];
    // Tool results render inline under their tool call inside the fold.
    if (msg.role === "toolResult") continue;
    // Mount notices never render; counting them would show an empty fold.
    if (msg.role === "custom" && (msg as CustomMessage).customType === "xdev-mount-notice") continue;
    if (msg.role !== "assistant") {
      // Job results, reminders, and other notices are activity, as in the TUI.
      addActivity({ index: idx }, 0);
      continue;
    }
    const assistant = msg as AssistantMessage;
    const blocks = displayableBlocks(assistant, options.hideThinking ?? false);
    let lastText: Extract<TranscriptSegment, { kind: "text" }> | null = null;
    let text: AssistantContentBlock[] = [];
    let other: AssistantContentBlock[] = [];
    const flushText = () => {
      if (text.length === 0) return;
      lastText = { kind: "text", index: idx, blocks: text, last: false };
      segments.push(lastText);
      activity = null;
      text = [];
    };
    const flushOther = () => {
      if (other.length === 0) return;
      addActivity({ index: idx, blocks: other }, other.filter((block) => block.type === "toolCall").length);
      other = [];
    };
    for (const block of blocks) {
      if (block.type === "image" || (block.type === "text" && block.text.trim().length > 0)) {
        flushOther();
        text.push(block);
      } else if (block.type !== "text") {
        flushText();
        other.push(block);
      }
    }
    flushText();
    flushOther();
    // A provider error must stay visible: when the message ended in
    // activity, it gets its own (empty) text segment to carry the error.
    if (assistant.errorMessage?.trim() && segments.at(-1) !== lastText) {
      lastText = { kind: "text", index: idx, blocks: [], last: false };
      segments.push(lastText);
      activity = null;
    }
    // Text that ends its message carries the message's usage and error.
    if (lastText && segments.at(-1) === lastText) lastText.last = true;
  }
  return segments;
}

/**
 * True when the tail of the transcript looks mid-run, without asking the owning
 * process. omp-web receives SSE frames only for runs it spawned itself, so a
 * session driven by a separate `omp` process had no signal at all and its
 * in-progress turn was always folded into "Process details" (#136).
 *
 * Mid-run has exactly two shapes: a tool result just landed and the agent is
 * about to continue, or an assistant message ends with a tool call whose result
 * has not arrived yet. A finished turn ends in text, so it stops counting —
 * and a failed or cancelled turn is finished however its blocks are shaped.
 */
export function looksLikeRunningTurn(messages: AgentMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (!last) return false;
  if (last.role === "toolResult") return true;
  if (last.role !== "assistant") return false;
  // A failed or cancelled turn is finished however its blocks are shaped.
  if (last.errorMessage || last.stopReason === "aborted" || last.stopReason === "error") return false;
  const blocks = displayableBlocks(last as AssistantMessage, false);
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    // Whitespace-only text does not close a turn; look past it.
    if (block.type === "text" && block.text.trim().length === 0) continue;
    return block.type === "toolCall";
  }
  return false;
}
