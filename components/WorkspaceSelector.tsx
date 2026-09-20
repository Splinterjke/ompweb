"use client";

import { useState } from "react";
import { ChevronDown, Folder, Plus } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { comparableProjectPath } from "@/lib/comparable-path";
import type { ManagedProject } from "@/lib/types";

/** Final folder name of a project path, portable across / and \ separators. */
function folderName(projectPath: string): string {
  const trimmed = projectPath.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

interface Option {
  /** The cwd handed to `onSelect` when this radio is chosen. */
  value: string;
  /** Bright label: alias or folder name (suffixed when labels collide). */
  label: string;
  /** Dimmed full path shown next to the label. */
  path: string;
  checked: boolean;
}

interface WorkspaceSelectorProps {
  projects: ManagedProject[];
  /** The currently selected workspace cwd (never null when rendered). */
  selectedPath: string | null;
  onSelect: (cwd: string) => void;
  /** Opens the add-workspace dialog. */
  onAdd: () => void;
  /** Initial expansion (default: collapsed). */
  defaultExpanded?: boolean;
}

/**
 * New-session workspace picker modeled on the composer "Tasks" bar: a
 * collapsible card whose header shows the bright "Workspace" title and the
 * dimmed selected path, and whose expanded body is a radio group of the
 * managed workspaces plus an "Add workspace" entry.
 */
export function WorkspaceSelector({ projects, selectedPath, onSelect, onAdd, defaultExpanded = false }: WorkspaceSelectorProps) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(!defaultExpanded);

  // Build the radio options, mirroring the old <select>: a top entry for the
  // current cwd when it is not among the managed projects, then one per
  // project. Colliding labels get a " — path" suffix.
  const selectedKey = selectedPath ? comparableProjectPath(selectedPath) : null;
  const labelCounts = new Map<string, number>();
  for (const project of projects) {
    const label = project.alias ?? folderName(project.path);
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }
  const options: Option[] = [];
  if (selectedPath && selectedKey && !projects.some((project) => comparableProjectPath(project.path) === selectedKey)) {
    options.push({ value: selectedPath, label: folderName(selectedPath), path: selectedPath, checked: true });
  }
  for (const project of projects) {
    const isCurrent = selectedKey !== null && comparableProjectPath(project.path) === selectedKey;
    const rawLabel = project.alias ?? folderName(project.path);
    const duplicate = (labelCounts.get(rawLabel) ?? 0) > 1;
    options.push({
      value: isCurrent && selectedPath ? selectedPath : project.path,
      label: duplicate ? `${rawLabel} — ${project.path}` : rawLabel,
      path: project.path,
      checked: isCurrent,
    });
  }

  return (
    <section
      aria-label={t("settingsConfig.chipWorkspace")}
      className="mb-4 w-full overflow-hidden border border-border bg-bg-subtle"
      style={{ borderRadius: "var(--radius-card)" }}
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
        title={collapsed ? t("chatWindow.expandPanel") : t("chatWindow.collapsePanel")}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs text-text-muted"
        style={{ background: "none", borderBottom: collapsed ? "none" : "1px solid var(--border)" }}
      >
        <Folder size={15} strokeWidth={1.8} aria-hidden />
        <strong className="shrink-0 font-medium text-text">{t("settingsConfig.chipWorkspace")}</strong>
        {selectedPath && (
          <span
            className="ml-1 min-w-0 overflow-hidden text-ellipsis text-text-dim"
            style={{ fontFamily: "var(--font-mono)", fontSize: "calc(11px * var(--ui-font-scale, 1))", whiteSpace: "nowrap" }}
            title={selectedPath}
          >
            {selectedPath}
          </span>
        )}
        <ChevronDown
          size={14}
          strokeWidth={1.8}
          aria-hidden
          className="ml-auto shrink-0"
          style={{
            color: "var(--text-dim)",
            transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
            transition: "transform var(--dur-med) var(--ease-out-warm)",
          }}
        />
      </button>

      {!collapsed && (
        <div className="grid gap-1 overflow-y-auto px-2 py-2 animate-slide-down" style={{ maxHeight: "min(40vh, 320px)" }} role="radiogroup" aria-label={t("settingsConfig.chipWorkspace")}>
          {options.map((option) => (
            <label
              key={option.value}
              className="flex min-w-0 cursor-pointer items-center gap-2.5 rounded px-2 py-1.5"
              style={{
                background: option.checked ? "color-mix(in srgb, var(--accent) 12%, var(--bg-subtle))" : "transparent",
              }}
            >
              <input
                type="radio"
                name="new-session-workspace"
                value={option.value}
                checked={option.checked}
                onChange={() => onSelect(option.value)}
                className="shrink-0"
                style={{ accentColor: "var(--accent)" }}
              />
              <span className="min-w-0" style={{ fontSize: "calc(13px * var(--ui-font-scale, 1))" }}>
                <span className="block overflow-hidden text-ellipsis text-text" style={{ whiteSpace: "nowrap" }} title={option.label}>
                  {option.label}
                </span>
                <span className="block overflow-hidden text-ellipsis text-text-dim" style={{ fontFamily: "var(--font-mono)", fontSize: "calc(11px * var(--ui-font-scale, 1))", whiteSpace: "nowrap" }} title={option.path}>
                  {option.path}
                </span>
              </span>
            </label>
          ))}
          <button
            type="button"
            onClick={onAdd}
            className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-accent hover:text-accent-hover"
          >
            <Plus size={14} strokeWidth={1.8} aria-hidden />
            {t("projects.add")}
          </button>
        </div>
      )}
    </section>
  );
}
