"use client";

import { useI18n } from "@/lib/i18n";
import { RefreshCw, Rocket, X } from "lucide-react";

/**
 * "OmpWeb started" / "OmpWeb updated" notice: shown once per server boot (after
 * a rebuild/restart or the first load) so the user sees the running Omp version.
 * When the boot was a rebuild (new bundle deployed), it says "OmpWeb updated"
 * and carries a "Refresh page" button under the text; a plain restart shows
 * "OmpWeb started" with no button (the running bundle is already current).
 * It sits in the top-right corner. Settings reuses it (without the Omp version)
 * to preview the notice.
 */
export function UpdateNoticeDialog({ ompVersion, isUpdate = false, onClose }: { ompVersion: string | null; isUpdate?: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const title = t(isUpdate ? "updateNotice.titleUpdated" : "updateNotice.title");
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: "fixed",
        top: 52,
        right: 24,
        zIndex: 1200,
        width: 320,
        maxWidth: "calc(100vw - 16px)",
        background: "var(--bg-panel)",
        border: "1px solid color-mix(in srgb, var(--accent) 40%, var(--border))",
        borderRadius: "var(--radius-modal)",
        boxShadow: "var(--shadow-modal)",
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 26,
            height: 26,
            borderRadius: 8,
            background: "color-mix(in srgb, var(--accent) 14%, transparent)",
            color: "var(--accent)",
            flexShrink: 0,
          }}
        >
          <Rocket size={14} aria-hidden="true" />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: "calc(13px * var(--ui-font-scale, 1))", fontWeight: 700, color: "var(--text)" }}>
            {title}
          </div>
          {ompVersion && (
            <div style={{ fontSize: "calc(12px * var(--ui-font-scale, 1))", color: "var(--text-muted)", marginTop: 2 }}>
              {t("updateNotice.startedOmp", { version: ompVersion })}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("updateNotice.dismiss")}
          className="shell-toolbar-btn ui-focus-ring"
          style={{ width: 24, height: 24, borderRadius: 6, flexShrink: 0 }}
        >
          <X size={14} />
        </button>
      </div>
      {isUpdate && (
        <button
          type="button"
          onClick={() => {
            // A rebuild/restart means this page is running the previous bundle.
            // Reloading is the only way to load the new one — the user opted in
            // by clicking here, so no desktop/mobile gating is needed.
            onClose();
            window.location.reload();
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            width: "100%",
            padding: "7px 0",
            border: "none",
            borderRadius: "var(--radius-control)",
            background: "var(--accent)",
            color: "var(--on-accent)",
            cursor: "pointer",
            fontSize: "calc(12px * var(--ui-font-scale, 1))",
            fontWeight: 600,
          }}
        >
          <RefreshCw size={13} aria-hidden="true" />
          {t("updateNotice.refreshPage")}
        </button>
      )}
    </div>
  );
}
