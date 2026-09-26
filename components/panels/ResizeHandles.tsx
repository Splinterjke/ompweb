"use client";
import { Tooltip } from "../ui/primitives";

import type { ResizeHandleKind } from "@/hooks/useResizableDialog";
import { GripVertical } from "lucide-react";

/** Drag handles along the dialog's right/bottom edges + corner.  The narrow
 *  edge remains easy to grab, while the small visible grip teaches the resize
 *  affordance without adding another toolbar button. */
export function ResizeHandles({ onPointerDown, onPointerMove, onPointerUp, isResizing = false }: {
  onPointerDown: (kind: ResizeHandleKind) => (e: React.PointerEvent) => void;
  onPointerMove?: (e: React.PointerEvent) => void;
  onPointerUp?: (e: React.PointerEvent) => void;
  isResizing?: boolean;
}) {
  const handle = (kind: ResizeHandleKind) => ({
    onPointerDown: onPointerDown(kind),
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    onLostPointerCapture: onPointerUp,
    "data-resize": kind,
  });
  return (
    <>
      {/* Right edge */}
            <Tooltip content="Drag to resize the settings window width">
        <div
          {...handle("right")}
          aria-label="Drag to resize the settings window width"
          style={{
            position: "absolute", top: 0, right: 0, bottom: 0, width: 14,
            cursor: "ew-resize", touchAction: "none", zIndex: 20,
            background: isResizing ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "transparent",
          }}
        >
          <span aria-hidden="true" style={{ position: "absolute", top: "50%", right: 2, display: "inline-flex", transform: "translateY(-50%)", color: "var(--text-dim)", opacity: isResizing ? 0.9 : 0.6, pointerEvents: "none", transition: "opacity var(--dur-fast) var(--ease-out-warm)" }}>
            <GripVertical size={16} strokeWidth={2} />
          </span>
        </div>
      </Tooltip>
      {/* Bottom edge */}
            <Tooltip content="Drag to resize the settings window height">
        <div
          {...handle("bottom")}
          aria-label="Drag to resize the settings window height"
          style={{
            position: "absolute", left: 0, right: 0, bottom: 0, height: 7,
            cursor: "ns-resize", touchAction: "none", zIndex: 20,
          }}
        />
      </Tooltip>
      {/* Bottom-right corner */}
            <Tooltip content="Drag to resize the settings window">
        <div
          {...handle("corner")}
          aria-label="Drag to resize the settings window"
          style={{
            position: "absolute", right: 0, bottom: 0, width: 18, height: 18,
            cursor: "nwse-resize", touchAction: "none", zIndex: 21,
          }}
        />
      </Tooltip>
    </>
  );
}
