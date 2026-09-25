import type { ReactNode } from "react";
import { CircleAlert, MessageSquareText } from "lucide-react";

type WorkspaceStateKind = "loading" | "error" | "empty";

/** Unified loading, error, and empty state for full-panel surfaces. The
 *  low-elevation surface keeps status feedback clear without turning the
 *  workspace into a collection of floating cards. */
export function WorkspaceState({
  kind,
  title,
  detail,
}: {
  kind: WorkspaceStateKind;
  title: string;
  detail?: ReactNode;
}) {
  return (
    <div
      className={`workspace-state workspace-state-${kind}`}
      role={kind === "error" ? "alert" : kind === "loading" ? "status" : undefined}
      aria-busy={kind === "loading" ? true : undefined}
      aria-label={kind === "loading" ? title : undefined}
    >
      <div className="workspace-state-surface">
        {kind === "loading" ? (
          <div className="workspace-state-skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        ) : kind === "error" ? (
          <CircleAlert className="workspace-state-icon" size={18} strokeWidth={1.8} aria-hidden="true" />
        ) : (
          <MessageSquareText className="workspace-state-icon" size={18} strokeWidth={1.8} aria-hidden="true" />
        )}
        <div className="workspace-state-copy">
          <div className="workspace-state-title">{title}</div>
          {detail ? <div className="workspace-state-detail">{detail}</div> : null}
        </div>
      </div>
    </div>
  );
}
