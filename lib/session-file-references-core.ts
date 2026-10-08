import type { SessionEntry } from "./types";

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSessionId(sessionId: string | null): sessionId is string {
  return !!sessionId && SESSION_ID_RE.test(sessionId);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function isPathChar(ch: string): boolean {
  return /[A-Za-z0-9._~+%@/\\:-]/.test(ch);
}

function hasReferenceBoundaryAfter(text: string, index: number): boolean {
  if (index >= text.length) return true;
  const ch = text[index];
  if (ch === ":") return /\d/.test(text[index + 1] ?? "");
  return !isPathChar(ch);
}

function containsExactPathReference(text: string, filePath: string): boolean {
  const target = normalizeSlashes(filePath);
  const targets = target.startsWith("/") ? [target, `file://${target}`] : [target];
  const haystacks = new Set([normalizeSlashes(text), normalizeSlashes(safeDecode(text))]);

  for (const haystack of haystacks) {
    for (const t of targets) {
      let index = haystack.indexOf(t);
      while (index !== -1) {
        const before = index === 0 ? "" : haystack[index - 1];
        const afterIndex = index + t.length;
        if ((index === 0 || !isPathChar(before)) && hasReferenceBoundaryAfter(haystack, afterIndex)) {
          return true;
        }
        index = haystack.indexOf(t, index + 1);
      }
    }
  }

  return false;
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  for (const item of Object.values(value)) collectStrings(item, out);
}

/**
 * `homeDir` lets a `~/rel` mention authorize `<homeDir>/rel`: the agent's
 * shell expands `~` to the same user's home, so it names exactly that file.
 */
export function isFilePathReferencedByEntries(filePath: string, entries: SessionEntry[], homeDir?: string): boolean {
  const targets = [filePath];
  const target = normalizeSlashes(filePath);
  const home = homeDir ? normalizeSlashes(homeDir).replace(/\/+$/, "") : "";
  if (home && target.startsWith(`${home}/`)) targets.push(`~${target.slice(home.length)}`);
  for (const entry of entries) {
    const strings: string[] = [];
    collectStrings(entry, strings);
    if (strings.some((text) => targets.some((t) => containsExactPathReference(text, t)))) return true;
  }
  return false;
}

export function isBashOutputPathReferencedByEntries(filePath: string, entries: SessionEntry[]): boolean {
  return entries.some((entry) => (
    entry.type === "message"
    && entry.message.role === "bashExecution"
    && entry.message.fullOutputPath === filePath
  ));
}
