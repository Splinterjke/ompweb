"use client";
import { Tooltip } from "./ui/primitives";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Clock, Eraser, LoaderCircle, Pencil, Play, Power, Plus, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { ConfirmDialog } from "./ui/field";
import { toast } from "./ui/toast";
import type { SchedulerStatus, SchedulerWithState } from "@/lib/scheduler-types";
import { createOmpwebClient } from "@/lib/client";
import { SchedulerModal } from "./SchedulerModal";
import { SectionChevron } from "./SectionChevron";
import { SeparatorHandle } from "./SeparatorHandle";
import type { RefObject } from "react";

// Script-scheduler calls go through the OmpWebClient facade (doc 16 route 1).
const client = createOmpwebClient("legacy-http");

const POLL_MS = 5_000;

function relTime(iso: string | undefined, now: number): string | null {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return null;
  const diff = now - ts;
  if (diff < 0) {
    // In the future: "in 5m" style.
    const minutes = Math.ceil(diff * -1 / 60_000);
    if (minutes < 1) return "soon";
    if (minutes < 60) return `in ${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `in ${hours}h`;
    return `in ${Math.floor(hours / 24)}d`;
  }
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function durationMs(run: SchedulerWithState["runs"][number]): string | null {
  if (!run.finishedAt) return null;
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1_000) return "<1s";
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

function statusColor(status: SchedulerStatus): string {
  switch (status) {
    case "ok":
      return "var(--status-success)";
    case "error":
    case "timeout":
      return "var(--status-error)";
    case "missed":
    case "skipped":
      return "var(--status-warning)";
  }
}

/** Effective display status: a running scheduler (engine-side, or a manual
 * "Run now" the server hasn't recorded yet) shows as running even though its
 * last recorded run may be stale. A scheduler that is turned OFF shows as
 * disabled — its last run is history, not its current state, so a stale "ok"
 * must never make a disabled script look active. */
function effectiveStatus(s: SchedulerWithState, manualRunning = false): SchedulerStatus | "running" | "disabled" | "never" {
  if (s.running || manualRunning) return "running";
  if (!s.enabled) return "disabled";
  return s.runs[0]?.status ?? "never";
}

function StatusDot({ status }: { status: SchedulerStatus | "running" | "disabled" | "never" }) {
  // A disabled (turned off) or never-run script must not look "active":
  // render a hollow ring. Running pulses; real run statuses are filled.
  const hollow = status === "disabled" || status === "never";
  const color =
    status === "running"
      ? "var(--accent)"
      : status === "disabled"
        ? "var(--border)"
        : status === "never"
          ? "var(--text-dim)"
          : statusColor(status);
  return (
    <Tooltip content={status === "disabled" ? "Disabled (not scheduled)" : status === "never" ? "Never run" : undefined}>
      <span
      aria-hidden="true"
      style={{
        width: 7,
        height: 7,
        borderRadius: "50%",
        flexShrink: 0,
        background: hollow ? "transparent" : color,
        border: hollow ? `1px solid ${color}` : "none",
        ...(status === "running" ? { animation: "pulse 1.4s ease-in-out infinite" } : {}),
      }}
    />
    </Tooltip>
  );
}

/**
 * Sidebar Schedulers panel: user-managed script schedules with live status,
 * last-run error output, and run-now / edit / enable / delete actions.
 * Mirrors the UsageSidebarPanel footer-section pattern.
 */
export function SchedulersPanel({
  open,
  onOpenChange,
  height,
  resize,
  headerRef,
  anyDragging,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  height: number;
  resize: {
    dragging: boolean;
    start: (e: { clientY: number; preventDefault: () => void }) => void;
    handleKeyDown: (e: { key: string; preventDefault: () => void }) => void;
    reset: () => void;
  };
  headerRef: RefObject<HTMLDivElement | null>;
  anyDragging: boolean;
}) {
  const { t } = useI18n();
  const [schedulers, setSchedulers] = useState<SchedulerWithState[] | null>(null);
  const [engineStartedAt, setEngineStartedAt] = useState<number | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<SchedulerWithState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SchedulerWithState | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [runBusyId, setRunBusyId] = useState<string | null>(null);
  const [toggleBusyId, setToggleBusyId] = useState<string | null>(null);
  const [clearBusyId, setClearBusyId] = useState<string | null>(null);
  // Ids of schedulers whose manual "Run now" trigger was accepted. The API
  // answers before the engine records the run, so the next poll can still
  // show the previous run's status — the ref keeps the row in a "running"
  // presentation until a fresh run (started at/after the trigger) lands in
  // the history. A ref (not state) keeps `load` stable so the polling
  // interval never chases this UI state; `manualRunningId` mirrors it for
  // rendering only.
  const manualRunningRef = useRef<{ id: string; triggeredAt: number } | null>(null);
  const [manualRunningId, setManualRunningId] = useState<string | null>(null);
  const loadedRef = useRef(false);

  const load = useCallback(() => {
    void client.schedulers
      .list()
      .then((data) => {
        setSchedulers(data.schedulers);
        setLoadError(false);
        loadedRef.current = true;
        const ts = new Date(data.engineStartedAt).getTime();
        setEngineStartedAt(Number.isFinite(ts) ? ts : null);
        // A manual run is done once a run recorded at/after the trigger is
        // visible in the history — the previous status is superseded.
        const manual = manualRunningRef.current;
        if (manual) {
          const entry = data.schedulers.find((s) => s.id === manual.id);
          const fresh = entry?.runs.find((run) => new Date(run.startedAt).getTime() >= manual.triggeredAt);
          if (fresh) {
            manualRunningRef.current = null;
            setManualRunningId(null);
          }
        }
      })
      .catch(() => setLoadError(true));
  }, []);
  useEffect(() => {
    if (!open) return;
    load();
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      load();
    }, POLL_MS);
    const onVisibilityChange = () => {
      if (!document.hidden && open) load();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [open, load]);


  const runNow = useCallback(
    async (id: string) => {
      setRunBusyId(id);
      try {
        const triggeredAt = Date.now();
        await client.schedulers.runNow(id);
        // The engine records the run after the API answers, so the next
        // poll can still show the previous run's status. Record the trigger
        // so `load()` can clear the "running" presentation once a fresh run
        // lands in the history.
        manualRunningRef.current = { id, triggeredAt };
        setManualRunningId(id);
        toast.info(t("schedulers.runStarted"));
        // Poll faster right after a manual trigger so the run appears quickly.
        window.setTimeout(() => load(), 800);
      } catch (err) {
        const code = (err as { code?: string } | null)?.code ?? "generic";
        const key = `schedulers.error.${code}`;
        toast.error(t(key) === key ? t("schedulers.error.generic") : t(key));
      } finally {
        setRunBusyId(null);
      }
    },
    [load, t],
  );

  const toggleEnabled = useCallback(
    async (entry: SchedulerWithState) => {
      setToggleBusyId(entry.id);
      try {
        await client.schedulers.update(entry.id, { enabled: !entry.enabled });
        load();
      } catch (err) {
        const code = (err as { code?: string } | null)?.code ?? "generic";
        const key = `schedulers.error.${code}`;
        toast.error(t(key) === key ? t("schedulers.error.generic") : t(key));
      } finally {
        setToggleBusyId(null);
      }
    },
    [load, t],
  );

  const remove = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await client.schedulers.remove(deleteTarget.id);
      toast.success(t("schedulers.deleted"));
      setDeleteTarget(null);
      load();
    } catch {
      toast.error(t("schedulers.error.generic"));
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, load, t]);

  const clearRunsFor = useCallback(
    async (id: string) => {
      setClearBusyId(id);
      try {
        await client.schedulers.clearRuns(id);
        toast.success(t("schedulers.runsCleared"));
        load();
      } catch {
        toast.error(t("schedulers.error.generic"));
      } finally {
        setClearBusyId(null);
      }
    },
    [load, t],
  );

  const openAdd = useCallback(() => {
    setEditing(null);
    setModalOpen(true);
  }, []);

  const openEdit = useCallback((entry: SchedulerWithState) => {
    setEditing(entry);
    setModalOpen(true);
  }, []);

  const now = Date.now();
  const list = (schedulers ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const anyRunning = list.some((s) => s.running || s.id === manualRunningId);
  // The error dot reflects recent activity only: a failure recorded before this
  // server process started (stale, from the previous lifecycle) must not keep
  // lighting the indicator after a fresh start. Runs from the current
  // lifetime still show their errors as before.
  const recentFailed = (s: SchedulerWithState) => {
    const run = s.runs[0];
    if (!run) return false;
    if (run.status !== "error" && run.status !== "timeout" && run.status !== "missed") return false;
    if (engineStartedAt !== null) {
      const started = new Date(run.startedAt).getTime();
      if (Number.isFinite(started) && started < engineStartedAt) return false;
    }
    return true;
  };
  const anyFailed = list.some(recentFailed);
  const runningCount = list.filter((s) => s.running || s.id === manualRunningId).length;
  const failedCount = list.filter(recentFailed).length;
  // The expanded detail is bounded to the section's usable height so its
  // content scrolls internally and the control buttons stay pinned (visible)
  const detailMaxHeight = Math.max(120, height - 90);
  return (
    <div style={{ flexShrink: 0 }}>
      {open && (
        <SeparatorHandle
          label={t("sessionSidebar.schedulers")}
          ariaLabel={t("sessionSidebar.resizeSection", { name: t("sessionSidebar.schedulers") })}
          dragging={resize.dragging}
          onMouseDown={resize.start}
          onDoubleClick={resize.reset}
          onKeyDown={resize.handleKeyDown}
        />
      )}
    <div style={{ display: "flex", flexDirection: "column", flexShrink: 0, height: open ? height : undefined, overflow: "hidden", transition: anyDragging ? "none" : "height var(--dur-med) var(--ease-out-warm)" }}>
      <div ref={headerRef} className="sidebar-section-header" style={{ display: "flex", alignItems: "center", flexShrink: 0, borderTop: "1px solid var(--border)", paddingRight: 6, transition: "background var(--dur-fast) var(--ease-out-warm)" }}>
        <Tooltip content={t("sessionSidebar.schedulers")}>
          <button
          type="button"
          className="sidebar-section-title"
          onClick={() => onOpenChange(!open)}
          aria-expanded={open}
          style={{
            flex: 1,
            minWidth: 0,
            height: 32,
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "0 4px 0 12px",
            background: "none",
            border: "none",
            cursor: "pointer",
            textAlign: "left",
            fontSize: "calc(11px * var(--ui-font-scale-lg, 1))",
            fontWeight: 600,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
          }}
        >
          <Clock size={14} strokeWidth={2} aria-hidden="true" style={{ color: "var(--accent)", flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("sessionSidebar.schedulers")}
            {list.length > 0 && <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}> {list.length}</span>}
          </span>
          {anyRunning && (
            <Tooltip content={t("schedulers.dotCounts", { running: runningCount, failed: failedCount })}>
              <span
              aria-label={t("schedulers.dotCounts", { running: runningCount, failed: failedCount })}
              style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)", flexShrink: 0, animation: "pulse 1.4s ease-in-out infinite", display: "inline-block" }}
            />
            </Tooltip>
          )}
          {!anyRunning && anyFailed && (
            <Tooltip content={t("schedulers.dotCounts", { running: runningCount, failed: failedCount })}>
              <span
              aria-label={t("schedulers.dotCounts", { running: runningCount, failed: failedCount })}
              style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--status-error)", flexShrink: 0, display: "inline-block" }}
            />
            </Tooltip>
          )}
        </button>
        </Tooltip>
        <Tooltip content={t("schedulers.add")}>
          <button
          type="button"
          onClick={openAdd}
          aria-label={t("schedulers.add")}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 26,
            height: 26,
            marginRight: 6,
            padding: 0,
            flexShrink: 0,
            lineHeight: 0,
            background: "none",
            border: "none",
            borderRadius: "var(--radius-control)",
            color: "var(--text-dim)",
            cursor: "pointer",
            transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
        >
          <Plus size={12} aria-hidden="true" />
        </button>
        </Tooltip>
        <SectionChevron open={open} />
      </div>

      {open && (
        <div
          className="animate-slide-down"
          style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "8px 12px 12px", display: "flex", flexDirection: "column", gap: 6 }}
        >
          {loadError && (
            <span style={{ fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--status-error)" }}>{t("schedulers.loadError")}</span>
          )}
          {!loadError && !loadedRef.current && (
            <span style={{ fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)" }}>{t("schedulers.loading")}</span>
          )}
          {!loadError && list.length === 0 && (
            <>
              <span style={{ fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)" }}>{t("schedulers.empty")}</span>
              <button type="button" className="github-status-dialog-button" onClick={openAdd} style={{ alignSelf: "flex-start" }}>
                <Plus size={12} aria-hidden="true" />
                {t("schedulers.add")}
              </button>
            </>
          )}

          {list.map((s) => {
            const status = effectiveStatus(s, s.id === manualRunningId);
            const last = s.id === manualRunningId ? undefined : s.runs[0];
            const expanded = expandedId === s.id;
            const nextLabel = s.nextRunAt ? relTime(s.nextRunAt, now) : null;
            return (
              <div
                key={s.id}
                style={{
                  flexShrink: 0,
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  background: "var(--bg-subtle)",
                  overflow: "hidden",
                }}
              >
                <button
                  type="button"
                  onClick={() => setExpandedId(expanded ? null : s.id)}
                  aria-expanded={expanded}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "7px 9px",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <StatusDot status={status} />
                  <Tooltip content={s.name}>
                    <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: "calc(12px * var(--ui-font-scale-lg, 1))",
                      fontWeight: 500,
                      color: s.enabled || s.running ? "var(--text)" : "var(--text-dim)",
                    }}
                  >
                    {s.name}
                  </span>
                  </Tooltip>
                  <ChevronDown
                    size={12}
                    aria-hidden="true"
                    style={{ color: "var(--text-dim)", flexShrink: 0, transform: expanded ? "rotate(180deg)" : "none", transition: "transform var(--dur-fast) var(--ease-out-warm)" }}
                  />
                </button>
                <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 9px 7px 24px", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--text-muted)", minWidth: 0 }}>
                  <Tooltip content={s.human}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
                    {s.human}
                  </span>
                  </Tooltip>
                  {status === "running" ? (
                    <span style={{ color: "var(--accent)", flexShrink: 0 }}>{t("schedulers.status.running")}</span>
                  ) : !s.enabled ? (
                    <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>{t("schedulers.disabled")}</span>
                  ) : nextLabel ? (
                    <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>{nextLabel}</span>
                  ) : null}
                </div>

                {expanded && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "6px 9px 9px", borderTop: "1px solid var(--border)", maxHeight: detailMaxHeight, overflow: "hidden" }}>
                    <Tooltip content={s.script}>
                      <span style={{ fontSize: "calc(10.5px * var(--ui-font-scale-sm, 1))", fontFamily: "var(--font-mono)", color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {s.script}
                      {s.args.length > 0 && ` ${s.args.join(" ")}`}
                    </span>
                    </Tooltip>
                    <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", overflowX: "hidden", display: "flex", flexDirection: "column", gap: 6 }}>
                    {s.id === manualRunningId ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--accent)" }}>
                        <LoaderCircle size={12} className="animate-spin" aria-hidden="true" />
                        {t("schedulers.status.running")}…
                      </span>
                    ) : last ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", flexWrap: "wrap" }}>
                        <span style={{ fontWeight: 500, color: statusColor(last.status) }}>
                          {t(`schedulers.status.${last.status}`)}
                        </span>
                        <span style={{ color: "var(--text-dim)" }}>
                          {t("schedulers.lastRun")}: {relTime(last.startedAt, now) ?? "—"}
                        </span>
                        {last.manual && <span style={{ color: "var(--text-dim)" }}>· {t("schedulers.manual")}</span>}
                        {last.late && <span style={{ color: "var(--status-warning)" }}>· {t("schedulers.late")}</span>}
                        {durationMs(last) && <span style={{ color: "var(--text-dim)" }}>· {durationMs(last)}</span>}
                        {last.exitCode !== undefined && last.status === "error" && (
                          <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>exit {last.exitCode}</span>
                        )}
                      </div>
                    ) : (
                      <span style={{ fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)" }}>{t("schedulers.neverRun")}</span>
                    )}
                    {s.id !== manualRunningId && last?.stderr && (
                      <pre
                        style={{
                          margin: 0,
                          padding: "6px 8px",
                          borderRadius: 5,
                          background: "var(--bg-panel)",
                          border: "1px solid var(--border)",
                          fontSize: "calc(10.5px * var(--ui-font-scale-sm, 1))",
                          fontFamily: "var(--font-mono)",
                          color: "var(--status-error)",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          minHeight: 30,
                          maxHeight: 140,
                          overflowY: "auto",
                        }}
                      >
                        {last.stderr}
                      </pre>
                    )}
                    {!last?.stderr && last?.stdout && (
                      <pre
                        style={{
                          margin: 0,
                          padding: "6px 8px",
                          borderRadius: 5,
                          background: "var(--bg-panel)",
                          border: "1px solid var(--border)",
                          fontSize: "calc(10.5px * var(--ui-font-scale-sm, 1))",
                          fontFamily: "var(--font-mono)",
                          color: "var(--text-dim)",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          minHeight: 30,
                          maxHeight: 140,
                          overflowY: "auto",
                        }}
                      >
                        {last.stdout}
                      </pre>
                    )}

                    {s.id !== manualRunningId && s.runs.length > 1 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <span style={{ fontSize: "calc(10px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)", fontWeight: 600 }}>{t("schedulers.runs")}</span>
                        {s.runs.slice(1, 6).map((run) => (
                          <div key={run.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "calc(10.5px * var(--ui-font-scale-sm, 1))", color: "var(--text-muted)" }}>
                            <StatusDot status={run.status} />
                            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {t(`schedulers.status.${run.status}`)}
                              {run.manual ? ` · ${t("schedulers.manual")}` : ""}
                            </span>
                            <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>
                              {relTime(run.startedAt, now) ?? ""}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    </div>
                    <div style={{ flexShrink: 0, display: "flex", gap: 5, alignItems: "center" }}>
                      <IconButton
                        label={t("schedulers.runNow")}
                        busy={runBusyId === s.id}
                        onClick={() => void runNow(s.id)}
                        icon={<Play size={12} aria-hidden="true" />}
                      />
                      <IconButton
                        label={s.enabled ? t("schedulers.disable") : t("schedulers.enable")}
                        busy={toggleBusyId === s.id}
                        onClick={() => void toggleEnabled(s)}
                        icon={<Power size={12} aria-hidden="true" />}
                        active={s.enabled}
                      />
                      <IconButton label={t("schedulers.edit")} onClick={() => openEdit(s)} icon={<Pencil size={12} aria-hidden="true" />} />
                      <IconButton
                        label={t("schedulers.clearRuns")}
                        busy={clearBusyId === s.id}
                        onClick={() => void clearRunsFor(s.id)}
                        icon={<Eraser size={12} aria-hidden="true" />}
                      />
                      <IconButton label={t("schedulers.delete")} onClick={() => setDeleteTarget(s)} icon={<Trash2 size={12} aria-hidden="true" />} />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>

      <SchedulerModal
        open={modalOpen}
        initial={editing}
        onClose={() => setModalOpen(false)}
        onSaved={load}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
        title={t("schedulers.deleteConfirm")}
        description={deleteTarget ? t("schedulers.deleteDesc", { name: deleteTarget.name }) : ""}
        confirmLabel={t("schedulers.delete")}
        danger
        busy={deleting}
        onConfirm={() => void remove()}
      />
    </div>
  );
}

function IconButton({
  label,
  icon,
  onClick,
  busy,
  active,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  busy?: boolean;
  active?: boolean;
}) {
  return (
    <Tooltip content={label}>
      <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={label}
      style={{
        display: "grid",
        placeItems: "center",
        width: 24,
        height: 24,
        padding: 0,
        border: "1px solid var(--border)",
        borderRadius: 5,
        background: active ? "var(--bg-selected)" : "var(--bg-panel)",
        color: busy ? "var(--text-dim)" : active ? "var(--accent)" : "var(--text-dim)",
        cursor: busy ? "wait" : "pointer",
        flexShrink: 0,
      }}
    >
      {busy ? <LoaderCircle size={12} className="animate-spin" aria-hidden="true" /> : icon}
    </button>
    </Tooltip>
  );
}
