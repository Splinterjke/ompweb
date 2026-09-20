"use client";

import { useState } from "react";
import { Ban, CheckCircle2, ChevronDown, Circle, CircleAlert, CircleDotDashed, ListChecks } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { TodoItem, TodoPhase } from "@/lib/pi-types";

function TodoStatusIcon({ status }: { status: TodoItem["status"] }) {
  const props = { size: 14, strokeWidth: 1.8, "aria-hidden": true as const };
  if (status === "completed") return <CheckCircle2 {...props} color="var(--accent)" />;
  if (status === "in_progress") return <CircleDotDashed {...props} color="var(--accent)" />;
  if (status === "blocked") return <CircleAlert {...props} color="var(--text-muted)" />;
  if (status === "abandoned") return <Ban {...props} color="var(--text-dim)" />;
  return <Circle {...props} color="var(--text-dim)" />;
}

interface TodoListProps {
  phases?: TodoPhase[];
  /** Render as a composer-attached panel: the header row becomes a
   * collapse/expand toggle and the section margin is dropped. */
  collapsible?: boolean;
  /** Initial expansion when `collapsible` (default: collapsed). */
  defaultExpanded?: boolean;
}

export function TodoList({ phases = [], collapsible = false, defaultExpanded = false }: TodoListProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [collapsed, setCollapsed] = useState(collapsible ? !defaultExpanded : false);

  if (phases.length === 0) return null;

  const tasks = phases.flatMap((phase) => phase.tasks);
  const done = tasks.filter((task) => task.status === "completed").length;
  let remainingPreviewTasks = 5;
  const displayedPhases = (expanded ? phases : phases.slice(0, 4)).map((phase) => {
    const displayedTasks = expanded ? phase.tasks : phase.tasks.slice(0, remainingPreviewTasks);
    remainingPreviewTasks -= displayedTasks.length;
    return { ...phase, tasks: displayedTasks };
  }).filter((phase) => phase.tasks.length > 0);
  const isTruncated = displayedPhases.reduce((count, phase) => count + phase.tasks.length, 0) < tasks.length;

  const headerRowClass = "flex items-center gap-2 px-3 py-2 text-text-muted";
  const headerBorderClass = collapsed ? "" : "border-b border-border";
  const progressSpan = (
    <span
      className="ml-auto"
      aria-label={t("chatWindow.todoProgress", { done, total: tasks.length })}
      title={t("chatWindow.todoProgress", { done, total: tasks.length })}
      style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}
    >
      <span>{done}</span>
      <span aria-hidden>/</span>
      <span>{tasks.length}</span>
      <span>&nbsp;{t("chatWindow.todoComplete")}</span>
    </span>
  );

  return (
    <section
      aria-label={t("chatWindow.todoList")}
      className={`overflow-hidden border border-border bg-bg-subtle ${collapsible ? "" : "my-2"}`}
      style={{ borderRadius: "var(--radius-card)" }}
    >
      {collapsible ? (
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
          title={collapsed ? t("chatWindow.expandPanel") : t("chatWindow.collapsePanel")}
          className={`${headerRowClass} ${headerBorderClass} w-full cursor-pointer text-left`}
          style={{ background: "none", fontSize: "calc(12px * var(--ui-font-scale-lg, 1))" }}
        >
          <ListChecks size={15} strokeWidth={1.8} aria-hidden />
          <strong className="font-medium text-text">{t("chatWindow.todoList")}</strong>
          {progressSpan}
          <ChevronDown
            size={14}
            strokeWidth={1.8}
            aria-hidden
            style={{
              color: "var(--text-dim)",
              transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
              transition: "transform var(--dur-med) var(--ease-out-warm)",
            }}
          />
        </button>
      ) : (
        <div className={`${headerRowClass} ${headerBorderClass}`} style={{ fontSize: "calc(12px * var(--ui-font-scale-lg, 1))" }}>
          <ListChecks size={15} strokeWidth={1.8} aria-hidden />
          <strong className="font-medium text-text">{t("chatWindow.todoList")}</strong>
          {progressSpan}
        </div>
      )}
      {!collapsed && (
        <>
      {/* Scrollable task area: long plans used to be clipped by the outer
          overflow-hidden with no way to scroll (only collapse). Matches the
          SubagentsPanel constraint pattern. */}
      <div className="grid gap-3 overflow-y-auto px-3 py-2.5 animate-slide-down" style={{ maxHeight: "min(40vh, 320px)" }}>
        {displayedPhases.map((phase, phaseIndex) => (
          <div key={phase.id ?? `${phase.name}-${phaseIndex}`} className="grid gap-1.5">
            <div className="font-medium text-text-muted" style={{ fontSize: "calc(11px * var(--ui-font-scale-sm, 1))" }}>{phase.name}</div>
            <div className="grid gap-1.5">
              {phase.tasks.map((task, taskIndex) => (
                <div
                  key={task.id ?? `${task.content}-${taskIndex}`}
                  className="flex min-w-0 items-start gap-2 text-text" style={{ fontSize: "calc(13px * var(--ui-font-scale-lg, 1))" }}
                  aria-label={`${t(`chatWindow.todoStatus.${task.status}`)}: ${task.content}`}
                >
                  <span className="mt-0.5 shrink-0"><TodoStatusIcon status={task.status} /></span>
                  <span className="min-w-0">
                    <span className={task.status === "completed" || task.status === "abandoned" ? "text-text-dim line-through" : undefined}>
                      {task.content}
                    </span>
                    {task.blocker && (
                      <span className="mt-0.5 block text-text-muted" style={{ fontSize: "calc(11px * var(--ui-font-scale-sm, 1))" }}>
                        {t("chatWindow.todoBlocker", { blocker: task.blocker })}
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {(isTruncated || expanded) && (
        <button
          type="button"
          className="border-t border-border px-3 py-2 text-left text-accent hover:text-accent-hover" style={{ fontSize: "calc(12px * var(--ui-font-scale-lg, 1))" }}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("chatWindow.todoShowLess") : t("chatWindow.todoShowAll")}
        </button>
      )}
        </>
      )}
    </section>
  );
}
