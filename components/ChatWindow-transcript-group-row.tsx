"use client";

import { type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { AgentMessage, AssistantContentBlock, AssistantMessage } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { planTurnSegments, type ActivityPiece, type PlanOptions, type TranscriptSegment } from "@/lib/chat-segments";
import { Tooltip } from "./ui/primitives";

/** Renders one committed message, optionally as a partial/overridden view under its own key prefix. */
export type RenderMessage = (idx: number, options?: { attachRef?: boolean; keyPrefix?: string; messageOverride?: AgentMessage; showTimestamp?: boolean; sourceBlockIndices?: number[] }) => ReactNode;

function withAssistantBlocks(
  message: AssistantMessage,
  content: AssistantContentBlock[],
  options: { omitUsage?: boolean } = {},
): AssistantMessage {
  const next = { ...message, content };
  if (options.omitUsage) next.usage = undefined;
  return next;
}

/** One anchored turn's folded-render plan: the segment split plus the
 * message-override objects it implies. Built once per turn-content change and
 * cached by the transcript — building overrides inline produces NEW objects on
 * every render, which failed every row's memo comparator and re-rendered the
 * whole visible transcript on every token batch / tool commit (the "everything
 * refreshes when a tool ends" symptom; invisible on fresh single-turn sessions,
 * brutal on aged ones). */
export interface TurnPlan {
  /** The turn's messages at build time; identity-checked to invalidate. */
  slice: AgentMessage[];
  endIdx: number;
  /** The planning options the cache entry was built with (invalidation keys). */
  hideThinking: boolean;
  showThinking: boolean;
  showToolCalls: boolean;
  segments: TranscriptSegment[];
  /** Per text segment (indexed by segmentIdx): the split-message override. */
  textOverrides: (AssistantMessage | undefined)[];
  /** Per activity segment: one override per piece (undefined = whole message). */
  activityOverrides: Map<number, (AssistantMessage | undefined)[]>;
}

export function buildTurnPlan(messages: AgentMessage[], userIdx: number, endIdx: number, options: PlanOptions = {}): TurnPlan {
  const hideThinking = options.hideThinking ?? false;
  const showThinking = options.showThinking ?? false;
  const showToolCalls = options.showToolCalls ?? false;
  const segments = planTurnSegments(messages, userIdx, endIdx, { hideThinking, showThinking, showToolCalls });
  const textOverrides: (AssistantMessage | undefined)[] = [];
  const activityOverrides = new Map<number, (AssistantMessage | undefined)[]>();
  segments.forEach((segment, segmentIdx) => {
    if (segment.kind === "text") {
      const msg = messages[segment.index] as AssistantMessage;
      const override = withAssistantBlocks(msg, segment.blocks, { omitUsage: !segment.last });
      if (!segment.last) override.errorMessage = undefined;
      textOverrides[segmentIdx] = override;
      return;
    }
    activityOverrides.set(segmentIdx, segment.pieces.map((piece) =>
      piece.blocks
        ? { ...withAssistantBlocks(messages[piece.index] as AssistantMessage, piece.blocks, { omitUsage: true }), errorMessage: undefined }
        : undefined,
    ));
  });
  return { slice: messages.slice(userIdx, endIdx), endIdx, hideThinking, showThinking, showToolCalls, segments, textOverrides, activityOverrides };
}

/** Render a folded activity run exactly as it streamed: one entry per piece, never merged across messages. */
export function renderActivityPieces(messages: AgentMessage[], pieces: ActivityPiece[], renderMessage: RenderMessage, overrides?: (AssistantMessage | undefined)[]): ReactNode[] {
  return pieces.map((piece, pieceIdx) => {
    if (!piece.blocks) return renderMessage(piece.index, { attachRef: false, keyPrefix: "activity" });
    const msg = messages[piece.index] as AssistantMessage;
    return renderMessage(piece.index, {
      attachRef: false,
      keyPrefix: `activity-${pieceIdx}`,
      messageOverride: overrides?.[pieceIdx] ?? { ...withAssistantBlocks(msg, piece.blocks, { omitUsage: true }), errorMessage: undefined },
      showTimestamp: false,
      sourceBlockIndices: piece.blocks.map((block) => msg.content.indexOf(block)),
    });
  });
}

function ProcessDetailsGroup({ messageCount, toolCallCount, expanded, onToggle, children }: { messageCount: number; toolCallCount: number; expanded: boolean; onToggle: (expanded: boolean) => void; children: ReactNode }) {
  const { t, tn } = useI18n();
  const parts = [t("chatWindow.processDetails"), tn("chatWindow.messageCount", messageCount)];
  if (toolCallCount > 0) parts.push(tn("chatWindow.toolCallCount", toolCallCount));

  return (
    <div style={{ marginBottom: 4 }}>
      <Tooltip content={expanded ? t("chatWindow.collapseProcessDetails") : t("chatWindow.expandProcessDetails")}>
        <button
        type="button"
        aria-expanded={expanded}
        onClick={() => onToggle(!expanded)}
        className="process-details-toggle"
      >
        <ChevronDown
          size={12}
          strokeWidth={1.8}
          aria-hidden="true"
          style={{
            flexShrink: 0,
            transform: expanded ? "rotate(180deg)" : "none",
            transition: "transform var(--dur-fast) var(--ease-out-warm)",
          }}
        />
        <span className="process-details-label">
          {parts.join(" · ")}
        </span>
      </button>
      </Tooltip>
      {expanded && (
        <div style={{ marginTop: 3 }}>
          {children}
        </div>
      )}
    </div>
  );
}

/** What `renderTranscriptGroupRow` needs from the committed transcript. */
export interface TranscriptGroupRowContext {
  messages: AgentMessage[];
  /** The turn's first message (the user prompt). */
  userIdx: number;
  /** The turn's cached folded-render plan (`buildTurnPlan`). */
  plan: TurnPlan;
  renderMessage: RenderMessage;
  /** Stable identity of the turn (its anchor entry id): keys the rows and the folds. */
  entryKey: string;
  messageRefs: React.RefObject<(HTMLDivElement | null)[]>;
  visibleRefIndexByMessage: Map<number, number>;
  /** Process-details fold state, keyed by the segment's fold key. */
  isExpanded: (foldKey: string) => boolean;
  onToggle: (foldKey: string, expanded: boolean) => void;
}

/** Render one anchored user turn as keyed transcript entries: the visible text
 *  segments and each run of activity folded into a Process details row.
 *  (The fork's virtualized-transcript counterpart of upstream's
 *  `renderTranscriptGroupRow`: the live-tail flat path and the per-turn plan
 *  cache stay with the caller.) */
export function renderTranscriptGroupRow({
  messages, userIdx, plan, renderMessage, entryKey, messageRefs, visibleRefIndexByMessage, isExpanded, onToggle,
}: TranscriptGroupRowContext): ReactNode[] {
  const nodes: ReactNode[] = [renderMessage(userIdx)];
  const attached = new Set<number>();
  plan.segments.forEach((segment, segmentIdx) => {
    if (segment.kind === "text") {
      const msg = messages[segment.index] as AssistantMessage;
      const override = plan.textOverrides[segmentIdx];
      nodes.push(renderMessage(segment.index, {
        attachRef: !attached.has(segment.index),
        keyPrefix: `text-${segmentIdx}`,
        messageOverride: override,
        ...(segment.last ? {} : { showTimestamp: false }),
        // Thinking can ride in a text segment; deferred text loads by source index.
        sourceBlockIndices: segment.blocks.map((block) => msg.content.indexOf(block)),
      }));
      attached.add(segment.index);
      return;
    }
    const foldKey = `${entryKey}:${segmentIdx}`;
    const refIdx = segment.pieces
      .filter((p) => !attached.has(p.index))
      .map((p) => visibleRefIndexByMessage.get(p.index))
      .find((value): value is number => typeof value === "number");
    for (const p of segment.pieces) attached.add(p.index);
    nodes.push(
      <div
        key={"activity-" + entryKey + "-" + segmentIdx}
        ref={refIdx === undefined ? undefined : (el) => { messageRefs.current[refIdx] = el; }}
      >
        <ProcessDetailsGroup
          messageCount={segment.stepCount}
          toolCallCount={segment.toolCallCount}
          expanded={isExpanded(foldKey)}
          onToggle={(next) => onToggle(foldKey, next)}
        >
          {renderActivityPieces(messages, segment.pieces, renderMessage, plan.activityOverrides.get(segmentIdx))}
        </ProcessDetailsGroup>
      </div>,
    );
  });
  return nodes;
}
