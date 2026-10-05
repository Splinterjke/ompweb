/**
 * Read-only access to Mnemopi memory banks for the Memory panel.
 *
 * Banks are LIVE SQLite databases of the running agent
 * (`<agent dir>/memories/mnemopi/banks/<bank>/mnemopi.db` + -wal/-shm).
 * Every connection here opens strictly with `readOnly: true` — there is no
 * write path in this module, and the routes expose only GETs. Bank names are
 * validated against the real directory listing (never joined raw), so a
 * traversal payload can never escape the banks root.
 *
 * Only curated tables/columns are ever SELECTed: the FTS5 shadow tables
 * (fts families and their `_data`/`_idx`/`_docsize`/`_content`/`_config`
 * shadows), the embedding blobs (binary_vector) and the unused
 * memoria/triples/scratchpad families are never surfaced.
 */
import { existsSync, readdirSync, statSync } from "fs";
import type { DatabaseSync } from "node:sqlite";
import { join } from "path";
import { getAgentDir } from "./omp/paths";
import type {
  MemoryBankCounts,
  MemoryBankInfo,
  MemoryItem,
  MemoryQueryResult,
  MemoryTable,
} from "./memory-types";

/** Bank name not present in the banks directory (or its database file is
 * gone). Routes map this to 404; a stable `code` lets clients branch. */
export class UnknownMemoryBankError extends Error {
  readonly code = "unknown_bank";
  constructor(bank: string) {
    super(`Unknown memory bank: ${bank}`);
    this.name = "UnknownMemoryBankError";
  }
}

/** `<agent dir>/memories/mnemopi/banks` — same tree the mnemopi memory
 * backend uses; profiles/XDG come along via getAgentDir(). Resolved per call
 * because the agent dir is environment-driven (tests, isolated runs). */
export function getMemoryBanksRoot(): string {
  return join(getAgentDir(), "memories", "mnemopi", "banks");
}

/** Per-table SELECT plan. Columns are a whitelist intersected with the live
 * schema, so a bank written by another mnemopi version never breaks the
 * panel; `search` columns are ORed for the substring filter and `order`
 * drives the newest-first sort. */
const TABLE_SPECS: Record<MemoryTable, { sqliteTable: string; columns: string[]; search: string[]; order: string }> = {
  working: {
    sqliteTable: "working_memory",
    columns: ["id", "content", "memory_type", "importance", "timestamp", "recall_count", "source"],
    search: ["content"],
    order: "timestamp",
  },
  episodic: {
    sqliteTable: "episodic_memory",
    columns: ["id", "content", "source", "importance", "summary_of", "timestamp", "memory_type"],
    search: ["content"],
    order: "timestamp",
  },
  facts: {
    sqliteTable: "facts",
    columns: ["fact_id", "subject", "predicate", "object", "confidence", "created_at", "timestamp"],
    search: ["subject", "predicate", "object"],
    order: "created_at",
  },
};

/** Counted in the bank list but never queried by the panel. */
const COUNTED_TABLES: Array<[key: keyof MemoryBankCounts, sqliteTable: string]> = [
  ["working", "working_memory"],
  ["episodic", "episodic_memory"],
  ["facts", "facts"],
  ["gists", "gists"],
];

/**
 * Opens the live database strictly read-only.
 *
 * `await import()` is required here (not a static import or require):
 * Turbopack cannot externalize `node:sqlite` in the Next server bundle —
 * the same constraint and workaround as lib/stats-aggregate.ts.
 */
async function openReadonly(dbPath: string): Promise<DatabaseSync> {
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(dbPath, { readOnly: true });
}

/** Bank directory names holding a mnemopi.db, sorted. Empty when the banks
 * root does not exist (no memory backend configured). */
export function listMemoryBankNames(): string[] {
  const root = getMemoryBanksRoot();
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "mnemopi.db")))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return entries.sort();
}

export async function listMemoryBanks(): Promise<MemoryBankInfo[]> {
  const root = getMemoryBanksRoot();
  const banks: MemoryBankInfo[] = [];
  for (const name of listMemoryBankNames()) {
    const dbPath = join(root, name, "mnemopi.db");
    const info: MemoryBankInfo = {
      name,
      counts: { working: null, episodic: null, facts: null, gists: null },
      mtimeMs: 0,
    };
    try {
      info.mtimeMs = statSync(dbPath).mtimeMs;
    } catch { /* keep 0 when the file vanished mid-scan */ }
    let db: DatabaseSync | null = null;
    try {
      db = await openReadonly(dbPath);
      const present = new Set(
        db.prepare("SELECT name FROM sqlite_master WHERE type = ?").all("table").map((row) => String(row.name)),
      );
      for (const [key, sqliteTable] of COUNTED_TABLES) {
        if (!present.has(sqliteTable)) continue;
        const row = db.prepare(`SELECT COUNT(*) AS c FROM "${sqliteTable}"`).get();
        info.counts[key] = Number(row?.c ?? 0);
      }
    } catch (error) {
      info.error = String(error instanceof Error ? error.message : error);
    } finally {
      try { db?.close(); } catch { /* already closed */ }
    }
    banks.push(info);
  }
  return banks;
}

export interface MemoryQueryParams {
  table: MemoryTable;
  q: string;
  limit: number;
  offset: number;
}

/** Newest-first page of one table in one bank, with an optional substring
 * filter (LIKE, bound parameter). The bank name is matched against the real
 * directory listing, so this is the traversal gate. */
export async function queryMemoryBank(bank: string, params: MemoryQueryParams): Promise<MemoryQueryResult> {
  const root = getMemoryBanksRoot();
  if (!listMemoryBankNames().includes(bank)) throw new UnknownMemoryBankError(bank);
  const spec = TABLE_SPECS[params.table];
  const dbPath = join(root, bank, "mnemopi.db");
  const db = await openReadonly(dbPath);
  try {
    const columns = new Set(
      db.prepare("SELECT name FROM pragma_table_info(?)").all(spec.sqliteTable).map((row) => String(row.name)),
    );
    const selected = spec.columns.filter((column) => columns.has(column));
    const where: string[] = [];
    const args: string[] = [];
    if (params.q) {
      const search = spec.search.filter((column) => columns.has(column));
      if (search.length === 0) return { bank, table: params.table, total: 0, limit: params.limit, offset: params.offset, items: [] };
      where.push(`(${search.map((column) => `lower("${column}") LIKE '%' || lower(?) || '%'`).join(" OR ")})`);
      args.push(...search.map(() => params.q));
    }
    const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    // Missing table or order column (older bank layout) → an honest empty
    // page, never a 500.
    if (!columns.has(spec.order) || selected.length === 0) {
      return { bank, table: params.table, total: 0, limit: params.limit, offset: params.offset, items: [] };
    }
    const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM "${spec.sqliteTable}"${whereSql}`).get(...args);
    const total = Number(totalRow?.c ?? 0);
    // node:sqlite widens every column to SQLOutputValue (incl. blob types);
    // the whitelist selects scalar columns only, so rows are scalar maps.
    const rows = db.prepare(
      `SELECT ${selected.map((column) => `"${column}"`).join(", ")} FROM "${spec.sqliteTable}"${whereSql} ORDER BY "${spec.order}" DESC LIMIT ? OFFSET ?`,
    ).all(...args, params.limit, params.offset) as MemoryItem[];
    return { bank, table: params.table, total, limit: params.limit, offset: params.offset, items: rows };
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}
