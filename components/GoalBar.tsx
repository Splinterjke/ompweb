"use client";
import { useState } from "react";
import { Ban, Clock3, Pause, Play, Target } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { GoalInfo } from "@/lib/goal";
import { formatDuration, formatTokens } from "@/lib/subagent-format";
import { Tooltip } from "./ui/primitives";
import { toast } from "./ui/toast";

const GOAL_STATUS_KEYS: Record<GoalInfo["status"], string> = {
  active: "goal.status.active",
  paused: "goal.status.paused",
  "budget-limited": "goal.status.budgetLimited",
  complete: "goal.status.complete",
  dropped: "goal.status.dropped",
};

type GoalControl = "pause" | "resume" | "drop";

/**
 * Goal mode bar (omp >= 18.4.11): shows the session's live goal — objective,
 * status, token budget, elapsed time — and lets the user pause, resume or
 * drop it through the `goal` RPC. The goal arrives via `goal_updated` frames
 * and background reads in useAgentSession; the bar renders only while a goal
 * exists (a dropped goal disappears with its frame).
 */
export function GoalBar({
  goal,
  mode,
  onCommand,
}: {
  goal: GoalInfo | null;
  /** "exiting" while a completed goal unwinds (still visible). */
  mode?: "active" | "exiting";
  onCommand: (op: GoalControl) => Promise<void>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<GoalControl | null>(null);

  if (!goal || goal.status === "dropped") return null;

  const run = async (op: GoalControl) => {
    if (busy) return;
    setBusy(op);
    try {
      await onCommand(op);
    } catch (error) {
      toast.error(t("goal.actionFailed"), error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const statusLabel = t(GOAL_STATUS_KEYS[goal.status]);
  const tokens = goal.tokenBudget
    ? `${formatTokens(goal.tokensUsed) ?? "0"} / ${formatTokens(goal.tokenBudget)}`
    : formatTokens(goal.tokensUsed);
  const time = formatDuration(goal.timeUsedSeconds * 1000);
  const controls: Array<{ op: GoalControl; icon: typeof Play; label: string; visible: boolean }> = [
    { op: "resume", icon: Play, label: t("goal.resume"), visible: goal.status === "paused" || goal.status === "budget-limited" },
    { op: "pause", icon: Pause, label: t("goal.pause"), visible: goal.status === "active" },
    { op: "drop", icon: Ban, label: t("goal.drop"), visible: true },
  ];

  return (
    <section
      aria-label={t("goal.barLabel")}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        minWidth: 0,
        border: "thin solid var(--border)",
        borderRadius: "var(--radius-card)",
        background: "var(--bg-subtle)",
        padding: "7px 12px",
        fontSize: "calc(11px * var(--ui-font-scale-sm, 1))",
      }}
    >
      <Target size={14} strokeWidth={1.8} aria-hidden style={{ flexShrink: 0, color: "var(--accent)" }} />
      <Tooltip content={`${statusLabel}${mode === "exiting" ? ` · ${t("goal.exiting")}` : ""}`}>
        <span
          style={{
            flexShrink: 0,
            color: goal.status === "active" ? "var(--accent)" : "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            fontWeight: 650,
          }}
        >
          {statusLabel}
        </span>
      </Tooltip>
      <Tooltip content={goal.objective}>
        <span
          style={{
            minWidth: 0,
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "var(--text)",
          }}
        >
          {goal.objective}
        </span>
      </Tooltip>
      {tokens && (
        <span style={{ flexShrink: 0, color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
          {tokens}
        </span>
      )}
      {time && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0, color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
          <Clock3 size={11} strokeWidth={1.8} aria-hidden />
          {time}
        </span>
      )}
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
        {controls.filter((control) => control.visible).map(({ op, icon: Icon, label }) => (
          <Tooltip key={op} content={label}>
            <button
              type="button"
              className="ui-focus-ring"
              aria-label={label}
              disabled={busy !== null}
              onClick={() => void run(op)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 24,
                height: 24,
                border: "thin solid var(--border)",
                borderRadius: "var(--radius-control)",
                background: "transparent",
                color: "var(--text-muted)",
                cursor: busy === null ? "pointer" : "default",
                opacity: busy === null || busy !== op ? 1 : 0.55,
              }}
            >
              <Icon size={12} strokeWidth={1.8} aria-hidden />
            </button>
          </Tooltip>
        ))}
      </span>
    </section>
  );
}
