"use client";

import { useState } from "react";
import { Bot, Check, ChevronDown, ExternalLink, Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { createOmpwebClient } from "@/lib/client";

const client = createOmpwebClient("legacy-http");

type CommitMode = "commit" | "agent";

interface Props {
  cwd: string;
  /** Callback after a direct commit succeeds, so callers can refresh. */
  onCommitted?: (hash: string) => void;
  /** Optional extra class for layout (e.g. width) in the Git tab. */
  className?: string;
  /**
   * Delivers the message to the agent instead of committing directly.
   * When provided, a "Commit with agent" mode is offered; the agent is
   * asked to stage + commit the workspace and may refine the message.
   * Return true when the prompt was actually sent (false = agent busy).
   */
  onCommitWithAgent?: (message: string) => boolean | Promise<boolean>;
  /** Renders an icon-only "Open Git tab" button in the same row as the
   *  input and commit button (used by the composer bar). */
  onOpenGitTab?: () => void;
}

/**
 * Shared commit form (message input + Commit / Commit-with-agent mode +
 * button). Used by both the composer GitChangesBar and the Git tab so the
 * commit UX is identical in the two surfaces.
 */
export function GitCommitForm({ cwd, onCommitted, onCommitWithAgent, className, onOpenGitTab }: Props) {
  const { t } = useI18n();
  const [mode, setMode] = useState<CommitMode>("commit");
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitHash, setCommitHash] = useState<string | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [agentDone, setAgentDone] = useState(false);
  const agentAvailable = Boolean(onCommitWithAgent);

  const handleCommit = async () => {
    if (!message.trim() || committing) return;

    if (mode === "agent" && onCommitWithAgent) {
      setCommitting(true);
      setCommitError(null);
      try {
        const sent = await onCommitWithAgent(message.trim());
        if (sent) {
          setMessage("");
          setAgentDone(true);
          window.setTimeout(() => setAgentDone(false), 3000);
        } else {
          setCommitError(t("gitChangesBar.agentBusy"));
        }
      } finally {
        setCommitting(false);
      }
      return;
    }

    setCommitting(true);
    setCommitError(null);
    try {
      const result = await client.git.commit(cwd, message.trim());
      setCommitHash((result.hash ?? "").slice(0, 8));
      setMessage("");
      onCommitted?.(result.hash ?? "");
      window.setTimeout(() => setCommitHash(null), 3000);
    } catch (e) {
      setCommitError(e instanceof Error ? e.message : String(e));
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div className={`chat-git-bar__commit${className ? ` ${className}` : ""}`}>
      <input
        type="text"
        className="chat-git-bar__input"
        placeholder={t("gitChangesBar.messagePlaceholder")}
        value={message}
        onChange={(e) => {
          setMessage(e.target.value);
          setCommitError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && message.trim()) void handleCommit();
        }}
        disabled={committing}
      />
      <div className="chat-git-bar__commit-actions">
        {commitError && (
          <span className="chat-git-bar__error" role="alert">
            {commitError}
          </span>
        )}
        {commitHash && (
          <span className="chat-git-bar__success" role="status">
            <Check size={13} aria-hidden /> {t("gitChangesBar.commitSuccess")} {commitHash}
          </span>
        )}
        {agentDone && (
          <span className="chat-git-bar__success" role="status">
            <Bot size={13} aria-hidden /> {t("gitChangesBar.agentRequested")}
          </span>
        )}
        {agentAvailable ? (
          <div className="git-commit-split">
            <button
              type="button"
              className="chat-git-bar__commit-btn"
              onClick={() => void handleCommit()}
              disabled={committing || !message.trim()}
            >
              {committing ? <Loader2 size={13} className="animate-spin" aria-hidden /> : mode === "agent" ? <Bot size={13} aria-hidden /> : <Check size={13} aria-hidden />}
              {committing ? t("gitChangesBar.committing") : mode === "agent" ? t("gitChangesBar.commitWithAgent") : t("gitChangesBar.commit")}
            </button>
            <button
              type="button"
              className="git-commit-split__chevron"
              onClick={() => setMode((m) => (m === "commit" ? "agent" : "commit"))}
              title={mode === "commit" ? t("gitChangesBar.commitWithAgent") : t("gitChangesBar.commitTitle")}
              aria-label={mode === "commit" ? t("gitChangesBar.commitWithAgent") : t("gitChangesBar.commitTitle")}
              aria-expanded={mode === "agent"}
            >
              <ChevronDown size={12} aria-hidden />
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="chat-git-bar__commit-btn"
            onClick={() => void handleCommit()}
            disabled={committing || !message.trim()}
          >
            {committing ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Check size={13} aria-hidden />}
            {committing ? t("gitChangesBar.committing") : t("gitChangesBar.commit")}
          </button>
        )}
      </div>
      {onOpenGitTab && (
        <button
          type="button"
          className="chat-git-bar__open-tab"
          onClick={onOpenGitTab}
          title={t("gitChangesBar.openGitTab")}
          aria-label={t("gitChangesBar.openGitTab")}
        >
          <ExternalLink size={13} aria-hidden />
        </button>
      )}
    </div>
  );
}
