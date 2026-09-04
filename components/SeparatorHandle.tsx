"use client";

import { useI18n } from "@/lib/i18n";

/**
 * Zero-height horizontal divider at the top of a resizable sidebar section
 * (Explorer / Schedulers / Usage). It takes NO space in the layout — the
 * visible 4px grab line is absolutely positioned over the section's top
 * border — so sections keep their full height for content. Dragging resizes
 * the section below it; double-click restores the default height.
 * Keyboard: arrows resize, Enter/Space resets.
 */
export function SeparatorHandle({
  onMouseDown,
  onDoubleClick,
  onKeyDown,
  dragging = false,
  label,
  ariaLabel,
}: {
  onMouseDown: (e: { clientY: number; preventDefault: () => void }) => void;
  onDoubleClick: () => void;
  onKeyDown: (e: { key: string; preventDefault: () => void }) => void;
  dragging?: boolean;
  label: string;
  ariaLabel: string;
}) {
  const { t } = useI18n();
  return (
    <div style={{ position: "relative", height: 0, flexShrink: 0 }}>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={ariaLabel}
        title={t("sessionSidebar.resizeSection", { name: label })}
        tabIndex={0}
        onMouseDown={onMouseDown}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          height: 4,
          zIndex: 1,
          cursor: "row-resize",
          touchAction: "none",
          outline: "none",
          background: dragging ? "var(--accent)" : "var(--border)",
          transition: "background var(--dur-fast) var(--ease-out-warm)",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
            width: 24,
            height: 2,
            borderRadius: 1,
            background: dragging ? "var(--accent)" : "var(--text-dim)",
            opacity: dragging ? 1 : 0.7,
            transition: "background var(--dur-fast) var(--ease-out-warm)",
          }}
        />
      </div>
    </div>
  );
}
