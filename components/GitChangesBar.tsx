"use client";
import { Tooltip } from "./ui/primitives";

import { useEffect, useState } from "react";
import { ChevronDown, GitBranch } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useGitStatus } from "@/hooks/useGitStatus";
import type { GitFileStatus } from "@/lib/git-types";
import { GitCommitForm } from "./GitCommitForm";

const STATUS_BADGE: Record<GitFileStatus["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflict: "C",
};

interface Props {
  cwd: string | null | undefined;
  /** Callback after a successful commit so the parent can invalidate caches. */
  onCommitted?: (hash: string) => void;
  /** Opens the Git tab in the right workbench. */
  onOpenGitTab?: () => void;
  /** Delivers a commit message to the agent instead of committing directly. */
  /** Return true when the prompt was actually sent (false = agent busy). */
  onCommitWithAgent?: (message: string) => boolean | Promise<boolean>;
  /** Controlled expanded state (parent owns the value). When omitted the bar
   *  keeps its own internal state. */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** Reports whether the bar has renderable content (repo with changes).
   *  Fires after mount and whenever the presence changes. */
  onPresenceChange?: (present: boolean) => void;
}

/**
 * Compact bar shown above the composer with live git-changes summary
 * (added / modified / deleted / untracked counts, +N/-N line diff) and
 * a commit form.
 *
 * Uses the shared {@link useGitStatus} hook (5 s poll + visibility refresh)
 * so the bar stays in sync with the Git tab without duplicating logic.
 */
export function GitChangesBar({ cwd, onCommitted, onOpenGitTab, onCommitWithAgent, expanded: expandedProp, onExpandedChange, onPresenceChange }: Props) {
  const { t } = useI18n();
  const { status, refresh } = useGitStatus(cwd, true);
  const [internalExpanded, setInternalExpanded] = useState(false);
  const isControlled = onExpandedChange !== undefined;
  const expanded = isControlled ? (expandedProp ?? false) : internalExpanded;
  const toggleExpanded = () => {
    const next = !expanded;
    if (!isControlled) setInternalExpanded(next);
    onExpandedChange?.(next);
  };

  const hasContent = Boolean(status?.isGitRepository && status.files.length > 0);
  useEffect(() => {
    onPresenceChange?.(hasContent);
  }, [hasContent, onPresenceChange]);

  if (!status || !status.isGitRepository) return null;

  const files = status.files;
  const counts: Record<GitFileStatus["status"], number> = {
    added: 0,
    modified: 0,
    deleted: 0,
    renamed: 0,
    untracked: 0,
    conflict: 0,
  };
  for (const f of files) counts[f.status]++;
  const total = files.length;
  if (total === 0) return null;

  const diffAdded = status.diffAdded ?? 0;
  const diffDeleted = status.diffDeleted ?? 0;

  return (
    <div className="chat-git-bar">
      <button
        type="button"
        className="chat-git-bar__header composer-panel-header"
        onClick={toggleExpanded}
        aria-expanded={expanded}
      >
        <GitBranch size={14} aria-hidden />
        <span className="chat-git-bar__branch">{status.branch ?? "…"}</span>
        <span className="chat-git-bar__stats">
          {counts.added > 0 && <span className="chat-git-bar__stat chat-git-bar__stat--added">+{counts.added}</span>}
          {counts.modified > 0 && <span className="chat-git-bar__stat chat-git-bar__stat--modified">M {counts.modified}</span>}
          {counts.deleted > 0 && <span className="chat-git-bar__stat chat-git-bar__stat--deleted">-{counts.deleted}</span>}
          {counts.renamed > 0 && <span className="chat-git-bar__stat chat-git-bar__stat--renamed">R {counts.renamed}</span>}
          {counts.untracked > 0 && <span className="chat-git-bar__stat chat-git-bar__stat--untracked">U {counts.untracked}</span>}
          {counts.conflict > 0 && <span className="chat-git-bar__stat chat-git-bar__stat--conflict">C {counts.conflict}</span>}
          {(diffAdded > 0 || diffDeleted > 0) && (
            <Tooltip content={t("gitChangesBar.diffLines")}>
              <span
              className="chat-git-bar__stat chat-git-bar__stat-lines"
            >
              <span className="chat-git-bar__stat--added">+{diffAdded}</span>
              <span className="chat-git-bar__stat--deleted">−{diffDeleted}</span>
            </span>
            </Tooltip>
          )}
        </span>
        <ChevronDown
          size={14}
          strokeWidth={1.8}
          aria-hidden
          style={{
            flexShrink: 0,
            color: "var(--text-dim)",
            transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
            transition: "transform var(--dur-med) var(--ease-out-warm)",
          }}
        />
      </button>

      {expanded && (
        <div className="chat-git-bar__body">
          <div className="chat-git-bar__files" role="list">
            {files.map((f) => (
              <div key={f.filePath} className="chat-git-bar__file" role="listitem">
                <span className={`chat-git-bar__file-status chat-git-bar__file-status--${f.status}`}>
                  {STATUS_BADGE[f.status]}
                </span>
                <Tooltip content={f.filePath}>
                  <span className="chat-git-bar__file-path">
                  {f.filePath}
                </span>
                </Tooltip>
              </div>
            ))}
          </div>

          <GitCommitForm
            cwd={cwd!}
            onCommitted={(hash) => {
              onCommitted?.(hash);
              void refresh();
            }}
            onCommitWithAgent={onCommitWithAgent}
            onOpenGitTab={onOpenGitTab}
          />
        </div>
      )}
    </div>
  );
}
