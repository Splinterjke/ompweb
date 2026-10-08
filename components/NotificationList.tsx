"use client";

import { BellOff, CheckCheck, Trash2, X } from "lucide-react";
import { useRef } from "react";
import { useI18n } from "@/lib/i18n";
import { ClampedDescription, descriptionBaseStyle, dismissButtonStyle, KindIcon, toastHistory, useToastHistory } from "./ui/toast";

/** Notifications workbench view: recent toasts and OS notifications, newest first. */
export function NotificationListView() {
  const { t, locale } = useI18n();
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
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          <ul style={{ listStyle: "none", margin: 0, padding: 4 }}>
            {entries.map((entry) => (
              <li key={entry.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: 8, borderRadius: "var(--radius-control)", background: entry.read ? undefined : "var(--bg-subtle)" }}>
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
                    rootRef.current?.focus();
                  }}
                  aria-label={t("appShell.notificationDismiss")}
                  title={t("appShell.notificationDismiss")}
                  className="toast-close-button ui-focus-ring"
                  style={dismissButtonStyle}
                >
                  <X size={12} strokeWidth={2} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
