"use client";
import { Tooltip } from "./ui/primitives";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, Copy } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { TodoPhase, SessionStatsInfo, GenerationSpeedInfo } from "@/lib/pi-types";
import type { SubagentActivityEvent, SubagentInfo } from "@/lib/subagent-types";
import { formatCost } from "@/lib/subagent-format";
import { formatCompactNumber, formatPercent, getCacheHitRate } from "@/lib/format";
import { copyText } from "@/lib/clipboard";
import { GitChangesBar } from "./GitChangesBar";
import { TodoList } from "./TodoList";
import { SubagentHub } from "./SubagentHub";
import type { HubBarLayout } from "./AppShell";

/**
 * Composer hub bars: git changes, tasks (todo plan), and subagents. Each bar
 * is independently collapsible via its header row and starts collapsed; the
 * headers always show live progress / running-summary. Stacking is
 * configurable via `layout` — "stack" (vertical column, the default) or
 * "row" (compact bars in one horizontal row, where an expanded bar moves
 * above the row while the others stay side by side). Rendered pinned above
 * the chat input. Selecting a subagent row opens it in the right-hand Agents
 * panel.
 */
export function ComposerPanels({
  cwd,
  onOpenGitTab,
  onCommitWithAgent,
  onCommitted,
  todoPhases,
  subagents = [],
  subagentEvents,
  onSelectSubagent,
  layout = "stack",
  showGit = true,
  showTasks = true,
  showSubagents = true,
  defaultExpanded = false,
  planModeActive = false,
}: {
  cwd?: string | null;
  onOpenGitTab?: () => void;
  onCommitWithAgent?: (message: string) => boolean | Promise<boolean>;
  onCommitted?: (hash: string) => void;
  todoPhases: TodoPhase[];
  /** Live subagent roster; the hub renders it pinned above the input. */
  subagents?: SubagentInfo[];
  /** Per-subagent live activity feed for the hub's recent-event preview. */
  subagentEvents?: Record<string, SubagentActivityEvent[]>;
  /** Open a subagent in the right-hand Agents panel. */
  onSelectSubagent?: (subagent: SubagentInfo) => void;
  /** "stack" (vertical column, default) or "row" (horizontal, compact). */
  layout?: HubBarLayout;
  /** Show the git changes bar (Interface & Behavior). */
  showGit?: boolean;
  /** Show the tasks bar (Interface & Behavior). */
  showTasks?: boolean;
  /** Show the subagents bar (Interface & Behavior). */
  showSubagents?: boolean;
  /** Initial expansion of the panels (default: collapsed). */
  defaultExpanded?: boolean;
  /** True while a plan surface (PlanPanel) owns the task grid: hide the
   *  duplicate TodoList so tasks render exactly once. */
  planModeActive?: boolean;
}) {
  // Lifted expansion state so the row layout can move an expanded bar above
  // the horizontal row while the others stay collapsed.
  const [gitExpanded, setGitExpanded] = useState(false);
  const [todoCollapsed, setTodoCollapsed] = useState(!defaultExpanded);
  const [subagentCollapsed, setSubagentCollapsed] = useState(!defaultExpanded);
  // Whether the git bar has renderable content (a repo with changes). The
  // bar owns the data fetch, so it must stay mounted even when it would
  // render null; in row mode we hide its empty slot until content exists.
  const [gitPresent, setGitPresent] = useState(false);

  const showTodoBar = showTasks && todoPhases.length > 0 && !planModeActive;
  const showSubagentBar = showSubagents && subagents.length > 0;

  const gitBar = showGit ? (
    <GitChangesBar
      cwd={cwd}
      onCommitted={onCommitted}
      onOpenGitTab={onOpenGitTab}
      onCommitWithAgent={onCommitWithAgent}
      expanded={gitExpanded}
      onExpandedChange={setGitExpanded}
      onPresenceChange={setGitPresent}
    />
  ) : null;
  const todoBar = showTodoBar ? (
    <TodoList
      phases={todoPhases}
      collapsible
      defaultExpanded={defaultExpanded}
      collapsed={todoCollapsed}
      onCollapsedChange={setTodoCollapsed}
    />
  ) : null;
  const subagentBar = showSubagentBar ? (
    <SubagentHub
      subagents={subagents}
      subagentEvents={subagentEvents}
      onSelectSubagent={onSelectSubagent ?? (() => {})}
      defaultExpanded={defaultExpanded}
      collapsed={subagentCollapsed}
      onCollapsedChange={setSubagentCollapsed}
    />
  ) : null;

  // The git bar reports its renderable content (repo with changes) via
  // onPresenceChange; it stays mounted while enabled so its polling keeps
  // running, but contributes nothing visually until content exists.
  const gitVisible = showGit && gitPresent;
  const anyVisible = gitVisible || todoBar !== null || subagentBar !== null;

  // With the git bar disabled and no other bars there is nothing to show.
  if (!showGit && !anyVisible) return null;

  // Row layout: every bar lives in a stable slot of one wrapping flex row.
  // Expansion and visibility only toggle slot styles (flex-basis/order and
  // display), never the element's position, so bars never remount while the
  // git bar re-polls or the user expands/collapses. An expanded bar takes a
  // full-width line above the collapsed ones via `order: -1`; the git slot
  // is display:none while it has no content (the bar stays mounted polling).
  if (layout === "row") {
    const slotStyle = (visible: boolean, expanded: boolean): CSSProperties =>
      !visible
        ? { display: "none" }
        : expanded
          ? { flex: "0 0 100%", minWidth: 0, order: -1 }
          : { flex: "1 1 0", minWidth: 0, order: 0 };

    return (
      <div className="hub-bars hub-bars--row" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: anyVisible ? 8 : 0 }}>
        {gitBar && <div key="git" style={slotStyle(gitVisible, gitExpanded)}>{gitBar}</div>}
        {todoBar && <div key="tasks" style={slotStyle(true, !todoCollapsed)}>{todoBar}</div>}
        {subagentBar && <div key="subagents" style={slotStyle(true, !subagentCollapsed)}>{subagentBar}</div>}
      </div>
    );
  }

  // Default: vertical column (previous behavior).
  return (
    <div className="hub-bars" style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: anyVisible ? 8 : 0 }}>
      {gitBar}
      {todoBar}
      {subagentBar}
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
  const cacheHitRate = sessionStats ? getCacheHitRate(sessionStats.tokens.input, sessionStats.tokens.cacheRead, sessionStats.tokens.cacheWrite) : null;

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
                    <Tooltip content={copiedField === copy ? t("appShell.copied") : t("appShell.copyFilePath")}>
            <button
              type="button"
              onClick={() => copyField(copy, copyValue)}
              aria-label={copiedField === copy ? t("appShell.copied") : t("appShell.copyFilePath")}
              style={{ display: "inline-flex", padding: 2, background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)" }}
            >
              {copiedField === copy
                ? <Check size={11} strokeWidth={2.4} aria-hidden="true" />
                : <Copy size={11} strokeWidth={2} aria-hidden="true" />}
            </button>
          </Tooltip>
        )}
      </span>
    </div>
  );

  const sectionTitleStyle = { fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", fontWeight: 700, color: "var(--text)", margin: "0 0 4px" } as const;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {ctx?.contextWindow ? (
        <div>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginBottom: 5 }}>
            <span style={{ fontSize: "calc(13px * var(--ui-font-scale-lg, 1))", fontWeight: 700, color: "var(--text)", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
              {ctx.tokens !== null && ctx.tokens !== undefined ? formatCompactNumber(ctx.tokens) : "?"}
              {" / "}{formatCompactNumber(ctx.contextWindow)}
              {pct !== null ? ` (${formatPercent(pct)})` : ""}
            </span>
          </div>
          <div style={{ height: 5, borderRadius: 3, background: "var(--border)", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${pct !== null ? Math.min(100, Math.max(0, pct)) : 0}%`, background: tone, borderRadius: 3 }} />
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 5, fontSize: "calc(10px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
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
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", fontFamily: "var(--font-mono)" }}>
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
