"use client";

import { BellOff, CheckCheck, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { ClampedDescription, createSwipeTracker, descriptionBaseStyle, dismissButtonStyle, DRAG_SLOP_PX, KindIcon, toastHistory, useDragClickGuard, useToastHistory, type SwipeTracker, type ToastHistoryEntry } from "./ui/toast";

/** Sideways travel that dismisses on release, the same distance as base-ui's toast swipe. */
const SWIPE_DISMISS_PX = 40;
/** Outlasts the 150ms exit transition; a timer, because a hidden panel cancels transitionend. */
const EXIT_MS = 200;

/** Notifications workbench view: recent toasts and OS notifications, newest first. */
export function NotificationListView() {
  const { t } = useI18n();
  const entries = useToastHistory();
  const unread = entries.reduce((count, entry) => (entry.read ? count : count + 1), 0);
  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rootRef} tabIndex={-1} style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column", outline: "none" }}>
      <div
        role="toolbar"
        aria-label={t("appShell.notifications")}
        style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0, padding: "3px 6px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}
      >
        {/* aria-disabled (not disabled) keeps the button focusable after use. */}
        <button
          type="button"
          onClick={toastHistory.markAllRead}
          aria-disabled={unread === 0}
          title={t("appShell.notificationsMarkRead")}
          aria-label={t("appShell.notificationsMarkRead")}
          className="shell-toolbar-btn ui-focus-ring"
          style={{ width: 26, height: 26 }}
        >
          <CheckCheck size={13} strokeWidth={2} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={toastHistory.clear}
          title={t("appShell.notificationsClear")}
          aria-label={t("appShell.notificationsClear")}
          className="shell-toolbar-btn ui-focus-ring"
          style={{ width: 26, height: 26 }}
        >
          <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
      {entries.length === 0 ? (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, textAlign: "center" }}>
          <BellOff size={26} strokeWidth={1.5} aria-hidden="true" style={{ color: "var(--text-dim)" }} />
          <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 600 }}>{t("appShell.notificationsEmpty")}</div>
        </div>
      ) : (
        // overflowX hidden: a row swiped away must not flash a horizontal scrollbar.
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
          <ul style={{ listStyle: "none", margin: 0, padding: 4 }}>
            {entries.map((entry) => (
              <NotificationRow key={entry.id} entry={entry} onDismissed={() => rootRef.current?.focus()} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * One notification. A touch or pen swipe sideways dismisses it, like Android;
 * a mouse drag keeps selecting text. The swipe can start anywhere on the row
 * except its buttons and links.
 */
function NotificationRow({ entry, onDismissed }: { entry: ToastHistoryEntry; onDismissed: () => void }) {
  const { t, locale } = useI18n();
  const clickGuard = useDragClickGuard();
  const drag = useRef<{ id: number; x: number; y: number; claimed: boolean; tracker: SwipeTracker } | null>(null);
  const [offset, setOffset] = useState(0);
  const [leaving, setLeaving] = useState<-1 | 1 | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => toastHistory.remove(entry.id), EXIT_MS);
    return () => clearTimeout(timer);
  }, [leaving, entry.id]);
  return (
    <li
      data-swipe-dismiss
      onPointerDown={(event) => {
        clickGuard.onPointerDown(event);
        // A second finger never takes over a swipe in progress; any other
        // leftover (a pen lifted outside the row) is simply replaced.
        if (drag.current?.claimed || leaving || event.pointerType === "mouse" || event.button !== 0) return;
        drag.current = null;
        if (event.target instanceof Element && event.target.closest("button, a, input, textarea, select")) return;
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, claimed: false, tracker: createSwipeTracker(event.clientX) };
      }}
      onPointerMove={(event) => {
        clickGuard.onPointerMove(event);
        const current = drag.current;
        if (!current || event.pointerId !== current.id) return;
        const dx = current.tracker.track(event.clientX);
        if (!current.claimed) {
          // Claim only a clearly sideways drag. A vertical one is the list
          // scrolling: touch-action pan-y hands it to the browser, which
          // then cancels this pointer.
          if (Math.abs(dx) < DRAG_SLOP_PX || Math.abs(dx) <= Math.abs(event.clientY - current.y)) return;
          current.claimed = true;
          setDragging(true);
          event.currentTarget.setPointerCapture(event.pointerId);
        }
        setOffset(dx);
      }}
      onPointerUp={(event) => {
        const current = drag.current;
        if (!current || event.pointerId !== current.id) return;
        drag.current = null;
        setDragging(false);
        const dx = event.clientX - current.x;
        // Judge the whole movement, not its path: a curved thumb stroke still
        // counts, but turning back toward the start puts the row back.
        if (current.claimed && Math.abs(dx) >= SWIPE_DISMISS_PX && Math.abs(dx) > Math.abs(event.clientY - current.y) && !current.tracker.pulledBack(event.clientX)) {
          setLeaving(dx > 0 ? 1 : -1);
        } else {
          setOffset(0);
        }
      }}
      onPointerCancel={(event) => {
        if (event.pointerId !== drag.current?.id) return;
        drag.current = null;
        setDragging(false);
        setOffset(0);
      }}
      onClickCapture={clickGuard.onClickCapture}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: 8,
        borderRadius: "var(--radius-control)",
        background: entry.read ? undefined : "var(--bg-subtle)",
        touchAction: "pan-y",
        transform: leaving ? `translateX(${leaving * 110}%)` : offset ? `translateX(${offset}px)` : undefined,
        opacity: leaving ? 0 : 1 - Math.min(Math.abs(offset) / 400, 0.5),
        transition: dragging ? "none" : "transform var(--dur-fast) var(--ease-out-warm), opacity var(--dur-fast) var(--ease-out-warm)",
      }}
    >
      <KindIcon kind={entry.kind} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
          <span className="display-serif" style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.4, overflowWrap: "anywhere" }}>{entry.title}</span>
          {!entry.read && (
            <span role="img" aria-label={t("appShell.notificationUnread")} style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)", flexShrink: 0, alignSelf: "center" }} />
          )}
          <time dateTime={new Date(entry.at).toISOString()} style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>
            {new Date(entry.at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}
          </time>
        </div>
        {entry.description != null && (
          <div style={{ ...descriptionBaseStyle, overflowWrap: "anywhere" }}>
            {entry.clamp ? <ClampedDescription>{entry.description}</ClampedDescription> : entry.description}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => {
          // Dismissing unmounts this button (and the list, if it was the
          // last entry); keep keyboard focus in the always-mounted view root.
          toastHistory.remove(entry.id);
          onDismissed();
        }}
        aria-label={t("appShell.notificationDismiss")}
        title={t("appShell.notificationDismiss")}
        className="toast-close-button ui-focus-ring"
        style={dismissButtonStyle}
      >
        <X size={12} strokeWidth={2} aria-hidden />
      </button>
    </li>
  );
}
