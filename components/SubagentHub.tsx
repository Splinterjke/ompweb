"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  Bot,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  Cpu,
  Gauge,
  GitBranch,
  Network,
  RefreshCw,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { SubagentActivityEvent, SubagentInfo } from "@/lib/subagent-types";
import {
  countNestedSubagents,
  formatCost,
  formatDuration,
  formatTokens,
  shortModel,
} from "@/lib/subagent-format";
import { SubagentStatusIcon } from "./SubagentStatusIcon";

const SUBAGENT_STATE_KEYS: Record<SubagentInfo["status"], string> = {
  started: "chatWindow.subagentState.started",
  completed: "chatWindow.subagentState.completed",
  failed: "chatWindow.subagentState.failed",
  aborted: "chatWindow.subagentState.aborted",
};

type SubagentHubProps = {
  subagents: SubagentInfo[];
  subagentEvents?: Record<string, SubagentActivityEvent[]>;
  onSelectSubagent: (subagent: SubagentInfo) => void;
  /** Initial expansion (default: collapsed so the composer remains compact). */
  defaultExpanded?: boolean;
};

function Metric({ icon: Icon, label, children }: {
  icon: LucideIcon;
  label: string;
  children: ReactNode;
}) {
  return (
    <span
      aria-label={label}
      title={label}
      data-subagent-metric={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        minWidth: 0,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <Icon
        aria-hidden
        style={{
          width: 13,
          height: 13,
          flexShrink: 0,
        }}
      />
      <span>{children}</span>
    </span>
  );
}

function ActivityLine({ subagent }: { subagent: SubagentInfo }) {
  const { t } = useI18n();
  const progress = subagent.progress;
  const retryActive = Boolean(progress?.retryState ?? progress?.retryFailure);
  const parts: ReactNode[] = [];

  if (retryActive) {
    const attempt = progress?.retryState?.attempt ?? progress?.retryFailure?.attempt ?? 0;
    const maxAttempts = progress?.retryState?.maxAttempts ?? 0;
    const label = maxAttempts > 0
      ? t("chatWindow.subagentRetrying", { attempt, max: maxAttempts })
      : t("chatWindow.subagentRetryAttempt", { attempt });
    parts.push(
      <Metric key="retry" icon={RefreshCw} label={label}>
        {maxAttempts > 0 ? `${attempt}/${maxAttempts}` : attempt}
      </Metric>,
    );
  } else if (subagent.status === "started") {
    const activity = progress?.currentTool
      ? `${progress.currentTool}${progress.lastIntent ? ` — ${progress.lastIntent}` : ""}`
      : progress?.lastIntent;
    if (activity) {
      parts.push(
        <Metric key="activity" icon={progress?.currentTool ? Wrench : Activity} label={activity}>
          {activity}
        </Metric>,
      );
    }
  }

  const nested = countNestedSubagents(progress);
  const tokens = formatTokens(progress?.tokens);
  const cost = formatCost(progress?.cost ?? subagent.result?.cost);
  const ctxTokens = formatTokens(progress?.contextTokens);
  const context = ctxTokens
    ? `${ctxTokens}/${formatTokens(progress?.contextWindow) ?? "?"}`
    : null;
  const model = shortModel(progress?.resolvedModel);
  const duration = formatDuration(progress?.durationMs);
  const meta: ReactNode[] = [
    nested > 0 ? <Metric key="nested" icon={GitBranch} label={t("chatWindow.subagentNestedCount", { count: nested })}>{nested}</Metric> : null,
    tokens ? <Metric key="tokens" icon={Cpu} label={t("chatWindow.tokensUnit", { count: tokens })}>{tokens}</Metric> : null,
    cost ? <Metric key="cost" icon={CircleDollarSign} label={cost}>{cost}</Metric> : null,
    context ? <Metric key="context" icon={Gauge} label={t("chatWindow.contextGauge", { used: ctxTokens ?? "?", total: formatTokens(progress?.contextWindow) ?? "?" })}>{context}</Metric> : null,
    model ? <Metric key="model" icon={Bot} label={model}>{model}</Metric> : null,
    duration ? <Metric key="duration" icon={Clock3} label={duration}>{duration}</Metric> : null,
  ].filter(Boolean);
  if (meta.length > 0) {
    parts.push(
      <span key="meta" style={{ display: "inline-flex", flexWrap: "wrap", gap: "4px 8px" }}>
        {meta}
      </span>,
    );
  }

  if (parts.length === 0) return null;
  return (
    <span
      style={{
        display: "flex",
        minWidth: 0,
        overflow: "hidden",
        fontSize: "calc(11px * var(--ui-font-scale-sm, 1))",
        fontFamily: "var(--font-mono)",
        color: retryActive ? "var(--accent)" : "var(--text-dim)",
        lineHeight: 1.4,
        fontVariantNumeric: "tabular-nums",
        gap: 8,
        flexWrap: "wrap",
      }}
    >
      {parts}
    </span>
  );
}

function ActivityPreview({ events }: { events: SubagentActivityEvent[] | undefined }) {
  const { t } = useI18n();
  const labels = (events ?? [])
    .slice(-2)
    .map((event) => event.label.trim())
    .filter(Boolean);
  if (labels.length === 0) return null;

  const preview = labels.join(" · ");
  const label = `${t("chatWindow.subagentHub.preview")}: ${preview}`;
  return (
    <span
      title={label}
      aria-label={label}
      style={{
        display: "flex",
        minWidth: 0,
        overflow: "hidden",
        color: "var(--text-dim)",
        fontFamily: "var(--font-mono)",
        fontSize: "calc(12px * var(--ui-font-scale-lg, 1))",
        lineHeight: 1.4,
        wordBreak: "keep-all",
      }}
    >
      <span style={{ flexShrink: 0, color: "var(--text-muted)" }}>
        {t("chatWindow.subagentHub.preview")}:
      </span>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginLeft: "4px" }}>
        {preview}
      </span>
    </span>
  );
}

function SubagentRow({
  subagent,
  events,
  onSelectSubagent,
}: {
  subagent: SubagentInfo;
  events: SubagentActivityEvent[] | undefined;
  onSelectSubagent: (subagent: SubagentInfo) => void;
}) {
  const { t } = useI18n();
  const live = subagent.source !== "history";
  const stateLabel = t(SUBAGENT_STATE_KEYS[subagent.status]);
  const task = subagent.task ?? subagent.description ?? subagent.assignment ?? t("chatWindow.subagentHub.noTask");
  const historyLabel = subagent.source === "history" ? t("chatWindow.subagentHub.history") : null;
  const rowLabel = [subagent.agent, task, stateLabel, historyLabel].filter(Boolean).join(" · ");

  return (
    <button
      type="button"
      className="ui-focus-ring"
      onClick={() => onSelectSubagent(subagent)}
      aria-label={rowLabel}
      title={rowLabel}
      style={{
        display: "flex",
        width: "100%",
        minWidth: 0,
        minHeight: 40,
        flexDirection: "column",
        alignItems: "stretch",
        justifyContent: "center",
        gap: 4,
        padding: "8px 12px",
        border: "thin solid var(--border)",
        borderRadius: "var(--radius-control)",
        background: live ? "var(--bg)" : "var(--bg-panel)",
        color: live ? "var(--text)" : "var(--text-dim)",
        opacity: live ? 1 : 0.72,
        fontFamily: "inherit",
        fontSize: "calc(11px * var(--ui-font-scale-sm, 1))",
        textAlign: "left",
        cursor: "pointer",
        wordBreak: "keep-all",
        transition: "border-color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm), opacity var(--dur-fast) var(--ease-out-warm)",
      }}
      onMouseEnter={(event) => {
        event.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 40%, var(--border))";
        event.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.borderColor = "var(--border)";
        event.currentTarget.style.background = live ? "var(--bg)" : "var(--bg-panel)";
      }}
    >
      <span style={{ display: "flex", minWidth: 0, alignItems: "center", gap: 6 }}>
        <SubagentStatusIcon status={subagent.status} live={live} size={14} strokeWidth={1.8} />
        <span style={{ flexShrink: 0, color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", fontWeight: 650 }}>
          {subagent.agent}
        </span>
        <span
          title={task}
          style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "inherit" }}
        >
          {task}
        </span>
        <span style={{ flexShrink: 0, color: live ? "var(--text-muted)" : "var(--text-dim)", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))" }}>
          {stateLabel}
        </span>
        {historyLabel && (
          <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))" }}>
            {historyLabel}
          </span>
        )}
        {subagent.detached && (
          <span
            aria-hidden
            style={{ flexShrink: 0, color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))" }}
          >
            ⤴
          </span>
        )}
      </span>
      <ActivityLine subagent={subagent} />
      <ActivityPreview events={events} />
    </button>
  );
}

export type SubagentHubTreeItem =
  | { kind: "group"; key: string; group: "roots" | "nested" | "orphans"; parentLabel?: string; depth: number }
  | { kind: "row"; key: string; subagent: SubagentInfo; depth: number };

/** Build the display order without mutating the input roster or render state. */
export function buildSubagentHubTree(subagents: SubagentInfo[]): SubagentHubTreeItem[] {
  const statusRank: Record<SubagentInfo["status"], number> = { started: 0, failed: 1, aborted: 2, completed: 3 };
  const sorted = [...subagents].sort((left, right) => (statusRank[left.status] - statusRank[right.status]) || (left.index - right.index) || left.id.localeCompare(right.id));
  const ids = new Set(sorted.map((subagent) => subagent.id));
  const childrenByParent = new Map<string, SubagentInfo[]>();
  const roots: SubagentInfo[] = [];
  const unknownParentGroups = new Map<string, SubagentInfo[]>();

  for (const subagent of sorted) {
    const parentId = subagent.parentToolCallId;
    if (!parentId) {
      roots.push(subagent);
      continue;
    }
    const group = childrenByParent.get(parentId) ?? [];
    group.push(subagent);
    childrenByParent.set(parentId, group);
    if (!ids.has(parentId)) {
      const orphanGroup = unknownParentGroups.get(parentId) ?? [];
      orphanGroup.push(subagent);
      unknownParentGroups.set(parentId, orphanGroup);
    }
  }

  const tree: SubagentHubTreeItem[] = [];
  const visited = new Set<string>();
  const appendSubtree = (items: SubagentInfo[], depth: number) => {
    for (const subagent of items) {
      if (visited.has(subagent.id)) continue;
      visited.add(subagent.id);
      tree.push({ kind: "row", key: `row-${subagent.id}`, subagent, depth });
      const children = (childrenByParent.get(subagent.id) ?? []).filter((child) => !visited.has(child.id));
      if (children.length === 0) continue;
      tree.push({
        kind: "group",
        key: `group-nested-${subagent.id}`,
        group: "nested",
        parentLabel: subagent.agent,
        depth: depth + 1,
      });
      appendSubtree(children, depth + 1);
    }
  };

  if (roots.length > 0) {
    tree.push({ kind: "group", key: "group-roots", group: "roots", depth: 0 });
    appendSubtree(roots, 0);
  }
  if (unknownParentGroups.size > 0) {
    tree.push({ kind: "group", key: "group-orphans", group: "orphans", depth: 0 });
    for (const [parentId, items] of unknownParentGroups) {
      tree.push({
        kind: "group",
        key: `group-parent-${parentId}`,
        group: "nested",
        parentLabel: parentId,
        depth: 0,
      });
      appendSubtree(items, 0);
    }
  }

  const remaining = sorted.filter((subagent) => !visited.has(subagent.id));
  if (remaining.length > 0) appendSubtree(remaining, 0);
  return tree;
}

export function SubagentHub({
  subagents,
  subagentEvents = {},
  onSelectSubagent,
  defaultExpanded = false,
}: SubagentHubProps) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(!defaultExpanded);
  const runningCount = subagents.filter((subagent) => subagent.source !== "history" && subagent.status === "started").length;
  const treeItems = useMemo(() => buildSubagentHubTree(subagents), [subagents]);

  return (
    <section
      aria-label={t("chatWindow.subagentsPanel")}
      style={{
        width: "100%",
        minWidth: 0,
        overflow: "hidden",
        border: "thin solid var(--border)",
        borderRadius: "var(--radius-card)",
        background: "var(--bg-subtle)",
      }}
    >
      <button
        type="button"
        className="ui-focus-ring flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-text-muted"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
        title={collapsed ? t("chatWindow.subagentHub.expand") : t("chatWindow.subagentHub.collapse")}
        style={{
          fontSize: "calc(12px * var(--ui-font-scale-lg, 1))",
          border: "none",
          borderBottom: collapsed ? "none" : "thin solid var(--border)",
          background: "transparent",
          fontFamily: "inherit",
          wordBreak: "keep-all",
        }}
      >
        <Network size={15} strokeWidth={1.8} aria-hidden style={{ flexShrink: 0 }} />
        <strong className="font-medium text-text">{t("chatWindow.subagentsPanel")}</strong>
        <span
          className="ml-auto"
          aria-label={t("chatWindow.subagentSummary", { running: runningCount, total: subagents.length })}
          title={t("chatWindow.subagentSummary", { running: runningCount, total: subagents.length })}
          style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}
        >
          <span>{runningCount}</span>
          <span aria-hidden>/</span>
          <span>{subagents.length}</span>
          <span>&nbsp;{t("chatWindow.subagentBusy")}</span>
        </span>
        <ChevronDown
          size={14}
          strokeWidth={1.8}
          aria-hidden
          style={{
            flexShrink: 0,
            color: "var(--text-dim)",
            transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
            transition: "transform var(--dur-med) var(--ease-out-warm)",
          }}
        />
      </button>
      {!collapsed && (
        <div
          style={{
            display: "grid",
            maxHeight: "30vh",
            gap: 8,
            overflowY: "auto",
            padding: "8px 12px 12px",
          }}
        >
          {subagents.length === 0 ? (
            <div style={{ padding: "12px", color: "var(--text-dim)", fontSize: "calc(12px * var(--ui-font-scale-lg, 1))", textAlign: "center", wordBreak: "keep-all" }}>
              {t("chatWindow.subagentHub.empty")}
            </div>
          ) : (
            treeItems.map((item) => {
              if (item.kind === "group") return null;
              const nestedStyle = item.depth > 0
                ? {
                    marginLeft: `calc(16px * ${item.depth})`,
                    paddingLeft: "12px",
                    borderLeft: "thin solid var(--border)",
                  }
                : undefined;
              return (
                <div key={item.key} style={{ display: "grid", gap: 6, ...nestedStyle }}>
                  <SubagentRow
                    subagent={item.subagent}
                    events={subagentEvents[item.subagent.id]}
                    onSelectSubagent={onSelectSubagent}
                  />
                </div>
              );
            })
          )}
        </div>
      )}
    </section>
  );
}
