"use client";

// Copilot-style diff surface shared by the Git Graph pane, the right-panel
// Git tab and the FileViewer diff mode: aligned split panes with per-side
// line-number gutters, syntax highlighting, word-level inline highlights
// and expandable "N hidden lines" bars (lib/diff-model reveal machinery).
//
// Layout mechanics: ONE CSS grid holds every line as an explicit
// gridColumn/gridRow item, so left/right rows stay row-aligned no matter
// what the SyntaxHighlighter `pre`/`code` wrappers do — the wrappers (and
// the renderer's line divs) collapse to `display: contents`. Line lengths
// are known up-front (monospace), so the grid tracks get a ch-based
// minmax: long lines widen the panes and the scroller below the header
// scrolls horizontally, like the reference view.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Columns2, Copy, ExternalLink, List, WrapText } from "lucide-react";
import type { SyntaxHighlighterProps } from "react-syntax-highlighter";
import { createSyntaxElement as renderSyntaxNode, ensureLanguageRegistered, isLanguageRegistered, SyntaxHighlighter, vs, vscDarkPlus } from "@/lib/syntax-highlight";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/lib/i18n";
import { toast } from "@/components/ui/toast";
import { getFileName } from "@/lib/file-paths";
import { getLanguage } from "@/lib/file-language";
import { getFileIcon } from "@/components/FileIcons";
import { buildDiffFiles, buildViewItems, nextRevealCount, type DiffCell, type DiffContents, type DiffFileModel, type DiffRow } from "@/lib/diff-model";

export interface DiffViewerProps {
  patch: string;
  /** Both file versions (diff API `contents=1`); without them the hidden
   *  lines bars stay static — a click can never reveal nothing. */
  oldText?: string | null;
  newText?: string | null;
  contentsTruncated?: boolean;
  /** Absolute path: file icon, language, directory crumb, Viewed key. */
  filePath?: string | null;
  /** Repository root: Viewed key scope + directory breadcrumb suffix. */
  cwd?: string | null;
  showHeader?: boolean;
  showPath?: boolean;
  showViewed?: boolean;
  /** Split/unified affordance — the narrow graph pane keeps it hidden. */
  showLayoutToggle?: boolean;
  onOpenFile?: (filePath: string) => void;
}

const SPLIT_MIN_WIDTH_PX = 560;
const MAX_RENDERED_LINES = 2000;
const TAB_WIDTH = 4;
const LINE_HEIGHT = 1.5;

type RendererProps = Parameters<NonNullable<SyntaxHighlighterProps["renderer"]>>[0];

// ---------- helpers ----------

/** Display column of every char index (tabs advance to the next multiple
 *  of TAB_WIDTH — CSS tab-size renders them identically). */
function displayColumns(text: string): number[] {
  const cols: number[] = new Array(text.length + 1);
  let col = 0;
  for (let i = 0; i < text.length; i++) {
    cols[i] = col;
    col = text[i] === "\t" ? Math.floor(col / TAB_WIDTH + 1) * TAB_WIDTH : col + 1;
  }
  cols[text.length] = col;
  return cols;
}

/** Word-spans → stacked hard-stop gradients in `ch` units (the content font
 *  is monospace), painted under the syntax tokens. */
function wordSpansBackground(spans: Array<[number, number]> | undefined, cols: number[], color: string): string | undefined {
  if (!spans || spans.length === 0) return undefined;
  const layers = spans
    .map(([s, e]) => {
      const start = cols[Math.min(s, cols.length - 1)];
      const end = cols[Math.min(e, cols.length - 1)];
      if (end <= start) return null;
      return `linear-gradient(90deg, transparent 0 ${start}ch, ${color} ${start}ch, ${color} ${end}ch, transparent ${end}ch 100%)`;
    })
    .filter((layer): layer is string => layer !== null);
  return layers.length > 0 ? layers.join(", ") : undefined;
}

function cellBackground(kind: DiffCell["kind"]): string {
  if (kind === "added") return "var(--diff-add-line)";
  if (kind === "removed") return "var(--diff-del-line)";
  if (kind === "empty") return "var(--bg-subtle)";
  return "transparent";
}

function wordSpanColor(kind: DiffCell["kind"]): string {
  return kind === "added" ? "var(--diff-add-word)" : "var(--diff-del-word)";
}

interface RenderLine {
  cell: DiffCell;
  /** Grid column of this line: 1 in split left / unified, 2 split right. */
  column: 1 | 2;
}
interface RenderedRows {
  lines: RenderLine[];
  leftMax: number;
  rightMax: number;
  maxLineNo: number;
}

function toRenderLines(rows: DiffRow[], split: boolean): RenderedRows {
  const lines: RenderLine[] = [];
  let leftMax = 0;
  let rightMax = 0;
  let maxLineNo = 0;
  const measure = (cell: DiffCell, column: 1 | 2) => {
    const width = displayColumns(cell.text).at(-1) ?? 0;
    if (column === 1) leftMax = Math.max(leftMax, width);
    else rightMax = Math.max(rightMax, width);
    maxLineNo = Math.max(maxLineNo, cell.lineNo ?? 0);
  };
  for (const row of rows) {
    if (split) {
      lines.push({ cell: row.left, column: 1 }, { cell: row.right, column: 2 });
      measure(row.left, 1);
      measure(row.right, 2);
    } else {
      // Unified: removed line first, then the added line; context once.
      if (row.left.kind !== "empty") {
        lines.push({ cell: row.left, column: 1 });
        measure(row.left, 1);
      }
      if (row.right.kind === "added") {
        lines.push({ cell: row.right, column: 1 });
        measure(row.right, 1);
      }
    }
  }
  return { lines, leftMax, rightMax, maxLineNo };
}

// ---------- Viewed persistence ----------
// Keyed by repo + file + the exact patch content, so a new revision of the
// diff automatically starts un-viewed again. Insertion order doubles as the
// eviction order.

const VIEWED_STORAGE_KEY = "omp-web:git-diff-viewed";
const VIEWED_MAX_ENTRIES = 300;

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function viewedEntries(): Record<string, true> {
  if (typeof window === "undefined") return {};
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(VIEWED_STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, true> : {};
  } catch {
    return {};
  }
}

function persistViewed(entryKey: string, viewed: boolean): void {
  if (typeof window === "undefined") return;
  try {
    const entries = viewedEntries();
    if (viewed) entries[entryKey] = true;
    else delete entries[entryKey];
    const keys = Object.keys(entries);
    for (let i = 0; i < keys.length - VIEWED_MAX_ENTRIES; i++) delete entries[keys[i]];
    window.localStorage.setItem(VIEWED_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Storage disabled (private mode) — the Viewed state just does not persist.
  }
}

// ---------- component ----------

export function DiffViewer({
  patch,
  oldText,
  newText,
  contentsTruncated = false,
  filePath = null,
  cwd = null,
  showHeader = true,
  showPath = true,
  showViewed = true,
  showLayoutToggle = false,
  onOpenFile,
}: DiffViewerProps) {
  const { t, tn } = useI18n();
  const { isDark } = useTheme();
  const [reveals, setReveals] = useState<number[]>([]);
  const [userLayout, setUserLayout] = useState<"split" | "unified" | null>(null);
  const [wrap, setWrap] = useState(false);
  const [viewed, setViewedState] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  const contents: DiffContents | null = useMemo(
    () => (oldText != null || newText != null ? { oldText: oldText ?? null, newText: newText ?? null } : null),
    [oldText, newText],
  );
  const files = useMemo(() => buildDiffFiles(patch, contents), [patch, contents]);

  useEffect(() => { setReveals([]); }, [patch]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Viewed state follows (repo, file, patch) — a new revision is un-viewed.
  const viewedKey = filePath ? `${cwd ?? ""}\u0000${filePath}\u0000${fnv1a(patch)}` : null;
  useEffect(() => {
    setViewedState(viewedKey !== null && viewedKey in viewedEntries());
  }, [viewedKey]);

  const toggleViewed = useCallback(() => {
    if (viewedKey === null) return;
    setViewedState((current) => {
      persistViewed(viewedKey, !current);
      return !current;
    });
  }, [viewedKey]);

  const revealGap = useCallback((gapIndex: number, total: number) => {
    setReveals((current) => {
      const next = [...current];
      next[gapIndex] = nextRevealCount(current[gapIndex] ?? 0, total);
      return next;
    });
  }, []);

  const language = filePath ? getLanguage(filePath) : "text";
  const [langReady, setLangReady] = useState(() => isLanguageRegistered(language));
  useEffect(() => {
    setLangReady(isLanguageRegistered(language));
    const pending = ensureLanguageRegistered(language);
    if (pending) pending.then(() => setLangReady(true)).catch(() => undefined);
  }, [language]);

  const splitAllowed = containerWidth >= SPLIT_MIN_WIDTH_PX;
  const split = !wrap && (userLayout ?? "split") === "split" && splitAllowed;

  if (!files) {
    return (
      <div style={{ padding: "12px 16px", fontSize: "calc(12px * var(--ui-font-scale-lg, 1))", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
        {t("fileViewer.noChanges")}
      </div>
    );
  }

  // One block of aligned lines (a rows item). Highlighted through
  // SyntaxHighlighter's renderer; the plain path feeds empty rows so every
  // line falls back to its raw text with identical placement.
  const renderLineBlock = (lines: RenderLine[], blockKey: string, gutter: string, sideBorder: boolean): React.ReactNode => {
    if (lines.length === 0) return null;
    const highlighted = langReady && language !== "text";

    const renderLine = (line: RenderLine, index: number, rendererProps: RendererProps | null): React.ReactNode => {
      const { cell, column } = line;
      const rendererRow = rendererProps?.rows[index];
      const cols = displayColumns(cell.text);
      const wordBg = cell.wordSpans && (cell.kind === "added" || cell.kind === "removed")
        ? wordSpansBackground(cell.wordSpans, cols, wordSpanColor(cell.kind))
        : undefined;
      return (
        <div
          key={`dl-${blockKey}-${index}`}
          data-diff-line={column}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gridColumn: column,
            gridRow: String(index + 1),
            background: cellBackground(cell.kind),
            borderRight: sideBorder && column === 1 ? "1px solid var(--border)" : undefined,
            minHeight: `${LINE_HEIGHT}em`,
          }}
        >
          <span
            style={{
              flexShrink: 0,
              minWidth: gutter,
              padding: "0 10px 0 8px",
              textAlign: "right",
              color: "var(--text-dim)",
              userSelect: "none",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {cell.lineNo ?? ""}
          </span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              whiteSpace: wrap ? "pre-wrap" : "pre",
              overflowWrap: wrap ? "anywhere" : undefined,
              tabSize: TAB_WIDTH,
              color: "var(--text)",
              backgroundImage: wordBg,
            }}
          >
            {rendererRow?.children?.length
              ? rendererRow.children.map((node, tokenIndex) => renderSyntaxNode({
                  node,
                  stylesheet: rendererProps?.stylesheet ?? {},
                  useInlineStyles: rendererProps?.useInlineStyles ?? true,
                  key: `tok-${blockKey}-${index}-${tokenIndex}`,
                }))
              : cell.text || "\u00a0"}
          </span>
        </div>
      );
    };

    if (!highlighted) {
      return (
        <div key={blockKey} style={{ display: "contents" }}>
          {lines.map((line, index) => renderLine(line, index, null))}
        </div>
      );
    }

    return (
      <SyntaxHighlighter
        key={blockKey}
        language={language}
        style={isDark ? vscDarkPlus : vs}
        PreTag="div"
        CodeTag="span"
        // wrapLines is what makes every row a line element with `.children`
        // (without it rsh hands the renderer a flat token array).
        wrapLines
        customStyle={{ display: "contents", margin: 0, padding: 0, background: "transparent" }}
        codeTagProps={{ style: { display: "contents", fontFamily: "inherit" } }}
        renderer={(rendererProps) => lines.map((line, index) => renderLine(line, index, rendererProps))}
      >
        {lines.map((line) => line.cell.text).join("\n")}
      </SyntaxHighlighter>
    );
  };

  const renderFile = (model: DiffFileModel, fileIndex: number): React.ReactNode => {
    const items = buildViewItems(model, reveals, contents);
    let renderedLines = 0;
    let truncated = 0;
    const prepared = items.map((item) => {
      if (item.type === "bar") return { item, data: null as null | RenderedRows };
      const limited = item.rows.slice(0, Math.max(0, MAX_RENDERED_LINES - renderedLines));
      truncated += item.rows.length - limited.length;
      renderedLines += limited.length;
      return { item: { ...item, rows: limited } as typeof item, data: toRenderLines(limited, split) };
    });

    let maxLineNo = 0;
    let leftMax = 0;
    let rightMax = 0;
    for (const { data } of prepared) {
      if (!data) continue;
      maxLineNo = Math.max(maxLineNo, data.maxLineNo);
      leftMax = Math.max(leftMax, data.leftMax);
      rightMax = Math.max(rightMax, data.rightMax);
    }
    const gutter = `calc(${Math.max(3, String(maxLineNo).length)}ch + 16px)`;

    // Grid row cursor: bars occupy one row; a rows item occupies its line
    // count (split keeps both sides on the same row numbers).
    let gridRow = 1;
    const children: React.ReactNode[] = [];
    for (const { item, data } of prepared) {
      if (item.type === "bar") {
        const expandable = item.materializable && contents !== null;
        children.push(
          <button
            key={`bar-${item.gapIndex}`}
            type="button"
            disabled={!expandable}
            onClick={expandable ? () => revealGap(item.gapIndex, item.total) : undefined}
            title={!expandable ? t(contentsTruncated ? "diff.contentsTruncated" : "diff.hiddenLinesStatic") : undefined}
            style={{
              gridColumn: "1 / -1",
              gridRow: String(gridRow),
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "3px 12px",
              border: "none",
              borderTop: "1px solid var(--border)",
              borderBottom: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-dim)",
              cursor: expandable ? "pointer" : "default",
              fontSize: "calc(11px * var(--ui-font-scale-sm, 1))",
              fontFamily: "inherit",
              textAlign: "left",
            }}
          >
            <ChevronDown size={12} strokeWidth={2.2} aria-hidden="true" style={{ flexShrink: 0 }} />
            {tn("diff.hiddenLines", item.remaining)}
          </button>,
        );
        gridRow += 1;
        continue;
      }
      if (!data || data.lines.length === 0) continue;
      children.push(renderLineBlock(data.lines, `${fileIndex}-${item.key}`, gutter, split));
      gridRow += split ? data.lines.length / 2 : data.lines.length;
    }

    if (truncated > 0) {
      children.push(
        <div key="trunc" style={{ gridColumn: "1 / -1", gridRow: String(gridRow), padding: "6px 12px", color: "var(--text-dim)", background: "var(--bg-subtle)", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", textAlign: "center" }}>
          {tn("diff.moreLines", truncated)}
        </div>,
      );
    }

    const gridColumns = split
      ? `minmax(calc(${Math.ceil(leftMax)}ch + 16px), 1fr) minmax(calc(${Math.ceil(rightMax)}ch + 16px), 1fr)`
      : "minmax(0, 1fr)";

    return (
      <div key={`file-${fileIndex}`} style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, minWidth: 0 }}>
        {showHeader && (
          <DiffFileHeader
            model={model}
            filePath={filePath}
            cwd={cwd}
            copyText={newText}
            viewed={viewed}
            onToggleViewed={toggleViewed}
            showPath={showPath}
            showViewed={showViewed}
            onOpenFile={onOpenFile}
          />
        )}
        {showLayoutToggle && (
          <div style={{ display: "flex", gap: 4, padding: "4px 10px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
            <LayoutButton active={split} onClick={() => { setUserLayout("split"); setWrap(false); }} label={t("diff.splitView")} icon={<Columns2 size={12} strokeWidth={2} />} visible={splitAllowed} />
            <LayoutButton active={!split && !wrap} onClick={() => { setUserLayout("unified"); setWrap(false); }} label={t("diff.unifiedView")} icon={<List size={12} strokeWidth={2} />} visible={splitAllowed} />
            <LayoutButton active={wrap} onClick={() => { setWrap((w) => !w); if (!wrap) setUserLayout("unified"); }} label={t("diff.wrapLines")} icon={<WrapText size={12} strokeWidth={2} />} visible />
          </div>
        )}
        <div ref={containerRef} style={{ flex: 1, minHeight: 0, overflow: "auto", fontFamily: "var(--font-mono)", fontSize: "calc(12px * var(--ui-font-scale-lg, 1))", lineHeight: LINE_HEIGHT, minWidth: 0 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: gridColumns,
              gridAutoRows: "min-content",
              minWidth: "100%",
              background: "var(--bg)",
            }}
          >
            {children}
          </div>
        </div>
      </div>
    );
  };

  return <section style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, minWidth: 0 }}>{files.map(renderFile)}</section>;
}

// ---------- header pieces ----------

const headerIconButtonStyle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  width: 22, height: 22, padding: 0, flexShrink: 0,
  border: "none", borderRadius: "var(--radius-control)",
  background: "none", color: "var(--text-muted)", cursor: "pointer",
};

function DiffFileHeader({ model, filePath, cwd, copyText, viewed, onToggleViewed, showPath, showViewed, onOpenFile }: {
  model: DiffFileModel;
  filePath: string | null;
  cwd: string | null;
  copyText: string | null | undefined;
  viewed: boolean;
  onToggleViewed: () => void;
  showPath: boolean;
  showViewed: boolean;
  onOpenFile?: (filePath: string) => void;
}) {
  const { t } = useI18n();
  const name = filePath ? getFileName(filePath) : (model.newPath ?? model.oldPath ?? "");
  const dir = filePath && filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : cwd ?? "";
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("diff.copied"));
    } catch {
      toast.error(t("diff.copyFailed"));
    }
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)", minWidth: 0 }}>
      <span style={{ display: "inline-flex", flexShrink: 0 }} aria-hidden="true">{getFileIcon(name)}</span>
      <span style={{ fontSize: "calc(11.5px * var(--ui-font-scale-sm, 1))", fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}>{name}</span>
      {showPath && dir && (
        <span
          title={filePath ?? dir}
          style={{ fontSize: "calc(10.5px * var(--ui-font-scale-sm, 1))", color: "var(--text-dim)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: "rtl", textAlign: "left", minWidth: 0 }}
        >
          {dir}
        </span>
      )}
      <span style={{ fontSize: "calc(10.5px * var(--ui-font-scale-sm, 1))", fontWeight: 600, color: "var(--status-success)", flexShrink: 0 }} aria-label={t("diff.statsAria", { added: model.added, deleted: model.removed })}>
        +{model.added}
      </span>
      <span style={{ fontSize: "calc(10.5px * var(--ui-font-scale-sm, 1))", fontWeight: 600, color: "var(--status-error)", flexShrink: 0 }}>
        −{model.removed}
      </span>
      <span style={{ flex: 1, minWidth: 0 }} />
      {filePath && copyText != null && (
        <button type="button" onClick={() => void copy(copyText)} title={t("diff.copyContent")} aria-label={t("diff.copyContent")} className="ui-focus-ring" style={headerIconButtonStyle}>
          <Copy size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
      {filePath && onOpenFile && (
        <button type="button" onClick={() => onOpenFile(filePath)} title={t("gitChanges.openFile")} aria-label={t("gitChanges.openFile")} className="ui-focus-ring" style={headerIconButtonStyle}>
          <ExternalLink size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
      {showViewed && filePath && (
        <button
          type="button"
          onClick={onToggleViewed}
          aria-pressed={viewed}
          title={viewed ? t("diff.markUnviewed") : t("diff.markViewed")}
          className="ui-focus-ring"
          style={{
            display: "inline-flex", alignItems: "center", gap: 4, height: 20, padding: "0 8px", flexShrink: 0,
            border: "1px solid var(--border)", borderRadius: "var(--radius-control)",
            background: viewed ? "var(--bg-hover)" : "var(--bg)",
            color: viewed ? "var(--text)" : "var(--text-dim)",
            fontSize: "calc(10.5px * var(--ui-font-scale-sm, 1))", fontWeight: 600, cursor: "pointer",
          }}
        >
          <Check size={11} strokeWidth={2.4} aria-hidden="true" />
          {t("diff.viewed")}
        </button>
      )}
    </div>
  );
}

function LayoutButton({ active, onClick, label, icon, visible }: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
  visible: boolean;
}) {
  if (!visible) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={label}
      aria-label={label}
      className="ui-focus-ring"
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: 22, height: 20, padding: 0,
        border: "1px solid var(--border)", borderRadius: "var(--radius-control)",
        background: active ? "var(--bg-selected)" : "var(--bg)",
        color: active ? "var(--text)" : "var(--text-dim)",
        cursor: "pointer",
      }}
    >
      {icon}
    </button>
  );
}
