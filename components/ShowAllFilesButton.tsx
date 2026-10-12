"use client";

import { Eye, EyeOff } from "lucide-react";
import { Tooltip } from "./ui/primitives";
import { useI18n } from "@/lib/i18n";
import { useShowAllFiles } from "@/hooks/useShowAllFiles";

/**
 * "Show ignored files" toggle for the file explorer surfaces: the sidebar
 * section header (`sidebar` variant, next to the upload button) and the
 * right workbench's Files tab (`toolbar` variant). One shared preference
 * (useShowAllFiles) — flipping it here re-lists every mounted explorer.
 *
 * The icon reflects the current state: EyeOff while ignored files
 * (node_modules, .git, dist, target, …) are hidden, Eye while they show.
 */
export function ShowAllFilesButton({
  variant = "sidebar",
  side = "top",
}: {
  variant?: "sidebar" | "toolbar";
  side?: "top" | "bottom";
}) {
  const { t } = useI18n();
  const { showAllFiles, toggleShowAllFiles } = useShowAllFiles();
  const label = showAllFiles ? t("fileExplorer.hideIgnoredFiles") : t("fileExplorer.showIgnoredFiles");
  const title = showAllFiles ? t("fileExplorer.hideIgnoredFilesTitle") : t("fileExplorer.showIgnoredFilesTitle");

  if (variant === "toolbar") {
    return (
      <Tooltip content={title} side={side}>
        <button
          type="button"
          onClick={toggleShowAllFiles}
          aria-pressed={showAllFiles}
          aria-label={label}
          className="shell-toolbar-btn ui-focus-ring"
        >
          {showAllFiles ? <Eye size={16} strokeWidth={1.8} aria-hidden="true" /> : <EyeOff size={16} strokeWidth={1.8} aria-hidden="true" />}
        </button>
      </Tooltip>
    );
  }

  return (
    <Tooltip content={title} side={side}>
      <button
        type="button"
        onClick={toggleShowAllFiles}
        aria-pressed={showAllFiles}
        aria-label={label}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: 26, height: 26, padding: 0,
          background: "none",
          border: "none",
          color: showAllFiles ? "var(--accent)" : "var(--text-dim)",
          cursor: "pointer",
          borderRadius: "var(--radius-control)",
          flexShrink: 0,
          transition: "color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm)",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
      >
        {showAllFiles ? <Eye size={13} strokeWidth={2} aria-hidden="true" /> : <EyeOff size={13} strokeWidth={2} aria-hidden="true" />}
      </button>
    </Tooltip>
  );
}
