"use client";
import { Tooltip } from "./ui/primitives";

import { CircleCheck } from "lucide-react";
import { formatCompactNumber, formatPercent, getCacheHitRate } from "@/lib/format";
import type { ContextUsage, GenerationSpeedInfo, SessionStatsInfo } from "@/lib/pi-types";
import { useI18n } from "@/lib/i18n";

interface SessionInfoButtonProps {
  sessionStats: SessionStatsInfo | null;
  contextUsage: ContextUsage | null;
  modelCapacity: { contextWindow?: number; maxTokens?: number } | null;
  generationSpeed: GenerationSpeedInfo | null;
  open: boolean;
  onToggle: () => void;
}

/**
 * Compact Session Info stat row rendered below the chat input (moved from the
 * top bar). Shows input/output/cache tokens, max output, cache rate, context
 * fill, cost and speed; opens the full session stats popover.
 */
export function SessionInfoButton({ sessionStats, contextUsage, modelCapacity, generationSpeed, open, onToggle }: SessionInfoButtonProps) {
  const { t, locale } = useI18n();
  const tok = sessionStats?.tokens;
  const c = sessionStats?.cost ?? 0;
  const costStr = c > 0 ? (c >= 0.01 ? `$${c.toFixed(2)}` : `<$0.01`) : null;
  const cacheHitRate = tok ? getCacheHitRate(tok.input, tok.cacheRead, tok.cacheWrite) : null;
  const cacheRateStr = cacheHitRate !== null ? formatPercent(cacheHitRate) : null;

  let ctxColor = "var(--text-muted)";
  let ctxStr: string | null = null;
  if (contextUsage?.contextWindow) {
    const pct = contextUsage.percent;
    if (pct !== null && pct > 90) ctxColor = "var(--status-error)";
    else if (pct !== null && pct > 70) ctxColor = "var(--status-warning)";
    ctxStr = pct !== null ? `${formatPercent(pct)} / ${formatCompactNumber(contextUsage.contextWindow)}` : `? / ${formatCompactNumber(contextUsage.contextWindow)}`;
  }

  const tooltipParts: string[] = [];
  if (tok) {
    tooltipParts.push(t("appShell.tooltipInput", { value: tok.input.toLocaleString(locale) }));
    tooltipParts.push(t("appShell.tooltipOutput", { value: tok.output.toLocaleString(locale) }));
    tooltipParts.push(t("appShell.tooltipCacheRead", { value: tok.cacheRead.toLocaleString(locale) }));
    tooltipParts.push(t("appShell.tooltipCacheWrite", { value: tok.cacheWrite.toLocaleString(locale) }));
    if (cacheRateStr) tooltipParts.push(t("appShell.tooltipCacheRate", { percent: cacheRateStr }));
    if (c > 0) tooltipParts.push(t("appShell.tooltipCost", { value: c.toFixed(4) }));
  }
  if (modelCapacity?.maxTokens) tooltipParts.push(t("appShell.tooltipMaxOutput", { tokens: modelCapacity.maxTokens.toLocaleString(locale) }));
  if (contextUsage?.contextWindow) {
    const pct = contextUsage.percent;
    tooltipParts.push(t("appShell.tooltipContext", {
      percent: pct !== null ? pct.toFixed(1) + "%" : t("appShell.unknown"),
      tokens: contextUsage.contextWindow.toLocaleString(locale),
    }));
  }
  const speedStr = generationSpeed?.current !== null && generationSpeed?.current !== undefined
    ? `${generationSpeed.current.toFixed(1)} t/s`
    : null;
  if (speedStr) tooltipParts.push(t("appShell.tooltipCurrentSpeed", { value: speedStr }));
  const averageSpeedStr = generationSpeed?.average !== null && generationSpeed?.average !== undefined
    ? `AVG ${generationSpeed.average.toFixed(1)} t/s`
    : null;
  if (averageSpeedStr) tooltipParts.push(t("appShell.tooltipAverageSpeed", { value: averageSpeedStr }));
  const tooltip = tooltipParts.join("  |  ");

  return (
        <Tooltip content={tooltip || t("appShell.sessionInfo")}>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={open}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
          height: 24, padding: "0 8px",
          borderRadius: "var(--radius-control)",
          minWidth: 0,
          overflow: "hidden",
          background: open ? "var(--bg-selected)" : "none",
          border: "none",
          fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--text-muted)",
          whiteSpace: "nowrap", cursor: "pointer",
          fontVariantNumeric: "tabular-nums",
          transition: "color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm)",
        }}
        onMouseEnter={(e) => {
          if (!open) e.currentTarget.style.background = "var(--bg-hover)";
          e.currentTarget.style.color = "var(--text)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = open ? "var(--bg-selected)" : "none";
          e.currentTarget.style.color = open ? "var(--text)" : "var(--text-muted)";
        }}
      >
        {tok && tok.input > 0 && (
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="8.5" x2="5" y2="1.5" /><polyline points="2 4 5 1.5 8 4" />
            </svg>
            {formatCompactNumber(tok.input)}
          </span>
        )}
        {tok && tok.output > 0 && (
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
            </svg>
            {formatCompactNumber(tok.output)}
          </span>
        )}
        {tok && tok.cacheRead > 0 && (
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8.5 5a3.5 3.5 0 1 1-1-2.45" /><polyline points="6.5 1.5 8.5 2.5 7.5 4.5" />
            </svg>
            {formatCompactNumber(tok.cacheRead)}
          </span>
        )}
        {modelCapacity?.maxTokens && (
          <span style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>↗ {formatCompactNumber(modelCapacity.maxTokens)}</span>
        )}
        {cacheRateStr && (
          <span style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text-muted)" }}>
            <CircleCheck size={12} strokeWidth={1.8} aria-hidden="true" />
            {cacheRateStr}
          </span>
        )}
        {ctxStr && (
          <span style={{ display: "flex", alignItems: "center", gap: 4, color: ctxColor, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" /><line x1="1" y1="9" x2="9" y2="9" />
            </svg>
            {ctxStr}
          </span>
        )}
        {costStr && (
          <span style={{ display: "flex", alignItems: "center", color: "var(--text)", fontWeight: 500 }}>
            {costStr}
          </span>
        )}
        {speedStr && (
          <span style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text)", fontWeight: 600 }}>
            {speedStr}
          </span>
        )}
        {averageSpeedStr && (
          <span style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text-muted)" }}>
            {averageSpeedStr}
          </span>
        )}
      </button>
    </Tooltip>
  );
}
