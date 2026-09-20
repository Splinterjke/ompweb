"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, GitBranch, GitCommitHorizontal, LoaderCircle, RefreshCw, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n";
import { createOmpwebClient } from "@/lib/client";
import type { GitCommitFile, GitCommitInfo, GitGraphRow } from "@/lib/git-log";

const client = createOmpwebClient("legacy-http");
// Local branch lane colors — theme status vars only (no hardcoded colors).
const BRANCH_PALETTE = [
  "var(--status-success)",
  "var(--status-renamed)",
  "var(--status-warning)",
  "var(--status-modified)",
  "var(--status-error)",
] as const;
const DEFAULT_LANE = "var(--border)";

const LANE_W = 22;
const LANE_PAD_X = 10;
const COMMIT_ROW_H = 44;
const GAP_ROW_H = 12;
// Persisted pixel widths of the resizable files-list and file-diff panes.
// The commit tree is the flex remainder, so it keeps filling the remaining
// space at any modal size.
const FILES_WIDTH_KEY = "omp-web:git-graph-files-width";
const DIFF_WIDTH_KEY = "omp-web:git-graph-diff-width";
const FILES_MIN_WIDTH = 220;
const DIFF_MIN_WIDTH = 220;
const TREE_MIN_WIDTH = 260;
const FILES_FALLBACK_WIDTH = 320;
const DIFF_FALLBACK_WIDTH = 420;

type DiffState = { file: string; diff: string; binary: boolean; truncated: boolean } | null;

interface CommitLogPayload {
  rows: GitGraphRow[];
  maxLane: number;
}

/** Per-lane color per row: a lane takes the color of the nearest commit
 * above it that landed on that lane (HEAD → accent, branch → palette). */
function computeRowLaneColors(rows: GitGraphRow[], maxLane: number): string[][] {
  const branchColor: Record<string, number> = {};
  let branchCount = 0;
  const current: string[] = [];
  return rows.map((row) => {
    const out: string[] = [];
    for (let l = 0; l < maxLane; l++) {
      if (row.kind === "commit" && row.graph[l] === "C") {
        const refs = row.commit.refs;
        if (refs.head) {
          current[l] = "var(--accent)";
        } else if (refs.branches.length > 0) {
          const name = refs.branches[0];
          if (name in branchColor === false) branchColor[name] = branchCount++;
          current[l] = BRANCH_PALETTE[branchColor[name] % BRANCH_PALETTE.length];
        } else {
          current[l] = "var(--text-dim)";
        }
      }
      out[l] = current[l] ?? DEFAULT_LANE;
    }
    return out;
  });
}

function GraphStrip({ chars, height, colors, prevChars, nextChars }: {
  chars: string[];
  height: number;
  colors: string[];
  prevChars: string[] | null;
  nextChars: string[] | null;
}) {
  const width = LANE_PAD_X * 2 + (chars.length > 0 ? chars.length - 1 : 0) * LANE_W + LANE_W;
  const elements = [];
  for (let l = 0; l < chars.length; l++) {
    const ch = chars[l];
    if (ch === " ") continue;
    const x = LANE_PAD_X + l * LANE_W;
    const color = colors[l] ?? DEFAULT_LANE;
    switch (ch) {
      case "L":
        elements.push(<line key={l} x1={x} y1={0} x2={x} y2={height} stroke={color} strokeWidth={1.5} />);
        break;
      case "C": {
        const cy = 12;
        const up = prevChars?.[l] === "L" || prevChars?.[l] === "C" || prevChars?.[l] === "o";
        const down = nextChars?.[l] === "L" || nextChars?.[l] === "C" || nextChars?.[l] === "o";
        if (up) elements.push(<line key={`up-${l}`} x1={x} y1={0} x2={x} y2={cy} stroke={color} strokeWidth={1.5} />);
        if (down) elements.push(<line key={`down-${l}`} x1={x} y1={cy} x2={x} y2={height} stroke={color} strokeWidth={1.5} />);
        elements.push(<circle key={`halo-${l}`} cx={x} cy={cy} r={5.5} fill="var(--bg)" />);
        elements.push(<circle key={l} cx={x} cy={cy} r={4.5} fill={color} />);
        break;
      }
      case "o": {
        const cy = height / 2;
        elements.push(<line key={`ou-${l}`} x1={x} y1={0} x2={x} y2={cy - 3.5} stroke={color} strokeWidth={1.5} />);
        elements.push(<line key={`od-${l}`} x1={x} y1={cy + 3.5} x2={x} y2={height} stroke={color} strokeWidth={1.5} />);
        elements.push(<circle key={l} cx={x} cy={cy} r={3.5} fill="var(--bg)" stroke={color} strokeWidth={1.5} />);
        break;
      }
      case ".":
        elements.push(<circle key={l} cx={x} cy={height / 2} r={2} fill="none" stroke={color} strokeWidth={1} />);
        break;
      case "/":
        elements.push(<line key={l} x1={x} y1={0} x2={x + LANE_W} y2={height} stroke={color} strokeWidth={1.5} />);
        break;
      case "\\":
        elements.push(<line key={l} x1={x} y1={0} x2={x - LANE_W} y2={height} stroke={color} strokeWidth={1.5} />);
        break;
      case "-":
        elements.push(<line key={l} x1={x - LANE_W / 2} y1={height / 2} x2={x + LANE_W / 2} y2={height / 2} stroke={color} strokeWidth={1.5} />);
        break;
    }
  }
  return (
    <svg width={width} height={height} aria-hidden="true" style={{ flexShrink: 0, display: "block" }}>
      {elements}
    </svg>
  );
}

function DiffLines({ diff }: { diff: string }) {
  const lines = useMemo(() => diff.split("\n"), [diff]);
  return (
    <pre style={{ margin: 0, padding: "8px 0", overflow: "auto", fontFamily: "var(--font-mono)", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", lineHeight: 1.5, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)" }}>
      {lines.map((line, i) => {
        let color: string | undefined;
        let background: string | undefined;
        if (line.startsWith("+++") || line.startsWith("---")) {
          color = "var(--text-dim)";
        } else if (line.startsWith("@@")) {
          color = "var(--accent)";
        } else if (line.startsWith("+")) {
          color = "var(--status-success)";
          background = "color-mix(in srgb, var(--status-success) 10%, transparent)";
        } else if (line.startsWith("-")) {
          color = "var(--status-error)";
          background = "color-mix(in srgb, var(--status-error) 10%, transparent)";
        }
        return (
          <div key={i} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: color ?? "var(--text)", background }}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

/**
 * Percentage-of-viewport sizing for the git-graph modal. Clamped to 40-95 so
 * the chrome stays reachable at any setting.
 */
const MIN_SIZE_PERCENT = 40;
const MAX_SIZE_PERCENT = 95;

/**
 * Fullscreen (with margins) git-graph viewer modeled on vscode-git-graph:
 * colored branch lanes, commit rows with ref chips, a commit details pane
 * with the file list, and a dedicated right-hand pane for the selected
 * file's diff.
 */
export function GitGraphModal({ open, onOpenChange, cwd, sizePercent = 80 }: { open: boolean; onOpenChange: (open: boolean) => void; cwd: string | null; sizePercent?: number }) {
  const { t, locale } = useI18n();
  const [payload, setPayload] = useState<CommitLogPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GitCommitInfo | null>(null);
  const [diff, setDiff] = useState<DiffState>(null);
  const [diffLoading, setDiffLoading] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [filesWidth, setFilesWidth] = useState(() => {
    if (typeof window === "undefined") return FILES_FALLBACK_WIDTH;
    try {
      const raw = window.localStorage.getItem(FILES_WIDTH_KEY);
      const parsed = raw === null ? Number.NaN : Number(raw);
      return Number.isFinite(parsed) ? Math.max(FILES_MIN_WIDTH, Math.round(parsed)) : FILES_FALLBACK_WIDTH;
    } catch {
      return FILES_FALLBACK_WIDTH;
    }
  });
  const [diffWidth, setDiffWidth] = useState(() => {
    if (typeof window === "undefined") return DIFF_FALLBACK_WIDTH;
    try {
      const raw = window.localStorage.getItem(DIFF_WIDTH_KEY);
      const parsed = raw === null ? Number.NaN : Number(raw);
      return Number.isFinite(parsed) ? Math.max(DIFF_MIN_WIDTH, Math.round(parsed)) : DIFF_FALLBACK_WIDTH;
    } catch {
      return DIFF_FALLBACK_WIDTH;
    }
  });
  const graphAreaRef = useRef<HTMLDivElement>(null);
  const filesPaneRef = useRef<HTMLDivElement>(null);
  const diffPaneRef = useRef<HTMLDivElement>(null);

  // Persist the resized pane widths so the layout survives closing + reopening.
  useEffect(() => {
    try {
      window.localStorage.setItem(FILES_WIDTH_KEY, String(filesWidth));
      window.localStorage.setItem(DIFF_WIDTH_KEY, String(diffWidth));
    } catch {
      // Storage unavailable (private mode) — the width still applies this session.
    }
  }, [filesWidth, diffWidth]);

  // Reset both pane widths to their defaults (double-click / Enter on a
  // divider).
  const resetPaneWidths = useCallback(() => {
    setFilesWidth(FILES_FALLBACK_WIDTH);
    setDiffWidth(DIFF_FALLBACK_WIDTH);
  }, []);

  // Drag handlers for the two pane dividers. Each divider sits on the LEFT
  // edge of the pane it resizes: "files" is the commit-tree ↔ files-list
  // divider, "diff" is the files-list ↔ file-diff divider. Because the pane
  // is to the RIGHT of the divider, dragging the divider LEFT widens the
  // pane (raw = startWidth - dx). The commit tree is the flex remainder, so
  // each pane is clamped to keep the tree (and the other pane) at or above
  // its minimum width.
  const startResizerDrag = useCallback((which: "files" | "diff") => (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const container = graphAreaRef.current;
    const pane = which === "files" ? filesPaneRef.current : diffPaneRef.current;
    if (!container || !pane) return;
    const containerWidth = container.getBoundingClientRect().width;
    const startX = e.clientX;
    const startWidth = pane.getBoundingClientRect().width;
    const min = which === "files" ? FILES_MIN_WIDTH : DIFF_MIN_WIDTH;
    const onMove = (ev: MouseEvent) => {
      const raw = startWidth - (ev.clientX - startX);
      const otherMin = which === "files" ? DIFF_MIN_WIDTH : FILES_MIN_WIDTH;
      const maxWidth = Math.max(min, containerWidth - otherMin - TREE_MIN_WIDTH);
      const clamped = Math.min(Math.max(min, raw), maxWidth);
      (which === "files" ? setFilesWidth : setDiffWidth)(Math.round(clamped));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  // Keyboard resize (arrows) + reset (Enter/Space) for the divider, mirroring
  // the sidebar handle. Both dividers sit on the pane's left edge, so
  // ArrowLeft (divider moves left) widens the pane and ArrowRight narrows it.
  const handleDividerKey = useCallback((which: "files" | "diff") => (event: React.KeyboardEvent<HTMLDivElement>) => {
    const setter = which === "files" ? setFilesWidth : setDiffWidth;
    const min = which === "files" ? FILES_MIN_WIDTH : DIFF_MIN_WIDTH;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const step = 24 * (event.key === "ArrowLeft" ? 1 : -1);
      setter((w) => Math.max(min, Math.round(w + step)));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      resetPaneWidths();
    }
  }, [resetPaneWidths]);

  const load = useCallback(async () => {
    if (!cwd) return;
    setLoading(true);
    setError(null);
    try {
      const data = await client.git.log(cwd, 400);
      setPayload(data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    if (open) {
      setSelected(null);
      setDiff(null);
      setDiffError(null);
      void load();
    }
  }, [open, load]);

  const openDiff = useCallback(async (commit: GitCommitInfo, file: GitCommitFile) => {
    if (!cwd) return;
    setDiffLoading(file.path);
    setDiffError(null);
    try {
      const data = await client.git.commitDiff(cwd, commit.hash, file.path);
      setDiff({ file: file.path, diff: data.diff, binary: data.binary, truncated: data.truncated });
    } catch (diffLoadError) {
      setDiffError(diffLoadError instanceof Error ? diffLoadError.message : String(diffLoadError));
    } finally {
      setDiffLoading(null);
    }
  }, [cwd]);

  const copyHash = useCallback(async (commit: GitCommitInfo) => {
    try {
      await navigator.clipboard.writeText(commit.hash);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (permissions) — ignore.
    }
  }, []);

  const rows = useMemo(() => payload?.rows ?? [], [payload]);
  const maxLane = payload?.maxLane ?? 1;
  const laneColors = useMemo(() => computeRowLaneColors(rows, maxLane), [rows, maxLane]);
  const commitCount = useMemo(() => rows.reduce((n, r) => (r.kind === "commit" ? n + 1 : n), 0), [rows]);

  const formatTime = (iso: string): string => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
  };

  // Percentage of the viewport for the modal, clamped to 40-95 so the
  // chrome stays reachable at any setting. No pixel cap on the width: the
  // modal follows the chosen percentage of the window (capped only by the
  // 48px margin below so the chrome stays reachable).
  const sizePct = Math.min(MAX_SIZE_PERCENT, Math.max(MIN_SIZE_PERCENT, Math.round(sizePercent)));
  const widthCss = `${sizePct}vw`;
  const heightCss = `min(${sizePct}dvh, 1200px)`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ariaLabel={t("gitGraph.title")}
        style={{
          width: widthCss,
          maxWidth: "calc(100vw - 48px)",
          height: heightCss,
          maxHeight: "calc(100dvh - 48px)",
          padding: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <GitBranch size={15} strokeWidth={1.8} style={{ color: "var(--accent)" }} aria-hidden="true" />
          <DialogTitle style={{ fontSize: "calc(15px * var(--ui-font-scale-lg, 1))", margin: 0, flex: 1 }}>{t("gitGraph.title")}</DialogTitle>
          {!loading && commitCount > 0 && (
            <span style={{ fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
              {commitCount} {t("gitGraph.commits")}
            </span>
          )}
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading || !cwd}
            title={t("gitGraph.refresh")}
            aria-label={t("gitGraph.refresh")}
            className="shell-toolbar-btn ui-focus-ring"
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", padding: 6 }}
          >
            <RefreshCw size={14} strokeWidth={1.8} style={{ opacity: loading ? 0.6 : 1 }} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            title={t("gitGraph.close")}
            aria-label={t("gitGraph.close")}
            className="shell-toolbar-btn ui-focus-ring"
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", padding: 6 }}
          >
            <X size={15} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>

        {!cwd ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: "calc(13px * var(--ui-font-scale-lg, 1))" }}>
            {t("gitGraph.loadError", { error: "no workspace" })}
          </div>
        ) : loading && !payload ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: "var(--text-dim)", fontSize: "calc(13px * var(--ui-font-scale-lg, 1))" }}>
            <LoaderCircle size={14} strokeWidth={1.8} style={{ animation: "spin 1s linear infinite" }} aria-hidden="true" />
            {t("gitGraph.loading")}
          </div>
        ) : error ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, color: "var(--status-error)", fontSize: "calc(13px * var(--ui-font-scale-lg, 1))", overflowWrap: "anywhere" }}>
            {t("gitGraph.loadError", { error })}
          </div>
        ) : commitCount === 0 ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: "calc(13px * var(--ui-font-scale-lg, 1))" }}>
            {t("gitGraph.empty")}
          </div>
        ) : (
          <div ref={graphAreaRef} style={{ flex: 1, display: "flex", minHeight: 0 }}>
            <div style={{ flex: "1 1 0px", minWidth: TREE_MIN_WIDTH, overflow: "auto" }}>
              {rows.map((row, index) => {
                if (row.kind === "gap") {
                  return (
                    <div key={`gap-${index}`} style={{ display: "flex", height: GAP_ROW_H }}>
                      <GraphStrip
                        chars={row.graph}
                        height={GAP_ROW_H}
                        colors={laneColors[index]}
                        prevChars={index > 0 ? rows[index - 1].graph : null}
                        nextChars={index < rows.length - 1 ? rows[index + 1].graph : null}
                      />
                    </div>
                  );
                }
                const commit = row.commit;
                const isSelected = selected?.hash === commit.hash;
                return (
                  <div
                    key={`commit-${commit.hash}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      setSelected(isSelected ? null : commit);
                      setDiff(null);
                      setDiffError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelected(isSelected ? null : commit);
                        setDiff(null);
                        setDiffError(null);
                      }
                    }}
                    className="ui-focus-ring"
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      height: COMMIT_ROW_H,
                      cursor: "pointer",
                      background: isSelected ? "var(--bg-selected)" : undefined,
                      borderBottom: "1px solid color-mix(in srgb, var(--border) 40%, transparent)",
                    }}
                  >
                    <GraphStrip
                      chars={row.graph}
                      height={COMMIT_ROW_H}
                      colors={laneColors[index]}
                      prevChars={index > 0 ? rows[index - 1].graph : null}
                      nextChars={index < rows.length - 1 ? rows[index + 1].graph : null}
                    />
                    <div style={{ display: "flex", alignItems: "center", gap: 7, flex: 1, minWidth: 0, padding: "0 10px 0 6px" }}>
                      {commit.refs.head && (
                        <span
                          style={{
                            flexShrink: 0,
                            padding: "1px 7px",
                            borderRadius: 4,
                            fontSize: "calc(10px * var(--ui-font-scale-sm, 1))",
                            fontFamily: "var(--font-mono)",
                            fontWeight: 600,
                            color: "var(--on-accent)",
                            background: "var(--accent)",
                            maxWidth: 120,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {commit.refs.head}
                        </span>
                      )}
                      {commit.refs.branches.map((branch) => (
                        <span
                          key={branch}
                          style={{
                            flexShrink: 0,
                            padding: "1px 6px",
                            borderRadius: 4,
                            fontSize: "calc(10px * var(--ui-font-scale-sm, 1))",
                            fontFamily: "var(--font-mono)",
                            color: "var(--text-muted)",
                            background: "var(--bg-subtle)",
                            maxWidth: 110,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {branch}
                        </span>
                      ))}
                      {commit.isMerge && (
                        <span style={{ flexShrink: 0, fontSize: "calc(10px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)" }} title={t("gitGraph.merge")}>
                          ⑂
                        </span>
                      )}
                      <span style={{ flexShrink: 0, fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", fontFamily: "var(--font-mono)", color: "var(--text-dim)" }} title={commit.hash}>
                        {commit.shortHash}
                      </span>
                      <span style={{ flex: 1, minWidth: 0, fontSize: "calc(13px * var(--ui-font-scale-lg, 1))", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }}>
                        {commit.subject}
                      </span>
                      <span style={{ flexShrink: 0, fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--text-muted)", maxWidth: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {commit.author}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {selected && (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={t("gitGraph.resizeFiles")}
                tabIndex={0}
                onMouseDown={startResizerDrag("files")}
                onDoubleClick={resetPaneWidths}
                onKeyDown={handleDividerKey("files")}
                title={t("gitGraph.resizeFiles")}
                style={{
                  width: 5,
                  flexShrink: 0,
                  cursor: "col-resize",
                  touchAction: "none",
                  background: "transparent",
                  outline: "none",
                  transition: "background var(--dur-fast) var(--ease-out-warm)",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 35%, transparent)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                onFocus={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 35%, transparent)"; }}
                onBlur={(e) => { e.currentTarget.style.background = "transparent"; }}
              />
            )}
            {selected && (
              <aside
                ref={filesPaneRef}
                style={{ width: filesWidth, minWidth: FILES_MIN_WIDTH, flexShrink: 0, borderLeft: "none", background: "var(--bg-panel)", display: "flex", flexDirection: "column", minHeight: 0 }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "12px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
                  <GitCommitHorizontal size={14} strokeWidth={1.8} style={{ color: "var(--accent)", marginTop: 2 }} aria-hidden="true" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "calc(13px * var(--ui-font-scale-lg, 1))", fontWeight: 600, overflowWrap: "anywhere", lineHeight: 1.4 }}>{t("gitGraph.commit")}: {selected.subject}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 5 }}>
                      <code style={{ fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--text-muted)", whiteSpace: "nowrap", overflowX: "auto", flex: 1, minWidth: 0, scrollbarWidth: "thin" }}>{selected.hash}</code>
                      <button
                        type="button"
                        onClick={() => void copyHash(selected)}
                        title={t("gitGraph.copyHash")}
                        aria-label={t("gitGraph.copyHash")}
                        className="ui-focus-ring"
                        style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 6px", border: "1px solid var(--border)", borderRadius: 4, background: "none", color: copied ? "var(--accent)" : "var(--text-dim)", cursor: "pointer", fontSize: "calc(10px * var(--ui-font-scale-sm, 1))", flexShrink: 0 }}
                      >
                        {copied ? <Check size={10} strokeWidth={2} aria-hidden="true" /> : <Copy size={10} strokeWidth={1.8} aria-hidden="true" />}
                        {copied ? t("gitGraph.copied") : t("gitGraph.copyHash")}
                      </button>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(null);
                      setDiff(null);
                    }}
                    title={t("gitGraph.close")}
                    aria-label={t("gitGraph.close")}
                    className="ui-focus-ring"
                    style={{ display: "inline-flex", padding: 4, border: "none", background: "none", color: "var(--text-dim)", cursor: "pointer", flexShrink: 0 }}
                  >
                    <X size={13} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                </div>
                <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", display: "grid", gridTemplateColumns: "auto 1fr", gap: "5px 12px", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", flexShrink: 0 }}>
                  <span style={{ color: "var(--text-dim)" }}>{t("gitGraph.parents")}</span>
                  <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
                    {selected.parents.length > 0 ? selected.parents.map((p) => p.slice(0, 7)).join(" ") : "—"}
                  </span>
                  <span style={{ color: "var(--text-dim)" }}>Author</span>
                  <span style={{ color: "var(--text-muted)", overflowWrap: "anywhere" }}>{selected.author} &lt;{selected.email}&gt;</span>
                  <span style={{ color: "var(--text-dim)" }}>Date</span>
                  <span style={{ color: "var(--text-muted)" }}>{formatTime(selected.date)}</span>
                </div>
                {selected.body && (
                  <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0, maxHeight: "30%", overflow: "auto" }}>
                    <pre style={{ margin: 0, fontSize: "calc(12px * var(--ui-font-scale-lg, 1))", lineHeight: 1.55, color: "var(--text)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{selected.body}</pre>
                  </div>
                )}
                <div style={{ padding: "10px 14px 4px", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", fontWeight: 650, color: "var(--text-dim)", flexShrink: 0 }}>
                  {t("gitGraph.files")} ({selected.files.length})
                </div>
                <div style={{ flex: 1, overflow: "auto", padding: "4px 10px 14px" }}>
                  {selected.files.length === 0 && <div style={{ padding: "8px 4px", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)" }}>{t("gitGraph.noDiff")}</div>}
                  {selected.files.map((file) => (
                    <button
                      key={file.path}
                      type="button"
                      onClick={() => void openDiff(selected, file)}
                      className="ui-focus-ring"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        width: "100%",
                        padding: "5px 6px",
                        border: "none",
                        borderRadius: 5,
                        background: diff?.file === file.path ? "var(--bg-selected)" : "none",
                        color: "var(--text)",
                        cursor: "pointer",
                        fontSize: "calc(12px * var(--ui-font-scale-lg, 1))",
                        textAlign: "left",
                      }}
                    >
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))" }}>
                        {file.path}
                      </span>
                      {file.additions !== null && <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: "calc(10px * var(--ui-font-scale-sm, 1))", color: "var(--status-success)" }}>+{file.additions}</span>}
                      {file.deletions !== null && <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: "calc(10px * var(--ui-font-scale-sm, 1))", color: "var(--status-error)" }}>-{file.deletions}</span>}
                      {file.additions === null && file.deletions === null && <span style={{ flexShrink: 0, fontSize: "calc(10px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)" }}>{t("gitGraph.binaryFile")}</span>}
                    </button>
                  ))}
                </div>
              </aside>
            )}

            {selected && (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={t("gitGraph.resizeDiff")}
                tabIndex={0}
                onMouseDown={startResizerDrag("diff")}
                onDoubleClick={resetPaneWidths}
                onKeyDown={handleDividerKey("diff")}
                title={t("gitGraph.resizeDiff")}
                style={{
                  width: 5,
                  flexShrink: 0,
                  cursor: "col-resize",
                  touchAction: "none",
                  background: "transparent",
                  outline: "none",
                  transition: "background var(--dur-fast) var(--ease-out-warm)",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 35%, transparent)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                onFocus={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 35%, transparent)"; }}
                onBlur={(e) => { e.currentTarget.style.background = "transparent"; }}
              />
            )}

            {selected && (
              <section
                ref={diffPaneRef}
                aria-label={diff ? diff.file : t("gitGraph.selectFile")}
                style={{ width: diffWidth, minWidth: DIFF_MIN_WIDTH, flexShrink: 0, borderLeft: "none", display: "flex", flexDirection: "column", minHeight: 0, background: "var(--bg)" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0, minWidth: 0 }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", fontFamily: "var(--font-mono)", color: diff ? "var(--text-muted)" : "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {diff ? diff.file : t("gitGraph.selectFile")}
                  </span>
                  {diffLoading && <LoaderCircle size={12} strokeWidth={1.8} style={{ animation: "spin 1s linear infinite", flexShrink: 0 }} aria-hidden="true" />}
                </div>
                <div style={{ flex: 1, overflow: "auto", padding: "8px 10px" }}>
                  {diffError && <div style={{ padding: "8px 6px", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--status-error)", overflowWrap: "anywhere" }}>{t("gitGraph.diffError", { error: diffError })}</div>}
                  {diffLoading && !diffError && (
                    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 6px", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)" }}>
                      {t("gitGraph.diffLoading")}
                    </div>
                  )}
                  {diff && !diffLoading && !diffError && (
                    diff.binary ? (
                      <div style={{ fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)", padding: "6px 0" }}>{t("gitGraph.binaryFile")}</div>
                    ) : (
                      <DiffLines diff={diff.diff} />
                    )
                  )}
                </div>
              </section>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
