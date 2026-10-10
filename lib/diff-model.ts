import { parseUnifiedPatch, type SplitDiffFile } from "./patch.ts";

// A display-oriented, allocation-light view over a unified patch: paired
// split rows plus the hidden line ranges (gaps) between hunks. Pure — no
// React, no I/O. The Copilot-style viewer renders `buildViewItems` output;
// gap expansion materializes real lines from the two file texts the
// `contents=1` diff mode returns, so revealing context never re-diffs.

export type DiffCellKind = "context" | "removed" | "added" | "empty";

export interface DiffCell {
  lineNo: number | null;
  text: string;
  kind: DiffCellKind;
  /** Char ranges where the line actually differs from its counterpart —
   *  the word-level inline highlight; only set on paired removed/added rows. */
  wordSpans?: Array<[number, number]>;
}

export interface DiffRow {
  left: DiffCell;
  right: DiffCell;
}

/** Hidden common-text range between two hunks (or a file edge and a hunk).
 *  `count` equal lines are hidden on each side; `materializable` says both
 *  sides hide the same amount, so content expansion is well defined. */
export interface DiffGapSection {
  type: "gap";
  gapIndex: number;
  oldStart: number;
  newStart: number;
  count: number;
  materializable: boolean;
}

export type DiffSection =
  | { type: "hunk"; rows: DiffRow[] }
  | DiffGapSection;

export interface DiffFileModel {
  oldPath: string | null;
  newPath: string | null;
  added: number;
  removed: number;
  sections: DiffSection[];
}

export interface DiffContents {
  oldText: string | null;
  newText: string | null;
}

// ---------- word-level inline diff ----------

/** Token-budget guard: LCS is O(n*m); beyond this the inline tint is simply
 *  skipped (cosmetic only, the row itself renders normally). */
const MAX_WORD_DIFF_TOKENS = 500;

interface Token {
  text: string;
  start: number;
  end: number;
}

function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  const re = /[A-Za-z0-9_$]+|\s+|[^\sA-Za-z0-9_$]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

/** Merge changed token indices into char spans, gluing runs whose gap is
 *  whitespace-only so `foo bar` → `foo baz` tints both words, not just one. */
function changedSpans(tokens: Token[], changed: boolean[]): Array<[number, number]> | null {
  const isWhitespace = (text: string): boolean => /^\s+$/.test(text);
  const spans: Array<[number, number]> = [];
  let start = -1;
  let prev = -1;
  for (let i = 0; i < changed.length; i++) {
    if (!changed[i]) continue;
    if (start < 0) {
      start = i;
      prev = i;
      continue;
    }
    let whitespaceOnlyGap = true;
    for (let t = prev + 1; t < i; t++) {
      if (!isWhitespace(tokens[t].text)) {
        whitespaceOnlyGap = false;
        break;
      }
    }
    if (whitespaceOnlyGap) prev = i;
    else {
      spans.push([tokens[start].start, tokens[prev].end]);
      start = i;
      prev = i;
    }
  }
  if (start >= 0) spans.push([tokens[start].start, tokens[prev].end]);
  return spans.length > 0 ? spans : null;
}

/**
 * Word-level char ranges for a paired removed/added line. Tokens not in the
 * line-pair LCS are the changed words; adjacent changed runs separated by
 * only whitespace merge into one span. `null` when the lines are identical
 * or exceed the token budget.
 */
export function wordDiffSpans(
  oldLine: string,
  newLine: string,
): { left?: Array<[number, number]>; right?: Array<[number, number]> } | null {
  if (oldLine === newLine) return null;
  const a = tokenize(oldLine);
  const b = tokenize(newLine);
  if (a.length > MAX_WORD_DIFF_TOKENS || b.length > MAX_WORD_DIFF_TOKENS) return null;

  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const dp = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = a[i].text === b[j].text
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  const aChanged: boolean[] = new Array(n).fill(false);
  const bChanged: boolean[] = new Array(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].text === b[j].text) {
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      aChanged[i++] = true;
    } else {
      bChanged[j++] = true;
    }
  }
  while (i < n) aChanged[i++] = true;
  while (j < m) bChanged[j++] = true;

  const left = changedSpans(a, aChanged);
  const right = changedSpans(b, bChanged);
  if (!left && !right) return null;
  return { left: left ?? undefined, right: right ?? undefined };
}

// ---------- model ----------

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function cloneCell(cell: { lineNo: number | null; text: string; type: DiffCellKind }): DiffCell {
  return { lineNo: cell.lineNo, text: cell.text, kind: cell.type };
}

/**
 * Build the display models for every file in a unified patch. With
 * `contents` (the two file versions) the file's top/bottom hidden ranges
 * are known too; without them only the between-hunk gaps are representable.
 */
export function buildDiffFiles(patch: string, contents?: DiffContents | null): DiffFileModel[] | null {
  const files = parseUnifiedPatch(patch);
  if (!files) return null;
  return files.map((file) => buildFileModel(file, contents ?? null));
}

function buildFileModel(file: SplitDiffFile, contents: DiffContents | null): DiffFileModel {
  const oldLines = contents?.oldText != null ? splitLines(contents.oldText) : null;
  const newLines = contents?.newText != null ? splitLines(contents.newText) : null;

  const sections: DiffSection[] = [];
  let gapIndex = 0;
  let added = 0;
  let removed = 0;
  let hunkRows: DiffRow[] = [];
  let prevOldEnd = 0; // last covered old line (1-based, inclusive)
  let prevNewEnd = 0;

  const closeHunk = () => {
    if (hunkRows.length > 0) {
      sections.push({ type: "hunk", rows: hunkRows });
      hunkRows = [];
    }
  };

  const pushGap = (oldEdge: number, newEdge: number) => {
    const count = Math.max(oldEdge, newEdge);
    if (count <= 0) return;
    closeHunk();
    sections.push({
      type: "gap",
      gapIndex: gapIndex++,
      oldStart: prevOldEnd + 1,
      newStart: prevNewEnd + 1,
      count,
      materializable: oldEdge === newEdge,
    });
  };

  for (const row of file.rows) {
    if (row.type === "hunk") {
      // Marker/noise rows (`\ No newline...`, `diff --git`) carry no bounds
      // and render nowhere — they must not shift the gap arithmetic.
      if (row.oldStart === undefined || row.newStart === undefined) continue;
      const oldCount = row.oldCount ?? 1;
      const newCount = row.newCount ?? 1;
      pushGap(
        row.oldStart >= 1 ? Math.max(0, row.oldStart - 1 - prevOldEnd) : 0,
        row.newStart >= 1 ? Math.max(0, row.newStart - 1 - prevNewEnd) : 0,
      );
      if (oldCount > 0 && row.oldStart >= 1) prevOldEnd = Math.max(prevOldEnd, row.oldStart + oldCount - 1);
      if (newCount > 0 && row.newStart >= 1) prevNewEnd = Math.max(prevNewEnd, row.newStart + newCount - 1);
      continue;
    }

    const left = cloneCell(row.left);
    const right = cloneCell(row.right);
    if (left.kind === "removed") removed++;
    if (right.kind === "added") added++;
    if (left.kind === "removed" && right.kind === "added") {
      const spans = wordDiffSpans(left.text, right.text);
      if (spans) {
        if (spans.left) left.wordSpans = spans.left;
        if (spans.right) right.wordSpans = spans.right;
      }
    }
    hunkRows.push({ left, right });
  }

  // Tail gap: only known when both file texts are available.
  if (oldLines && newLines) {
    pushGap(
      Math.max(0, oldLines.length - prevOldEnd),
      Math.max(0, newLines.length - prevNewEnd),
    );
  }
  closeHunk();

  return {
    oldPath: file.oldPath ?? null,
    newPath: file.newPath ?? null,
    added,
    removed,
    sections,
  };
}

// ---------- view assembly (progressive gap reveal) ----------

const REVEAL_STEP_ONE = 20;
const REVEAL_STEP_TWO = 40;

/** Click sequence for one hidden-lines bar: 20 lines, then 40, then all. */
export function nextRevealCount(current: number, total: number): number {
  if (current >= total) return total;
  if (current <= 0) return Math.min(REVEAL_STEP_ONE, total);
  if (current <= REVEAL_STEP_ONE) return Math.min(REVEAL_STEP_TWO, total);
  return total;
}

export type DiffViewItem =
  | {
      type: "bar";
      key: string;
      gapIndex: number;
      total: number;
      revealed: number;
      remaining: number;
      materializable: boolean;
    }
  | { type: "rows"; key: string; rows: DiffRow[] };

/**
 * Flatten a model into render items given the per-gap reveal counts. Gaps
 * reveal top-down: materialized context rows come first, then a bar for
 * whatever stays hidden. Without contents (or for non-materializable gaps)
 * the bar is static — a click can never reveal nothing.
 */
export function buildViewItems(
  model: DiffFileModel,
  reveals: ReadonlyArray<number>,
  contents: DiffContents | null,
): DiffViewItem[] {
  const oldLines = contents?.oldText != null ? splitLines(contents.oldText) : null;
  const newLines = contents?.newText != null ? splitLines(contents.newText) : null;
  const items: DiffViewItem[] = [];
  let buffer: DiffRow[] = [];
  const flush = () => {
    if (buffer.length === 0) return;
    items.push({ type: "rows", key: `r${items.length}`, rows: buffer });
    buffer = [];
  };
  for (const section of model.sections) {
    if (section.type === "hunk") {
      buffer.push(...section.rows);
      continue;
    }
    // A bar that can never reveal content stays full-width whatever the
    // reveal state holds — it must not silently vanish.
    const revealed = section.materializable && oldLines && newLines
      ? Math.min(reveals[section.gapIndex] ?? 0, section.count)
      : 0;
    if (revealed > 0) {
      for (let i = 0; i < revealed; i++) {
        const oldIndex = section.oldStart - 1 + i;
        const newIndex = section.newStart - 1 + i;
        buffer.push({
          left: { lineNo: section.oldStart + i, text: oldLines[oldIndex] ?? "", kind: "context" },
          right: { lineNo: section.newStart + i, text: newLines[newIndex] ?? "", kind: "context" },
        });
      }
    }
    const remaining = section.count - revealed;
    if (remaining > 0) {
      flush();
      items.push({
        type: "bar",
        key: `g${section.gapIndex}`,
        gapIndex: section.gapIndex,
        total: section.count,
        revealed,
        remaining,
        materializable: section.materializable,
      });
    }
  }
  flush();
  return items;
}
