"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, LoaderCircle, Maximize2, Minimize2, RefreshCw, X } from "lucide-react";
import { Tooltip } from "./ui/primitives";
import { useI18n } from "@/lib/i18n";
import { toast } from "@/components/ui/toast";
import { createOmpwebClient } from "@/lib/client";
import { useTheme } from "@/hooks/useTheme";
import { useIsMobile } from "@/hooks/useIsMobile";

const client = createOmpwebClient("legacy-http");

/**
 * Git graph bottom panel: hosts the vendored vscode-git-graph engine
 * webview (served by /gitgraph, built from vendor/vscode-git-graph/web) in
 * a same-origin iframe and implements the embedding-page side of the host
 * protocol defined by vendor/vscode-git-graph/web/ompweb-bridge.ts:
 * theme pushes, open-file relays, and the right-hand diff pane fed by
 * open-diff relays. The panel docks at the bottom of the workspace column
 * like the terminal drawer: its height is draggable (persisted), and the
 * expand control fills the whole workspace column (also persisted, see
 * EXPANDED_KEY). The host owns open/close; the top-bar button toggles it.
 */

// Persisted expand/collapse state: collapsed = the dragged panel height at
// the workspace bottom; expanded = the panel fills the whole workspace
// column (the host grows its flex basis; see onExpandedChange).
const EXPANDED_KEY = "omp-wea...ded";

// Docked-panel height: dragged from the top edge and persisted; dragging
// past the minimum hides the panel (the terminal drawer's gesture).
const PANEL_HEIGHT_KEY = "omp-web:git-gra...ght";
const PANEL_MIN_HEIGHT = 200;
const PANEL_DEFAULT_HEIGHT = 420;

// Lane palette used by the embedded engine — mirrors the default view-config
// palette (lib/git-graph/default-config.ts, upstream "Default" set). These
// are the webview's own --git-graph-colorN data colors, not ompweb chrome
// colors (the overlay chrome itself is token-only).
const GG_LANE_COLORS = [
  "#2C3E50", "#C0392B", "#27AE60", "#8E44AD", "#E67E22", "#16A085",
  "#2980B9", "#D35400", "#1ABC9C", "#F39C12", "#3498DB", "#E74C3C",
];

/**
 * Webview CSS variables used by the vendored Git Graph styles → ompweb
 * design tokens. Values are read from the root element's computed styles at
 * push time, so this single map resolves against whichever ompweb theme is
 * active (one map, tokens auto-resolve per theme). The two font-family
 * entries are filled from computed font stacks instead of custom
 * properties (they are not tokenized on :root for every theme).
 */
const THEME_TOKEN_MAP: Readonly<Record<string, string>> = {
  // The graph surface is the panel background (the webview punches its graph
  // circles / sticky strips out of this same color, so one map entry carries
  // the whole background).
  "--vscode-editor-background": "--bg-panel",
  "--vscode-editor-foreground": "--text",
  "--vscode-editorWidget-background": "--bg-panel",
  "--vscode-editorSuggestWidget-foreground": "--text",
  "--vscode-editor-findMatchHighlightBorder": "--accent",
  "--vscode-panel-background": "--bg-panel",
  "--vscode-panel-border": "--border",
  // Scrollbar thumb base (the webview's scrollbar seam applies the
  // 45/75% alphas; see web/styles/main.css).
  "--vscode-scrollbarSlider-background": "--text-dim",
  "--vscode-input-background": "--bg-panel",
  "--vscode-input-foreground": "--text",
  "--vscode-input-placeholderForeground": "--text-dim",
  "--vscode-inputOption-activeBackground": "--bg-selected",
  "--vscode-inputOption-activeBorder": "--accent",
  "--vscode-inputOption-hoverBackground": "--bg-hover",
  "--vscode-inputValidation-errorBackground": "--bg-panel",
  "--vscode-inputValidation-errorBorder": "--status-error",
  "--vscode-dropdown-background": "--bg",
  "--vscode-dropdown-foreground": "--text",
  "--vscode-dropdown-border": "--border",
  "--vscode-menu-background": "--bg",
  "--vscode-menu-foreground": "--text",
  "--vscode-menu-border": "--border",
  "--vscode-menu-selectionBackground": "--bg-selected",
  "--vscode-menu-selectionForeground": "--text",
  "--vscode-menu-selectionBorder": "--border",
  "--vscode-menu-separatorBackground": "--border",
  "--vscode-selection-background": "--bg-selected",
  "--vscode-focusBorder": "--accent",
  "--vscode-textLink-foreground": "--accent",
  "--vscode-textLink-activeForeground": "--accent-hover",
  "--vscode-gitDecoration-addedResourceForeground": "--status-success",
  "--vscode-gitDecoration-modifiedResourceForeground": "--status-modified",
  "--vscode-gitDecoration-deletedResourceForeground": "--status-error",
  "--vscode-widget-shadow": "--shadow-modal",
  "--vscode-descriptionForeground": "--text-muted",
  "--vscode-errorForeground": "--status-error",
  "--vscode-button-background": "--accent",
  "--vscode-button-hoverBackground": "--accent-hover",
  "--vscode-button-foreground": "--on-accent",
  "--vscode-button-secondaryBackground": "--bg-panel",
  "--vscode-button-secondaryHoverBackground": "--bg-hover",
  "--vscode-button-secondaryForeground": "--text",
  "--vscode-banner-background": "--bg-panel",
  "--vscode-errorBackground": "--bg-panel",
};

/** Validated ompweb-gg-open-diff relay (fields narrowed at the listener). */
interface DiffRequest {
  repo: string | null;
  mode: string | null;
  filePath: string | null;
  hash: string | null;
  fromHash: string | null;
  toHash: string | null;
}

type DiffState = { file: string; diff: string; binary: boolean; truncated: boolean } | null;

/** client.git.refDiff payload: a unified diff, or an unsupported/error shape. */
interface RefDiffPayload {
  diff?: string;
  binary?: boolean;
  truncated?: boolean;
  supported?: boolean;
  error?: string;
}

// ClientError is a plain object ({ code, message, retryable }), not an Error
// instance — String(err) on it yields "[object Object]".
const describeError = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) return String(err.message);
  return String(err);
};

/** Repo-relative → absolute path (same normalization the webview bridge applies). */
function absoluteFilePath(filePath: string, repo: string | null): string | null {
  if (filePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(filePath)) return filePath;
  if (!repo) return null;
  return repo.replace(/[\\/]+$/, "") + "/" + filePath.replace(/^[/\\]+/, "");
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
 * Right-hand unified-diff pane (module-internal). Fed by ompweb-gg-open-diff
 * relays: the working mode shows the file at the requested commit against
 * the working tree, the compare mode the requested from→to range — both
 * through the client adapter's ref diff (client.git.refDiff). Renders
 * the unified diff as-is with +/- lines colored from the status tokens. The
 * pane is collapsed while nothing is loaded (no diff, no load in flight, no
 * error) and closes via its X button.
 */
function DiffPane({ diff, loading, error, mobile, onClose }: {
  diff: DiffState;
  loading: boolean;
  error: string | null;
  mobile: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  if (!diff && !error && !loading) return null;
  return (
    <section
      aria-label={diff ? diff.file : t("gitGraph.selectFile")}
      style={{
        width: mobile ? "100%" : "clamp(320px, 42%, 640px)",
        position: mobile ? "absolute" : "relative",
        inset: mobile ? 0 : undefined,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: "var(--bg-panel)",
        borderLeft: mobile ? "none" : "1px solid var(--border)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0, minWidth: 0 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", fontFamily: "var(--font-mono)", color: diff ? "var(--text-muted)" : "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {diff ? diff.file : t("gitGraph.selectFile")}
        </span>
        {loading && <LoaderCircle size={12} strokeWidth={1.8} className="icon-spin" style={{ flexShrink: 0 }} aria-hidden="true" />}
        <Tooltip content={t("gitGraph.close")}>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("gitGraph.close")}
            className="ui-focus-ring"
            style={{ display: "inline-flex", padding: 4, border: "none", background: "none", color: "var(--text-dim)", cursor: "pointer", flexShrink: 0 }}
          >
            <X size={13} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "8px 10px" }}>
        {error && <div style={{ padding: "8px 6px", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--status-error)", overflowWrap: "anywhere" }}>{t("gitGraph.diffError", { error })}</div>}
        {loading && !error && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 6px", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)" }}>
            {t("gitGraph.diffLoading")}
          </div>
        )}
        {diff && !loading && !error && (
          diff.binary ? (
            <div style={{ fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)", padding: "6px 0" }}>{t("gitGraph.binaryFile")}</div>
          ) : diff.diff.length === 0 ? (
            <div style={{ fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)", padding: "6px 0" }}>{t("gitGraph.noDiff")}</div>
          ) : (
            <DiffLines diff={diff.diff} />
          )
        )}
      </div>
    </section>
  );
}

/**
 * Docked git-graph bottom panel hosting the engine webview: header chrome
 * (title, repo name, refresh / expand / close), the iframe embed filling
 * the body, and the collapsible diff pane. Not a Dialog — it is an in-flow
 * sibling of the workspace column and keeps its own close control.
 */
export function GitGraphModal({ open, onOpenChange, cwd, onExpandedChange, onOpenFile }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cwd: string | null;
  /** Reports whether the docked panel is expanded (filled), so the
   *  surrounding flex layout can grow it into the workspace column. */
  onExpandedChange?: (expanded: boolean) => void;
  onOpenFile: (filePath: string) => void;
}) {
  const { t } = useI18n();
  const { isDark } = useTheme();
  const isMobile = useIsMobile();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Stable refs so the persistent message listener always sees current props
  // without re-subscribing on every render.
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;

  const [expanded, setExpanded] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(EXPANDED_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(EXPANDED_KEY, expanded ? "1" : "0");
    } catch {
      // Storage unavailable (private mode) — the state still applies this session.
    }
  }, [expanded]);

  // Docked-panel height: persisted, dragged from the top edge; dragging
  // below the minimum hides the panel (the terminal drawer's gesture).
  const [panelHeight, setPanelHeight] = useState(() => {
    if (typeof window === "undefined") return PANEL_DEFAULT_HEIGHT;
    try {
      const raw = window.localStorage.getItem(PANEL_HEIGHT_KEY);
      const parsed = raw === null ? Number.NaN : Number(raw);
      return Number.isFinite(parsed) ? Math.max(PANEL_MIN_HEIGHT, parsed) : PANEL_DEFAULT_HEIGHT;
    } catch {
      return PANEL_DEFAULT_HEIGHT;
    }
  });
  const panelHeightRef = useRef(panelHeight);
  panelHeightRef.current = panelHeight;
  useEffect(() => {
    try {
      window.localStorage.setItem(PANEL_HEIGHT_KEY, String(panelHeight));
    } catch {
      // Storage unavailable (private mode) — the height still applies this session.
    }
  }, [panelHeight]);

  // The host coordinates the docked layout: an expanded panel grows into the
  // workspace column (it owns the flex basis), a restored one keeps its own
  // height. Report the effective state whenever it changes.
  useEffect(() => {
    onExpandedChange?.(open && expanded);
  }, [open, expanded, onExpandedChange]);

  const handlePanelResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = panelHeightRef.current;
    let closed = false;
    const onMouseMove = (ev: MouseEvent) => {
      if (closed) return;
      const next = startHeight + (startY - ev.clientY);
      if (next < 120) {
        closed = true;
        onOpenChange(false);
        return;
      }
      setPanelHeight(Math.max(PANEL_MIN_HEIGHT, Math.min(window.innerHeight * 0.8, next)));
    };
    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [onOpenChange]);

  const [frameLoaded, setFrameLoaded] = useState(false);
  const [frameEpoch, setFrameEpoch] = useState(0); // bumped to reload the embed (refresh)
  const [diff, setDiff] = useState<DiffState>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const postToFrame = useCallback((msg: Record<string, unknown>) => {
    // Same-origin embed (served by /gitgraph); post only to our own origin.
    iframeRef.current?.contentWindow?.postMessage(msg, window.location.origin);
  }, []);

  // The embed document (re)mounts whenever the repo or the refresh epoch
  // changes; drop the stale transient state with it.
  useEffect(() => {
    setFrameLoaded(false);
  }, [cwd, frameEpoch]);

  /** Push the current ompweb theme into the webview (contract message). */
  const pushTheme = useCallback(() => {
    const frame = iframeRef.current;
    if (!frame?.contentWindow) return;
    const root = getComputedStyle(document.documentElement);
    const vars: Record<string, string> = {};
    for (const [name, token] of Object.entries(THEME_TOKEN_MAP)) {
      const value = root.getPropertyValue(token).trim();
      if (value) vars[name] = value;
    }
    vars["--vscode-font-family"] = getComputedStyle(document.body).fontFamily;
    const mono = root.getPropertyValue("--font-mono").trim();
    if (mono) vars["--vscode-editor-font-family"] = mono;
    frame.contentWindow.postMessage(
      { type: "ompweb-gg-theme", vars, laneColors: GG_LANE_COLORS, dark: isDark },
      window.location.origin,
    );
  }, [isDark]);

  // Ready-handler access to the current pushTheme without making the message
  // listener effect resubscribe every time the theme changes.
  const pushThemeRef = useRef(pushTheme);
  pushThemeRef.current = pushTheme;

  /** Re-push to an already-booted embed on theme change; a fresh boot is served by the ready handler. */
  useEffect(() => {
    if (frameLoaded) pushTheme();
  }, [frameLoaded, pushTheme]);

  // Embedding-page side of the bridge protocol (open-file / open-diff /
  // error relay, see vendor/vscode-git-graph/web/ompweb-bridge.ts).
  useEffect(() => {
    if (!open) return;
    const openDiff = async (request: DiffRequest) => {
      const repo = request.repo ?? cwdRef.current;
      const filePath = request.filePath;
      if (!repo || !filePath) {
        postToFrame({ type: "ompweb-gg-open-diff-result", ok: false });
        return;
      }
      // Map both upstream diff actions onto the client adapter. Upstream payload
      // semantics (web/main.ts triggerViewFileDiff): `*` is the UNCOMMITTED
      // sentinel, and fromHash === toHash means "the change this commit
      // introduced" — which VS Code resolves against the first parent:
      //   viewDiffWithWorkingFile(hash, file)          → refDiff(repo, hash, "*", file)
      //   viewDiff(from, to) with from !== to          → refDiff(repo, from, to, new || old)
      //   viewDiff(X, X) with X a commit               → commitDiff(repo, X, file)  (vs first parent)
      //   viewDiff("*", "*") (uncommitted row)         → refDiff(repo, "HEAD", "*", file)
      let fetchDiff: () => Promise<RefDiffPayload>;
      const filePathIsCompare = request.mode === "compare";
      if (filePathIsCompare) {
        const from = request.fromHash;
        const to = request.toHash;
        if (!from || !to) {
          postToFrame({ type: "ompweb-gg-open-diff-result", ok: false });
          return;
        }
        if (from === "*" && to === "*") {
          fetchDiff = () => client.git.refDiff(repo, "HEAD", "*", filePath);
        } else if (from === to && from !== "*") {
          fetchDiff = () => client.git.commitDiff(repo, from, filePath);
        } else {
          fetchDiff = () => client.git.refDiff(repo, from, to === "*" || to === "UNCOMMITTED" ? "*" : to, filePath);
        }
      } else {
        const hash = request.hash;
        if (!hash) {
          postToFrame({ type: "ompweb-gg-open-diff-result", ok: false });
          return;
        }
        fetchDiff = () => client.git.refDiff(repo, hash === "*" ? "HEAD" : hash, "*", filePath);
      }
      setDiffLoading(true);
      setDiffError(null);
      try {
        // The declared return type under-describes the endpoint's
        // alternative shapes ({ supported: false }); check at runtime.
        const data: RefDiffPayload = await fetchDiff();
        if (typeof data.diff === "string") {
          setDiff({ file: filePath, diff: data.diff, binary: data.binary === true, truncated: data.truncated === true });
          postToFrame({ type: "ompweb-gg-open-diff-result", ok: true });
        } else {
          setDiff(null);
          setDiffError(data.error ?? (data.supported === false ? "diff not supported" : "diff not available"));
          postToFrame({ type: "ompweb-gg-open-diff-result", ok: false });
        }
      } catch (error) {
        setDiff(null);
        setDiffError(describeError(error));
        postToFrame({ type: "ompweb-gg-open-diff-result", ok: false });
      } finally {
        setDiffLoading(false);
      }
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data: unknown = event.data;
      if (!data || typeof data !== "object" || !("type" in data) || typeof data.type !== "string") return;
      switch (data.type) {
        case "ompweb-gg-ready":
          // Every document boot must fetch the theme: closing the panel
          // unmounts the iframe while this component keeps its state, so on
          // a reopen `frameLoaded` never goes false→true again and the
          // push-effect below cannot re-run — the freshly loaded document
          // would keep its unstyled (light-fallback) defaults.
          setFrameLoaded(true);
          pushThemeRef.current();
          break;
        case "ompweb-gg-error":
          toast.error(t("gitGraph.title"), "message" in data && typeof data.message === "string" ? data.message : "unknown error");
          break;
        case "ompweb-gg-open-file": {
          const filePath = "filePath" in data && typeof data.filePath === "string" ? data.filePath : "";
          // The bridge already absolutizes; this join is the defensive path
          // for a repo-relative leftover. No workspace → cannot open.
          const absolute = filePath ? absoluteFilePath(filePath, cwdRef.current) : null;
          if (!absolute || !cwdRef.current) {
            postToFrame({ type: "ompweb-gg-open-file-result", ok: false });
            return;
          }
          onOpenFileRef.current(absolute);
          postToFrame({ type: "ompweb-gg-open-file-result", ok: true });
          break;
        }
        case "ompweb-gg-open-diff": {
          let repo: string | null = null;
          let mode: string | null = null;
          let filePath: string | null = null;
          let hash: string | null = null;
          let fromHash: string | null = null;
          let toHash: string | null = null;
          if ("repo" in data && typeof data.repo === "string" && data.repo.length > 0) repo = data.repo;
          if ("mode" in data && typeof data.mode === "string") mode = data.mode;
          if ("path" in data && typeof data.path === "string" && data.path.length > 0) filePath = data.path;
          if ("oldPath" in data && typeof data.oldPath === "string" && data.oldPath.length > 0) filePath = filePath ?? data.oldPath;
          if ("hash" in data && typeof data.hash === "string" && data.hash.length > 0) hash = data.hash;
          if ("fromHash" in data && typeof data.fromHash === "string" && data.fromHash.length > 0) fromHash = data.fromHash;
          if ("toHash" in data && typeof data.toHash === "string" && data.toHash.length > 0) toHash = data.toHash;
          void openDiff({ repo, mode, filePath, hash, fromHash, toHash });
          break;
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [open, postToFrame, t]);

  // Escape closes the panel — unless a real modal dialog is open on the
  // page, in which case it owns the key (same guard as the window-level
  // shortcuts in hooks/useKeyboardShortcuts).
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector('[role="dialog"], [aria-modal="true"], [data-state="open"]')) return;
      onOpenChange(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  const repoName = useMemo(() => {
    if (!cwd) return null;
    const parts = cwd.split(/[\\/]+/).filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : cwd;
  }, [cwd]);

  const src = cwd ? `/gitgraph?repo=${encodeURIComponent(cwd)}` : null;
  // React key: remounts the iframe on repo switch and on manual refresh.
  const frameKey = src === null ? "none" : `${src}#${frameEpoch}`;

  // Collapsed = the dragged height at the workspace bottom; expanded =
  // the panel grows into the whole workspace column (the host owns the
  // flex basis, see onExpandedChange).
  const panelStyle: React.CSSProperties = {
    position: "relative",
    width: "100%",
    minHeight: 0,
    flex: expanded ? "1 1 auto" : "0 0 auto",
    height: expanded ? "100%" : panelHeight,
  };

  if (!open) return null;

  return (
    <section className="git-graph-panel" style={panelStyle} role="region" aria-label={t("gitGraph.title")}>
      {!expanded && (
        <Tooltip content={t("gitGraph.resizeHint")}>
          <div
            onMouseDown={handlePanelResizeStart}
            style={{ position: "absolute", top: 0, left: 0, right: 0, height: 6, cursor: "row-resize", zIndex: 5 }}
          />
        </Tooltip>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0, minWidth: 0 }}>
        <GitBranch size={15} strokeWidth={1.8} style={{ color: "var(--accent)", flexShrink: 0 }} aria-hidden="true" />
        <span style={{ fontSize: "calc(15px * var(--ui-font-scale-lg, 1))", fontWeight: 600, flexShrink: 0 }}>{t("gitGraph.title")}</span>
        {repoName && (
          <span
            title={cwd ?? undefined}
            style={{ flexShrink: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", color: "var(--text-muted)", background: "var(--bg-subtle)", padding: "2px 8px", borderRadius: 4 }}
          >
            {repoName}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <Tooltip content={t("gitGraph.refresh")}>
          <button
            type="button"
            onClick={() => { setFrameLoaded(false); setFrameEpoch((n) => n + 1); }}
            disabled={!cwd}
            aria-label={t("gitGraph.refresh")}
            className="shell-toolbar-btn ui-focus-ring"
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", padding: 6 }}
          >
            <RefreshCw size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </Tooltip>
        <Tooltip content={expanded ? t("gitGraph.collapse") : t("gitGraph.expand")}>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? t("gitGraph.collapse") : t("gitGraph.expand")}
            aria-pressed={expanded}
            className="shell-toolbar-btn ui-focus-ring"
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", padding: 6 }}
          >
            {expanded ? <Minimize2 size={14} strokeWidth={1.8} aria-hidden="true" /> : <Maximize2 size={14} strokeWidth={1.8} aria-hidden="true" />}
          </button>
        </Tooltip>
        <Tooltip content={t("gitGraph.close")}>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label={t("gitGraph.close")}
            className="shell-toolbar-btn ui-focus-ring"
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", padding: 6 }}
          >
            <X size={15} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </Tooltip>
      </div>

      <div style={{ flex: 1, display: "flex", minHeight: 0, position: "relative" }}>
        {src === null ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: "calc(13px * var(--ui-font-scale-lg, 1))" }}>
            {t("gitGraph.loadError", { error: "no workspace" })}
          </div>
        ) : (
          <>
            <iframe
              ref={iframeRef}
              key={frameKey}
              src={src}
              title={t("gitGraph.title")}
              onLoad={() => setFrameLoaded(true)}
              style={{ flex: "1 1 auto", minWidth: 0, width: "100%", height: "100%", border: "none", background: "var(--bg-panel)" }}
            />
            {!frameLoaded && (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: "var(--text-dim)", fontSize: "calc(13px * var(--ui-font-scale-lg, 1))", background: "var(--bg-panel)" }}>
                <LoaderCircle size={14} strokeWidth={1.8} className="icon-spin" aria-hidden="true" />
                {t("gitGraph.loading")}
              </div>
            )}
          </>
        )}
        <DiffPane
          diff={diff}
          loading={diffLoading}
          error={diffError}
          mobile={isMobile}
          onClose={() => { setDiff(null); setDiffError(null); }}
        />
      </div>
    </section>
  );
}
