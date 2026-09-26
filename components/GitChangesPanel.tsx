"use client";
import { Tooltip } from "./ui/primitives";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AtSign, Check, ExternalLink, GitBranch, RefreshCw, Search, X } from "lucide-react";
import { getFileIcon } from "./FileIcons";
import { DiffView } from "./FileViewer";
import { GIT_STATUS_COLORS, GIT_STATUS_LABEL_KEYS } from "./FileExplorer";
import { translate, useI18n } from "@/lib/i18n";
import {
  getFileDirectory,
  getFileName,
  getRelativeFilePath,
  normalizeFilePathSlashes,
} from "@/lib/file-paths";
import type { GitFileDiffResponse, GitStatusResponse } from "@/lib/git-types";
import { GitCommitForm } from "./GitCommitForm";
// Poll interval while the git tab is the active workbench view.
const GIT_POLL_INTERVAL_MS = 5000;

interface Props {
  cwd: string;
  active?: boolean;
  refreshKey?: number;
  onOpenFile: (filePath: string, fileName: string) => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onRefreshDone?: () => void;
}

async function fetchStatus(cwd: string): Promise<GitStatusResponse> {
  const params = new URLSearchParams({ cwd });
  const res = await fetch(`/api/git/status?${params.toString()}`);
  if (!res.ok) {
    throw new Error(translate("gitChanges.loadFailed", { status: res.status }));
  }
  return res.json() as Promise<GitStatusResponse>;
}

async function fetchPatch(cwd: string, filePath: string): Promise<GitFileDiffResponse> {
  const params = new URLSearchParams({ cwd, path: filePath });
  const res = await fetch(`/api/git/diff?${params.toString()}`);
  if (!res.ok) {
    throw new Error(translate("gitChanges.diffLoadFailed", { status: res.status }));
  }
  return res.json() as Promise<GitFileDiffResponse>;
}

export function GitChangesPanel({ cwd, active = true, refreshKey, onOpenFile, onAtMention, onRefreshDone }: Props) {
  const { t, tn } = useI18n();
  const [files, setFiles] = useState<GitStatusResponse["files"]>([]);
  const [isRepo, setIsRepo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [patch, setPatch] = useState<string | null>(null);
  const [patchSupported, setPatchSupported] = useState(true);
  const [patchLoading, setPatchLoading] = useState(false);
  const [patchError, setPatchError] = useState<string | null>(null);
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const patchRequestRef = useRef(0);
  // Bumped whenever a status poll observes a changed worktree; drives a
  // re-fetch of the selected file's diff so the preview never goes stale.
  const [statusVersion, setStatusVersion] = useState(0);
  const statusSignatureRef = useRef("");
  const refreshToken = `${refreshKey ?? 0}:${treeRefreshKey}`;

  // Keep the refresh-done callback in a ref so its identity cannot re-trigger
  // the fetch effect below (AppShell re-renders on every session boundary).
  const onRefreshDoneRef = useRef(onRefreshDone);
  onRefreshDoneRef.current = onRefreshDone;

  // The git tab used to fetch exactly once on mount, so files committed by
  // the agent (or a terminal) stayed listed as "changed" until a manual
  // refresh. While the tab is active we poll on a short interval and
  // re-fetch on tab re-focus; silent polls keep the last good data on a
  // transient error instead of blanking the panel.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    // A slow repository can outlive the 5s interval; never stack requests —
    // at most one in-flight fetch, the next tick catches up.
    let inFlight = false;
    const load = (silent: boolean) => {
      if (inFlight) return;
      inFlight = true;
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      fetchStatus(cwd)
        .then((status) => {
          if (cancelled) return;
          const nextFiles = status.isGitRepository ? status.files : [];
          setFiles(nextFiles);
          setIsRepo(status.isGitRepository);
          const signature = [
            status.isGitRepository ? 1 : 0,
            status.branch ?? "",
            status.ahead ?? 0,
            status.behind ?? 0,
            ...nextFiles.map((f) => `${f.filePath}|${f.status}|${f.indexStatus}|${f.worktreeStatus}`),
          ].join("\n");
          if (signature !== statusSignatureRef.current) {
            statusSignatureRef.current = signature;
            setStatusVersion((v) => v + 1);
          }
          // Keep the selection when it still exists; otherwise preview the first
          // changed file so the diff pane is never blank behind a file list.
          setSelectedPath((prev) =>
            prev && nextFiles.some((f) => f.filePath === prev)
              ? prev
              : nextFiles[0]?.filePath ?? null,
          );
          setError(null);
        })
        .catch((e) => {
          if (cancelled) return;
          if (silent) return; // keep the last good data on a transient failure
          setFiles([]);
          setIsRepo(false);
          setSelectedPath(null);
          setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          inFlight = false;
          if (cancelled || silent) return;
          setLoading(false);
          onRefreshDoneRef.current?.();
        });
    };
    load(false);
    const interval = window.setInterval(() => load(true), GIT_POLL_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") load(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [cwd, refreshToken, active]);

  useEffect(() => {
    if (!selectedPath) {
      setPatch(null);
      setPatchSupported(true);
      setPatchError(null);
      return;
    }
    const requestId = ++patchRequestRef.current;
    setPatchLoading(true);
    setPatchError(null);
    fetchPatch(cwd, selectedPath)
      .then((diff) => {
        if (requestId !== patchRequestRef.current) return;
        setPatchSupported(diff.supported);
        setPatch(typeof diff.patch === "string" ? diff.patch : null);
      })
      .catch((e) => {
        if (requestId !== patchRequestRef.current) return;
        setPatch(null);
        setPatchSupported(true);
        setPatchError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (requestId === patchRequestRef.current) setPatchLoading(false);
      });
  }, [cwd, selectedPath, refreshToken, statusVersion]);

  const filteredFiles = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) =>
      normalizeFilePathSlashes(getRelativeFilePath(f.filePath, cwd)).toLowerCase().includes(q),
    );
  }, [files, filter, cwd]);

  const selectedFile = selectedPath ? files.find((f) => f.filePath === selectedPath) ?? null : null;
  const selectedRelative = selectedPath ? getRelativeFilePath(selectedPath, cwd) : "";

  const openSelected = useCallback(() => {
    if (selectedPath) onOpenFile(selectedPath, getFileName(selectedPath));
  }, [selectedPath, onOpenFile]);

  const mentionSelected = useCallback(() => {
    if (selectedPath) onAtMention?.(getRelativeFilePath(selectedPath, cwd), false);
  }, [selectedPath, cwd, onAtMention]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 8px 4px",
          flexShrink: 0,
        }}
      >
        <Search size={13} strokeWidth={2} aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-dim)" }} />
        <input
          ref={filterInputRef}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setFilter("");
            }
          }}
          placeholder={t("gitChanges.filterFiles")}
          aria-label={t("gitChanges.filterFiles")}
          style={{
            flex: 1,
            minWidth: 0,
            height: 27,
            boxSizing: "border-box",
            padding: filter ? "0 8px" : "0 8px",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
            outline: "none",
            color: "var(--text)",
            fontSize: "calc(12px * var(--ui-font-scale-lg, 1))",
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border)"; }}
        />
        {filter && (
          <Tooltip content={t("fileExplorer.clearSearch")}>
            <button
            className="git-clear-filter"
            type="button"
            onClick={() => {
              setFilter("");
              filterInputRef.current?.focus();
            }}
            aria-label={t("fileExplorer.clearSearch")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 26, height: 26, padding: 0,
              background: "none", border: "none", borderRadius: "var(--radius-control)",
              color: "var(--text-dim)", cursor: "pointer", flexShrink: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-dim)"; }}
          >
            <X size={12} strokeWidth={2.4} aria-hidden="true" />
          </button>
          </Tooltip>
        )}
        <Tooltip content={t("gitChanges.refreshChanges")}>
          <button
          className="git-refresh"
          type="button"
          onClick={() => setTreeRefreshKey((k) => k + 1)}
          aria-label={t("gitChanges.refreshChanges")}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 26, height: 26, padding: 0,
            background: "none", border: "none", borderRadius: "var(--radius-control)",
            color: "var(--text-dim)", cursor: "pointer", flexShrink: 0,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
        >
          <RefreshCw size={13} strokeWidth={2} aria-hidden="true" />
        </button>
        </Tooltip>
      </div>

      {loading ? (
        <div role="status" aria-live="polite" style={{ padding: "8px 12px", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)" }}>{t("fileExplorer.loadingFiles")}</div>
      ) : error ? (
        <div role="alert" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 12px", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--status-error)" }}>
          <span>{error}</span>
          <button
            className="load-retry-button"
            type="button"
            onClick={() => setTreeRefreshKey((key) => key + 1)}
            style={{ minHeight: 32, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}
          >
            {t("chatWindow.retry")}
          </button>
        </div>
      ) : !isRepo ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, textAlign: "center" }}>
          <GitBranch size={26} strokeWidth={1.5} aria-hidden="true" style={{ color: "var(--text-dim)" }} />
          <div style={{ color: "var(--text)", fontSize: "calc(13px * var(--ui-font-scale-lg, 1))", fontWeight: 600 }}>{t("gitChanges.notARepo")}</div>
          <div style={{ color: "var(--text-dim)", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", lineHeight: 1.6, maxWidth: 260 }}>{t("gitChanges.notARepoHint")}</div>
        </div>
      ) : files.length === 0 ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, textAlign: "center" }}>
          <Check size={26} strokeWidth={1.5} aria-hidden="true" style={{ color: "var(--status-success)" }} />
          <div style={{ color: "var(--text)", fontSize: "calc(13px * var(--ui-font-scale-lg, 1))", fontWeight: 600 }}>{t("gitChanges.noChanges")}</div>
          <div style={{ color: "var(--text-dim)", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", lineHeight: 1.6, maxWidth: 260 }}>{t("gitChanges.noChangesHint")}</div>
        </div>
      ) : (
        <>
          <div style={{ padding: "0 12px 4px", fontSize: "calc(10px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)", flexShrink: 0 }}>
            {tn("gitChanges.filesChanged", files.length)}
          </div>
          <div role="listbox" aria-label={t("tabBar.git")} style={{ flex: "0 1 auto", maxHeight: "38%", minHeight: 60, overflowY: "auto", overflowX: "hidden", padding: "0 4px", flexShrink: 1, borderBottom: "1px solid var(--border)" }}>
            {filteredFiles.length === 0 ? (
              <div style={{ padding: "8px 12px", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)" }}>{t("fileExplorer.noMatchingFiles")}</div>
            ) : filteredFiles.map((file) => {
              const relative = getRelativeFilePath(file.filePath, cwd);
              const name = getFileName(relative);
              const directory = getFileDirectory(relative);
              const isSelected = file.filePath === selectedPath;
              const isHovered = file.filePath === hoveredPath;
              return (
                <div
                  className="git-change-row"
                  key={file.filePath}
                  role="option"
                  tabIndex={0}
                  aria-selected={isSelected}
                  aria-label={`${name} (${t(GIT_STATUS_LABEL_KEYS[file.status])})`}
                  onClick={() => setSelectedPath(file.filePath)}
                  onDoubleClick={() => onOpenFile(file.filePath, getFileName(file.filePath))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      onOpenFile(file.filePath, getFileName(file.filePath));
                    } else if (e.key === " ") {
                      e.preventDefault();
                      setSelectedPath(file.filePath);
                    }
                  }}
                  onMouseEnter={() => setHoveredPath(file.filePath)}
                  onMouseLeave={() => setHoveredPath((prev) => (prev === file.filePath ? null : prev))}
                  style={{
                    position: "relative",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    paddingLeft: 8,
                    paddingRight: 8,
                    height: 26,
                    cursor: "pointer",
                    background: isSelected ? "var(--bg-selected)" : isHovered ? "var(--bg-hover)" : "transparent",
                    borderRadius: "var(--radius-control)",
                    userSelect: "none",
                    boxShadow: isSelected ? "inset 2px 0 0 var(--accent)" : "none",
                    outline: "none",
                  }}
                >
                  <span style={{ flexShrink: 0, display: "flex", alignItems: "center", color: "var(--text-dim)" }}>
                    {getFileIcon(name, 14)}
                  </span>
                  <Tooltip content={file.filePath}>
                    <span
                    style={{
                      fontSize: "calc(12px * var(--ui-font-scale-lg, 1))",
                      color: "var(--text)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      flex: directory ? "0 0 auto" : 1,
                      maxWidth: directory ? "60%" : undefined,
                    }}
                  >
                    {name}
                  </span>
                  </Tooltip>
                  {directory && (
                    <Tooltip content={file.filePath}>
                      <span
                      style={{
                        flex: "1 1 auto",
                        minWidth: 0,
                        fontSize: "calc(11px * var(--ui-font-scale-sm, 1))",
                        color: "var(--text-dim)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        direction: "rtl",
                        textAlign: "left",
                      }}
                    >
                      {directory}
                    </span>
                    </Tooltip>
                  )}
                  <Tooltip content={t(GIT_STATUS_LABEL_KEYS[file.status])}>
                    <span
                    aria-hidden="true"
                    style={{
                      width: 14,
                      flexShrink: 0,
                      color: GIT_STATUS_COLORS[file.status],
                      fontFamily: "var(--font-mono)",
                      fontSize: "calc(11px * var(--ui-font-scale-sm, 1))",
                      fontWeight: 600,
                      textAlign: "center",
                    }}
                  >
                    {file.code}
                  </span>
                  </Tooltip>
                  {isHovered && (
                    <Tooltip content={t("gitChanges.openFile")}>
                      <button
                      className="git-change-open-action"
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenFile(file.filePath, getFileName(file.filePath));
                      }}
                      aria-label={t("gitChanges.openFile")}
                      style={{
                        position: "absolute",
                        right: 4,
                        top: "50%",
                        transform: "translateY(-50%)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 22,
                        height: 20,
                        background: "var(--bg-panel)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-control)",
                        color: "var(--text-muted)",
                        cursor: "pointer",
                      }}
                    >
                      <ExternalLink size={11} strokeWidth={2.2} aria-hidden="true" />
                    </button>
                    </Tooltip>
                  )}
                </div>
              );
            })}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 12px",
              borderBottom: "1px solid var(--border)",
              flexShrink: 0,
              minWidth: 0,
            }}
          >
            <Tooltip content={selectedRelative}>
              <span
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: "calc(11px * var(--ui-font-scale-sm, 1))",
                fontFamily: "var(--font-mono)",
                color: "var(--text)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {selectedRelative}
            </span>
            </Tooltip>
            {selectedFile && (
              <Tooltip content={t(GIT_STATUS_LABEL_KEYS[selectedFile.status])}>
                <span
                style={{
                  fontSize: "calc(10px * var(--ui-font-scale-sm, 1))",
                  fontWeight: 700,
                  color: GIT_STATUS_COLORS[selectedFile.status],
                  flexShrink: 0,
                }}
              >
                {t(GIT_STATUS_LABEL_KEYS[selectedFile.status])}
              </span>
              </Tooltip>
            )}
            {onAtMention && (
              <Tooltip content={t("fileExplorer.insertPathIntoChat")}>
                <button
                className="git-change-mention-action"
                type="button"
                onClick={mentionSelected}
                disabled={!selectedPath}
                aria-label={t("fileExplorer.insertPathIntoChat")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                  height: 22, padding: "0 7px",
                  background: "var(--bg-panel)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-control)",
                  color: selectedPath ? "var(--accent)" : "var(--text-dim)",
                  cursor: selectedPath ? "pointer" : "default",
                  opacity: selectedPath ? 1 : 0.6,
                  fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0,
                }}
              >
                <AtSign size={11} strokeWidth={2.2} aria-hidden="true" />
                {t("fileExplorer.mention")}
              </button>
              </Tooltip>
            )}
            <Tooltip content={t("gitChanges.openFile")}>
              <button
              className="git-change-footer-open"
              type="button"
              onClick={openSelected}
              disabled={!selectedPath}
              aria-label={t("gitChanges.openFile")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 26, height: 22, padding: 0,
                background: "var(--bg-panel)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-control)",
                color: "var(--text-muted)",
                cursor: selectedPath ? "pointer" : "default",
                opacity: selectedPath ? 1 : 0.6,
                flexShrink: 0,
              }}
            >
              <ExternalLink size={11} strokeWidth={2.2} aria-hidden="true" />
            </button>
            </Tooltip>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: "auto", background: "var(--bg)" }}>
            {patchLoading ? (
              <div role="status" aria-live="polite" style={{ padding: "12px 16px", fontSize: "calc(12px * var(--ui-font-scale-lg, 1))", color: "var(--text-dim)" }}>{t("fileViewer.loading")}</div>
            ) : patchError ? (
              <div role="alert" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "12px 16px", fontSize: "calc(12px * var(--ui-font-scale-lg, 1))", color: "var(--status-error)" }}>
                <span>{patchError}</span>
                <button
                  className="load-retry-button"
                  type="button"
                  onClick={() => setTreeRefreshKey((key) => key + 1)}
                  style={{ minHeight: 32, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}
                >
                  {t("chatWindow.retry")}
                </button>
              </div>
            ) : !patchSupported || patch === null ? (
              <div style={{ padding: "12px 16px", fontSize: "calc(12px * var(--ui-font-scale-lg, 1))", color: "var(--text-dim)" }}>{t("gitChanges.diffUnavailable")}</div>
            ) : (
              <DiffView patch={patch} />
            )}
          </div>
          <GitCommitForm
            cwd={cwd}
            className="chat-git-bar__commit--pinned"
            onCommitted={() => setTreeRefreshKey((k) => k + 1)}
          />
        </>
      )}
    </div>
  );
}
