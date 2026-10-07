"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Tooltip } from "./ui/primitives";
import { useI18n } from "@/lib/i18n";

const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;

/**
 * Fullscreen zoomable preview dialog (extracted from MermaidBlock so SVG
 * previews share the exact same surface). Renders a native <dialog> with a
 * zoom stepper, fit-to-width and close controls; the viewport closes on a
 * backdrop click and Escape never reaches the window-level abort listener.
 */
export function ZoomDialog({
  ariaLabel,
  title,
  children,
  onClose,
}: {
  ariaLabel: string;
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [zoom, setZoom] = useState(1);
  const { t } = useI18n();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();

    return () => {
      document.body.style.overflow = previousOverflow;
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="mermaid-zoom-dialog"
      aria-label={ariaLabel}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        // Do not let the Escape reach the window-level listener, which would
        // abort a running agent (same pattern as ImageLightbox).
        event.stopPropagation();
        onClose();
      }}
    >
      <div className="mermaid-zoom-layout">
        <div className="mermaid-zoom-toolbar">
          <span className="mermaid-zoom-title">{title}</span>
          <div className="mermaid-zoom-actions">
            <div className="mermaid-zoom-stepper">
              <Tooltip content={t("mermaidBlock.zoomOut")}>
                <button
                  type="button"
                  onClick={() => setZoom((value) => Math.max(ZOOM_MIN, value - ZOOM_STEP))}
                  disabled={zoom <= ZOOM_MIN}
                  aria-label={t("mermaidBlock.zoomOut")}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <path d="M5 12h14" />
                  </svg>
                </button>
              </Tooltip>
              <span className="mermaid-zoom-value">{Math.round(zoom * 100)}%</span>
              <Tooltip content={t("mermaidBlock.zoomIn")}>
                <button
                  type="button"
                  onClick={() => setZoom((value) => Math.min(ZOOM_MAX, value + ZOOM_STEP))}
                  disabled={zoom >= ZOOM_MAX}
                  aria-label={t("mermaidBlock.zoomIn")}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>
              </Tooltip>
            </div>
            <Tooltip content={t("mermaidBlock.fitToWidth")}>
              <button
                type="button"
                className="mermaid-zoom-icon-button"
                onClick={() => setZoom(1)}
                aria-label={t("mermaidBlock.fitToWidth")}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />
                </svg>
              </button>
            </Tooltip>
            <Tooltip content={t("mermaidBlock.close")}>
              <button
                type="button"
                className="mermaid-zoom-icon-button"
                onClick={onClose}
                aria-label={t("mermaidBlock.close")}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </Tooltip>
          </div>
        </div>
        <div
          className="mermaid-zoom-viewport"
          onClick={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <div
            className="mermaid-zoom-canvas"
            // Width-based zoom re-lays out the content on every step;
            // scale is composited. Top-left origin keeps growth scrollable
            // and anchored while zoomed.
            style={{ transform: `scale(${zoom})`, transformOrigin: "top left" }}
          >
            {children}
          </div>
        </div>
      </div>
    </dialog>
  );
}
