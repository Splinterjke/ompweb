import { createReadStream, promises as fs } from "fs";
import { createInterface } from "readline";
import { listAllSessions } from "./session-reader";
import {
  compileSearchQuery,
  CONTENT_WEIGHT,
  FIRST_MESSAGE_WEIGHT,
  scoreSearchFields,
  searchField,
  TITLE_WEIGHT,
  type SearchField,
} from "./session-search";

interface ContentCacheEntry {
  version: string;
  field: Promise<SearchField>;
}

declare global {
  var __ompSessionContentSearchCache: Map<string, ContentCacheEntry> | undefined;
}

const PARSE_CONCURRENCY = 4;

/** User and assistant text only: tool output and thinking would drown real matches. */
async function extractTranscriptText(filePath: string): Promise<string> {
  const parts: string[] = [];
  const lines = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    // The role sits near the line start; skip tool results (often MBs) unparsed.
    const head = line.slice(0, 400);
    if (!head.includes('"type":"message"') || !(head.includes('"role":"user"') || head.includes('"role":"assistant"'))) continue;
    let content: unknown;
    try {
      content = JSON.parse(line)?.message?.content;
    } catch {
      continue;
    }
    if (typeof content === "string") parts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    }
  }
  return parts.join("\n");
}

// shortcut: holds every session's extracted text in memory (~1% of file size) and
// re-reads a whole file when it changes; move to an on-disk index if installs outgrow that.
async function transcriptField(filePath: string, cache: Map<string, ContentCacheEntry>): Promise<SearchField | null> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    cache.delete(filePath);
    return null;
  }
  const version = `${stat.size}:${stat.mtimeMs}`;
  let entry = cache.get(filePath);
  if (entry?.version !== version) {
    entry = { version, field: extractTranscriptText(filePath).then((text) => searchField(text, CONTENT_WEIGHT)) };
    cache.set(filePath, entry);
    // A failed read must not stay cached.
    entry.field.catch(() => { if (cache.get(filePath) === entry) cache.delete(filePath); });
  }
  return entry.field.catch(() => null);
}

/**
 * Yields matching session ids with their scores (titles outrank transcript
 * matches), one batch per group of scanned files, so callers can stream hits.
 * Every group yields, even with no hits: a caller stopping the iteration
 * (`return()` waits for the pending `next()`) then stops after that group.
 */
export async function* searchSessions(rawQuery: string): AsyncGenerator<Record<string, number>> {
  const query = compileSearchQuery(rawQuery);
  if (!query) return;
  const sessions = await listAllSessions();
  const cache = (globalThis.__ompSessionContentSearchCache ??= new Map());
  const listed = new Set(sessions.map((s) => s.path));
  for (const path of cache.keys()) if (!listed.has(path)) cache.delete(path);

  for (let i = 0; i < sessions.length; i += PARSE_CONCURRENCY) {
    const scores: Record<string, number> = {};
    await Promise.all(sessions.slice(i, i + PARSE_CONCURRENCY).map(async (session) => {
      const fields = [searchField(session.name ?? "", TITLE_WEIGHT), searchField(session.firstMessage, FIRST_MESSAGE_WEIGHT)];
      const content = await transcriptField(session.path, cache);
      if (content) fields.push(content);
      const score = scoreSearchFields(fields, query);
      if (score !== null) scores[session.id] = score;
    }));
    yield scores;
  }
}
