/** Shared shapes for the Mnemopi memory viewer (read-only). Client-safe by
 * design: `lib/client` types and the server reader both consume this module,
 * so panel and database surface can never drift apart. */

export type MemoryTable = "working" | "episodic" | "facts";

export interface MemoryBankCounts {
  working: number | null;
  episodic: number | null;
  facts: number | null;
  gists: number | null;
}

export interface MemoryBankInfo {
  name: string;
  counts: MemoryBankCounts;
  /** mtime of the mnemopi.db file (epoch ms). */
  mtimeMs: number;
  /** Set when the database could not be opened read-only. */
  error?: string;
}

/** One row; the server selects only whitelisted columns per table, so the
 * shape varies by table and values are primitives or null. */
export type MemoryItem = Record<string, string | number | bigint | null | undefined>;

export interface MemoryQueryResult {
  bank: string;
  table: MemoryTable;
  total: number;
  limit: number;
  offset: number;
  items: MemoryItem[];
}

export interface MemoryQueryPage {
  q?: string;
  limit?: number;
  offset?: number;
}
