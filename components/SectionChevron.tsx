"use client";

import { ChevronRight } from "lucide-react";

/**
 * Pure collapse-state indicator for a sidebar section header (Workspaces /
 * Explorer / Schedulers / Usage). Icon only, deliberately not a button: the
 * header's label button already toggles the section, so the chevron just
 * mirrors open/closed state at the end of the header row.
 */
export function SectionChevron({ open }: { open: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "var(--text-dim)",
      }}
    >
      <ChevronRight
        size={12}
        strokeWidth={1.8}
        style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform var(--dur-med) var(--ease-out-warm)" }}
      />
    </span>
  );
}
