"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { TodoPhase, SessionStatsInfo, GenerationSpeedInfo } from "@/lib/pi-types";
import type { SubagentActivityEvent, SubagentInfo } from "@/lib/subagent-types";
import { formatCost } from "@/lib/subagent-format";
import { formatCompactNumber, formatPercent, getCacheHitRate } from "@/lib/format";
import { copyText } from "@/lib/clipboard";
import { TodoList } from "./TodoList";
import { SubagentHub } from "./SubagentHub";

/**
 * Panels attached above the composer: the live todo plan plus the subagent
 * hub. Each is independently collapsible via its header row and starts
 * collapsed; the headers always show live progress / running-summary.
 * Rendered pinned above the chat input. Selecting a hub row opens the
 * subagent in the right-hand Agents panel.
 */
export function ComposerPanels({ todoPhases, subagents = [], subagentEvents, onSelectSubagent, defaultExpanded = false, planModeActive = false }: {
  todoPhases: TodoPhase[];
  /** Live subagent roster; the hub renders it pinned above the input. */
  subagents?: SubagentInfo[];
  /** Per-subagent live activity feed for the hub's recent-event preview. */
  subagentEvents?: Record<string, SubagentActivityEvent[]>;
  /** Open a subagent in the right-hand Agents panel. */
  onSelectSubagent?: (subagent: SubagentInfo) => void;
  /** Initial expansion of the panels (default: collapsed). */
  defaultExpanded?: boolean;
  /** True while a plan surface (PlanPanel) owns the task grid: hide the
   *  duplicate TodoList so tasks render exactly once. */
  planModeActive?: boolean;
}) {
  if (todoPhases.length === 0 && subagents.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: 6, marginBottom: 8 }}>
      {todoPhases.length > 0 && !planModeActive && <TodoList phases={todoPhases} collapsible defaultExpanded={defaultExpanded} />}
      {subagents.length > 0 && (
        <SubagentHub
          subagents={subagents}
          subagentEvents={subagentEvents}
          onSelectSubagent={onSelectSubagent ?? (() => {})}
          defaultExpanded={defaultExpanded}
        />
      )}
    </div>
  );
}

/** Context detail for the composer ring popover: usage bar plus the full
 * session / messages / tokens grids. No chrome of its own — the popover
 * frame owns the title and the Compact action. Renders nothing until the
 * session reports stats or usage.
 *
 * NOTE: omp reports context as a single total (tokens/window/percent) — there
 * is no per-category breakdown on the wire, so none is shown here. */
export function ContextDetailPanel({ sessionStats, contextUsage, modelCapacity, generationSpeed }: {
  sessionStats?: SessionStatsInfo | null;
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  modelCapacity?: { contextWindow?: number; maxTokens?: number } | null;
  generationSpeed?: GenerationSpeedInfo | null;
}) {
  const { t, locale } = useI18n();
  const [copiedField, setCopiedField] = useState<"file" | "id" | null>(null);
  const copyTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);
  useEffect(() => () => {
    clearTimeout(copyTimerRef.current);
  }, []);

  const ctx = contextUsage ?? sessionStats?.contextUsage ?? null;
  if (!sessionStats && !ctx) return null;

  const pct = ctx?.percent ?? null;
  const tone = pct !== null && pct > 90
    ? "var(--status-error)"
    : pct !== null && pct > 70
      ? "var(--status-warning)"
      : "var(--text-muted)";
  const costStr = sessionStats ? formatCost(sessionStats.cost) : null;
  const cacheHitRate = sessionStats ? getCacheHitRate(sessionStats.tokens.input, sessionStats.tokens.cacheRead) : null;

  const copyField = (field: "file" | "id", value: string) => {
    void copyText(value).then(() => {
      clearTimeout(copyTimerRef.current);
      setCopiedField(field);
      copyTimerRef.current = setTimeout(() => setCopiedField(null), 1400);
    });
  };

  const statRow = (label: string, value: string, copy?: "file" | "id", copyValue?: string) => (
    <div key={label} style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, minWidth: 0 }}>
      <span style={{ color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0, fontVariantNumeric: "tabular-nums", color: "var(--text)" }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>{value}</span>
        {copy && copyValue && (
          <button
            type="button"
            onClick={() => copyField(copy, copyValue)}
            aria-label={copiedField === copy ? t("appShell.copied") : t("appShell.copyFilePath")}
            title={copiedField === copy ? t("appShell.copied") : t("appShell.copyFilePath")}
            style={{ display: "inline-flex", padding: 2, background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)" }}
          >
            {copiedField === copy
              ? <Check size={11} strokeWidth={2.4} aria-hidden="true" />
              : <Copy size={11} strokeWidth={2} aria-hidden="true" />}
          </button>
        )}
      </span>
    </div>
  );

  const sectionTitleStyle = { fontSize: 11, fontWeight: 700, color: "var(--text)", margin: "0 0 4px" } as const;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {ctx?.contextWindow ? (
        <div>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginBottom: 5 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
              {ctx.tokens !== null && ctx.tokens !== undefined ? formatCompactNumber(ctx.tokens) : "?"}
              {" / "}{formatCompactNumber(ctx.contextWindow)}
              {pct !== null ? ` (${formatPercent(pct)})` : ""}
            </span>
          </div>
          <div style={{ height: 5, borderRadius: 3, background: "var(--border)", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${pct !== null ? Math.min(100, Math.max(0, pct)) : 0}%`, background: tone, borderRadius: 3 }} />
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 5, fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
            <span>{t("composerContext.windowSize", { tokens: formatCompactNumber(ctx.contextWindow) })}</span>
            {modelCapacity?.maxTokens ? <span>{t("composerContext.maxOutput", { tokens: formatCompactNumber(modelCapacity.maxTokens) })}</span> : null}
            {generationSpeed?.current != null || generationSpeed?.average != null ? (
              <span>
                {generationSpeed?.current != null && generationSpeed?.average != null
                  ? t("composerContext.speed", { current: generationSpeed.current.toFixed(1), average: generationSpeed.average.toFixed(1) })
                  : t("composerContext.speedCurrent", { current: (generationSpeed?.current ?? generationSpeed?.average ?? 0).toFixed(1) })}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
      {sessionStats && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, fontSize: 11, fontFamily: "var(--font-mono)" }}>
          <div style={{ minWidth: 0 }}>
            <h4 style={sectionTitleStyle}>{t("appShell.sectionSessionInfo")}</h4>
            {sessionStats.sessionName ? statRow(t("appShell.statName"), sessionStats.sessionName) : null}
            {statRow(t("appShell.statFile"), sessionStats.sessionFile ?? t("appShell.inMemory"), "file", sessionStats.sessionFile)}
            {statRow(t("appShell.statId"), sessionStats.sessionId, "id", sessionStats.sessionId)}
          </div>
          <div style={{ minWidth: 0 }}>
            <h4 style={sectionTitleStyle}>{t("appShell.sectionMessages")}</h4>
            {statRow(t("appShell.statUser"), sessionStats.userMessages.toLocaleString(locale))}
            {statRow(t("appShell.statAssistant"), sessionStats.assistantMessages.toLocaleString(locale))}
            {statRow(t("appShell.statToolCalls"), sessionStats.toolCalls.toLocaleString(locale))}
            {statRow(t("appShell.statToolResults"), sessionStats.toolResults.toLocaleString(locale))}
            {statRow(t("appShell.statTotal"), sessionStats.totalMessages.toLocaleString(locale))}
          </div>
          <div style={{ minWidth: 0 }}>
            <h4 style={sectionTitleStyle}>{t("appShell.sectionTokens")}</h4>
            {statRow(t("appShell.statInput"), sessionStats.tokens.input.toLocaleString(locale))}
            {statRow(t("appShell.statOutput"), sessionStats.tokens.output.toLocaleString(locale))}
            {sessionStats.tokens.cacheRead > 0 ? statRow(t("appShell.statCacheRead"), sessionStats.tokens.cacheRead.toLocaleString(locale)) : null}
            {sessionStats.tokens.cacheWrite > 0 ? statRow(t("appShell.statCacheWrite"), sessionStats.tokens.cacheWrite.toLocaleString(locale)) : null}
            {statRow(t("appShell.statTotal"), sessionStats.tokens.total.toLocaleString(locale))}
            {cacheHitRate !== null ? statRow(t("appShell.statCacheRate"), formatPercent(cacheHitRate)) : null}
            {costStr ? statRow(t("appShell.statCost"), costStr) : null}
          </div>
        </div>
      )}
    </div>
  );
}
