"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, LoaderCircle, Pencil, Power, Plus, Trash2, Zap } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { ConfirmDialog } from "./ui/field";
import { toast } from "./ui/toast";
import { CHAT_EVENT_TYPES, type ChatEventAction } from "@/lib/chat-event-action-types";
import { createOmpwebClient } from "@/lib/client";
import { EventActionModal } from "./EventActionModal";
import { SectionChevron } from "./SectionChevron";
import { SeparatorHandle } from "./SeparatorHandle";
import type { RefObject } from "react";

// Chat event action calls go through the OmpWebClient facade (doc 01 contract),
// the same route as the SchedulersPanel.
const client = createOmpwebClient("legacy-http");

function relTime(iso: string | undefined, now: number): string | null {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return null;
  const diff = now - ts;
  const minutes = Math.floor(Math.abs(diff) / 60_000);
  const suffix = diff < 0 ? "" : " ago";
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m${suffix}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${suffix}`;
  return `${Math.floor(hours / 24)}d${suffix}`;
}

/** The card's status dot: disabled/hollow when off, ok/error fill for the
 * last run, hollow for never-run. */
function StatusDot({ action }: { action: ChatEventAction }) {
  const run = action.lastRun;
  const hollow = !action.enabled || !run;
  const color = !action.enabled ? "var(--border)" : !run ? "var(--text-dim)" : run.ok ? "var(--status-success)" : "var(--status-error)";
  return (
    <span
      aria-hidden="true"
      title={!action.enabled ? "Disabled" : !run ? "Never run" : undefined}
      style={{
        width: 7,
        height: 7,
        borderRadius: "50%",
        flexShrink: 0,
        background: hollow ? "transparent" : color,
        border: hollow ? `1px solid ${color}` : "none",
      }}
    />
  );
}

/**
 * Sidebar "Chat event actions" panel: user-defined actions fired on chat
 * lifecycle events (notification / http / bash / scheduled-script). Mirrors
 * SchedulersPanel (header, resize handle, card rows, add/edit modal, toasts,
 * confirm delete) — except there is no run-history polling: actions fire on
 * demand, so the list refreshes on open and after every CRUD call.
 */
export function EventActionsPanel({
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
  const [actions, setActions] = useState<ChatEventAction[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ChatEventAction | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ChatEventAction | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [toggleBusyId, setToggleBusyId] = useState<string | null>(null);
  const loadedRef = useRef(false);

  const load = useCallback(() => {
    void client.chatActions
      .list()
      .then((data) => {
        setActions(data.actions);
        setLoadError(false);
        loadedRef.current = true;
      })
      .catch(() => setLoadError(true));
  }, []);

  // No polling — actions fire on chat events, not on a timer. Refresh when the
  // panel opens and after every CRUD operation (load is called from each).
  useEffect(() => {
    if (!open) return;
    load();
  }, [open, load]);

  const toggleEnabled = useCallback(
    async (entry: ChatEventAction) => {
      setToggleBusyId(entry.id);
      try {
        await client.chatActions.update(entry.id, { enabled: !entry.enabled });
        load();
      } catch (err) {
        const code = (err as { code?: string } | null)?.code ?? "generic";
        const key = `chatActions.error.${code}`;
        toast.error(t(key) === key ? t("chatActions.error.generic") : t(key));
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
      await client.chatActions.remove(deleteTarget.id);
      toast.success(t("chatActions.deleted"));
      setDeleteTarget(null);
      load();
    } catch {
      toast.error(t("chatActions.error.generic"));
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, load, t]);

  const openAdd = useCallback(() => {
    setEditing(null);
    setModalOpen(true);
  }, []);

  const openEdit = useCallback((entry: ChatEventAction) => {
    setEditing(entry);
    setModalOpen(true);
  }, []);

  const now = Date.now();
  const list = (actions ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const eventLabel = (type: (typeof CHAT_EVENT_TYPES)[number]) => t(`chatActions.event.${type}`);
  // The expanded detail is bounded to the section's usable height so its
  // content scrolls internally and the control buttons stay pinned (visible).
  const detailMaxHeight = Math.max(120, height - 90);

  return (
    <div style={{ flexShrink: 0 }}>
      {open && (
        <SeparatorHandle
          label={t("sessionSidebar.chatActions")}
          ariaLabel={t("sessionSidebar.resizeSection", { name: t("sessionSidebar.chatActions") })}
          dragging={resize.dragging}
          onMouseDown={resize.start}
          onDoubleClick={resize.reset}
          onKeyDown={resize.handleKeyDown}
        />
      )}
      <div style={{ display: "flex", flexDirection: "column", flexShrink: 0, height: open ? height : undefined, overflow: "hidden", transition: anyDragging ? "none" : "height var(--dur-med) var(--ease-out-warm)" }}>
        <div ref={headerRef} className="sidebar-section-header" style={{ display: "flex", alignItems: "center", flexShrink: 0, borderTop: "1px solid var(--border)", paddingRight: 6, transition: "background var(--dur-fast) var(--ease-out-warm)" }}>
          <button
            type="button"
            className="sidebar-section-title"
            onClick={() => onOpenChange(!open)}
            aria-expanded={open}
            title={t("sessionSidebar.chatActions")}
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
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
            }}
          >
            <Zap size={14} strokeWidth={2} aria-hidden="true" style={{ color: "var(--accent)", flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {t("sessionSidebar.chatActions")}
              {list.length > 0 && <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}> {list.length}</span>}
            </span>
          </button>
          <button
            type="button"
            onClick={openAdd}
            aria-label={t("chatActions.add")}
            title={t("chatActions.add")}
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
          <SectionChevron open={open} />
        </div>

        {open && (
          <div
            className="animate-slide-down"
            style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "8px 12px 12px", display: "flex", flexDirection: "column", gap: 6 }}
          >
            {loadError && (
              <span style={{ fontSize: 11, color: "var(--status-error)" }}>{t("chatActions.loadError")}</span>
            )}
            {!loadError && !loadedRef.current && (
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("chatActions.loading")}</span>
            )}
            {!loadError && list.length === 0 && (
              <>
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("chatActions.empty")}</span>
                <button type="button" className="github-status-dialog-button" onClick={openAdd} style={{ alignSelf: "flex-start" }}>
                  <Plus size={12} aria-hidden="true" />
                  {t("chatActions.add")}
                </button>
              </>
            )}

            {list.map((a) => {
              const expanded = expandedId === a.id;
              const run = a.lastRun;
              return (
                <div
                  key={a.id}
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
                    onClick={() => setExpandedId(expanded ? null : a.id)}
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
                    <StatusDot action={a} />
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontSize: 12,
                        fontWeight: 500,
                        color: a.enabled ? "var(--text)" : "var(--text-dim)",
                      }}
                      title={a.name}
                    >
                      {a.name}
                    </span>
                    <ChevronDown
                      size={12}
                      aria-hidden="true"
                      style={{ color: "var(--text-dim)", flexShrink: 0, transform: expanded ? "rotate(180deg)" : "none", transition: "transform var(--dur-fast) var(--ease-out-warm)" }}
                    />
                  </button>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 9px 7px 24px", fontSize: 11, color: "var(--text-muted)", minWidth: 0 }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }} title={a.events.map(eventLabel).join(", ")}>
                      {t(`chatActions.action.${a.action.type}`)} · {a.events.length} {a.events.length === 1 ? "event" : "events"}
                    </span>
                    {!a.enabled ? (
                      <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>{t("chatActions.disabled")}</span>
                    ) : run ? (
                      <span style={{ color: run.ok ? "var(--status-success)" : "var(--status-error)", flexShrink: 0 }}>
                        {t(run.ok ? "chatActions.status.ok" : "chatActions.status.fail")}
                      </span>
                    ) : null}
                  </div>

                  {expanded && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "6px 9px 9px", borderTop: "1px solid var(--border)", maxHeight: detailMaxHeight, overflow: "hidden" }}>
                      {/* The bound events: chips with one label each. */}
                      <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", overflowX: "hidden", display: "flex", flexDirection: "column", gap: 6 }}>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {a.events.map((ev) => (
                            <span
                              key={ev}
                              style={{
                                fontSize: 10,
                                padding: "2px 7px",
                                borderRadius: 999,
                                border: "1px solid var(--border)",
                                background: "var(--bg-panel)",
                                color: "var(--text-muted)",
                              }}
                            >
                              {eventLabel(ev)}
                            </span>
                          ))}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, flexWrap: "wrap" }}>
                          <span style={{ color: "var(--text-dim)" }}>
                            {t("chatActions.lastRun")}: {run ? (relTime(run.at, now) ?? "—") : t("chatActions.neverRun")}
                          </span>
                          {run && (
                            <span style={{ fontWeight: 500, color: run.ok ? "var(--status-success)" : "var(--status-error)" }}>
                              {t(run.ok ? "chatActions.status.ok" : "chatActions.status.fail")}
                            </span>
                          )}
                        </div>
                        {run?.detail && (
                          <pre
                            style={{
                              margin: 0,
                              padding: "6px 8px",
                              borderRadius: 5,
                              background: "var(--bg-panel)",
                              border: "1px solid var(--border)",
                              fontSize: 10.5,
                              fontFamily: "var(--font-mono)",
                              color: run.ok ? "var(--text-dim)" : "var(--status-error)",
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-word",
                              minHeight: 30,
                              maxHeight: 140,
                              overflowY: "auto",
                            }}
                          >
                            {run.detail}
                          </pre>
                        )}
                      </div>
                      <div style={{ flexShrink: 0, display: "flex", gap: 5, alignItems: "center" }}>
                        <IconButton
                          label={a.enabled ? t("chatActions.disable") : t("chatActions.enable")}
                          busy={toggleBusyId === a.id}
                          onClick={() => void toggleEnabled(a)}
                          icon={<Power size={12} aria-hidden="true" />}
                          active={a.enabled}
                        />
                        <IconButton label={t("chatActions.edit")} onClick={() => openEdit(a)} icon={<Pencil size={12} aria-hidden="true" />} />
                        <IconButton label={t("chatActions.delete")} onClick={() => setDeleteTarget(a)} icon={<Trash2 size={12} aria-hidden="true" />} />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <EventActionModal
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
        title={t("chatActions.deleteConfirm")}
        description={deleteTarget ? t("chatActions.deleteDesc", { name: deleteTarget.name }) : ""}
        confirmLabel={t("chatActions.delete")}
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
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={label}
      title={label}
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
  );
}
