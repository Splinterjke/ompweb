"use client";

import type { AgentMessage, BashExecutionMessage, ToolResultMessage } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import type { MessageTimeFormat } from "./AppShell";
import { MessageView } from "./MessageView";
import { OmpBouncingLetter } from "./OmpBouncingLetter";

/** What `ChatLiveTail` needs from `ChatWindow`: the not-yet-committed end of the running turn. */
export interface ChatLiveTailProps {
  /** The reply omp is streaming, shown while the run is live. */
  streamingMessage: Partial<AgentMessage> | null;
  /** Render the streaming bubble only while the run actually streams. */
  isStreaming: boolean;
  /** Live token rate for the streaming bubble (omp's measured speed). */
  tokensPerSecond?: number | null;
  /** Running tools no message renders yet, shown as status rows while tool calls are collapsed. */
  pendingToolHeaders: { id: string; name: string }[];
  /** The transient phase line, shown standalone when no hub bar hosts it. */
  liveStatusText: string | null;
  /** Whether a hub bar hosts the live status (then the inline line hides). */
  statusHostExists: boolean;
  /** A `!command` is running and has no pending row yet. */
  bashRunning: boolean;
  /** `!command` results omp holds back until a later prompt records them. */
  deferredBash: BashExecutionMessage[];
  /** A `!command` the user started that has no result yet. */
  pendingBash: { command: string; excludeFromContext: boolean } | null;
  toolResults: Map<string, ToolResultMessage>;
  modelNames: Record<string, string>;
  cwd: string | undefined;
  onOpenFile?: (filePath: string) => void;
  sessionId: string | undefined;
  toolCallsDefaultCollapsed: boolean;
  toolInputExpanded: boolean;
  thinkingDisplayMode: "auto" | "collapsed" | "expanded";
  thinkingAutoFollow: boolean;
  timeFormat: MessageTimeFormat;
}

/** The running turn's live end after the committed transcript: streaming reply,
 *  pending tool rows, the standalone live-status line, `!command` output. */
export function ChatLiveTail({
  streamingMessage, isStreaming, tokensPerSecond, pendingToolHeaders, liveStatusText, statusHostExists, bashRunning,
  deferredBash, pendingBash, toolResults, modelNames, cwd, onOpenFile, sessionId,
  toolCallsDefaultCollapsed, toolInputExpanded, thinkingDisplayMode, thinkingAutoFollow, timeFormat,
}: ChatLiveTailProps) {
  const { t } = useI18n();
  return (
    <>
      {isStreaming && streamingMessage && (
        <MessageView
          message={streamingMessage as AgentMessage}
          isStreaming
          modelNames={modelNames}
          cwd={cwd}
          onOpenFile={onOpenFile}
          toolCallsDefaultCollapsed={toolCallsDefaultCollapsed}
          toolInputExpanded={toolInputExpanded}
          toolResults={toolResults}
          thinkingDisplayMode={thinkingDisplayMode}
          thinkingAutoFollow={thinkingAutoFollow}
          timeFormat={timeFormat}
          liveTokensPerSecond={tokensPerSecond}
        />
      )}

      {toolCallsDefaultCollapsed && pendingToolHeaders.map((tool) => (
        <div
          key={tool.id}
          role="status"
          style={{
            display: "flex", alignItems: "center", gap: 7,
            marginBottom: 8, padding: "6px 10px",
            border: "1px solid color-mix(in srgb, var(--status-success) 25%, transparent)",
            borderRadius: "var(--radius-control)",
            background: "color-mix(in srgb, var(--status-success) 4%, transparent)",
            color: "var(--text-muted)", fontSize: "calc(12px * var(--ui-font-scale-lg, 1))",
          }}
        >
          <span aria-hidden className="live-status-dot live-pulse inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
          <span style={{ color: "var(--status-success)", fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: "calc(11px * var(--ui-font-scale-sm, 1))" }}>{tool.name}</span>
        </div>
      ))}

      {liveStatusText !== null && !statusHostExists && (
        <div role="status" aria-live="polite" className="pt-2 pb-4 mb-3 text-[13px] text-text-muted flex items-center gap-2.5">
          <OmpBouncingLetter />
          <span>{liveStatusText}</span>
        </div>
      )}

      {bashRunning && !pendingBash && (
        <div role="status" aria-live="polite" className="py-2 text-[13px] text-text-muted flex items-center gap-2">
          <span
            aria-hidden
            className="live-status-dot live-pulse inline-block h-2 w-2 shrink-0 rounded-full bg-accent"
          />
          <span>{t("chatWindow.runningCommand")}</span>
        </div>
      )}

      {deferredBash.map((message, index) => (
        <MessageView
          key={index}
          message={message}
          sessionId={sessionId}
        />
      ))}

      {pendingBash && (
        <MessageView
          message={{
            role: "bashExecution",
            command: pendingBash.command,
            output: "",
            excludeFromContext: pendingBash.excludeFromContext,
          } as BashExecutionMessage}
          sessionId={sessionId}
        />
      )}
    </>
  );
}
