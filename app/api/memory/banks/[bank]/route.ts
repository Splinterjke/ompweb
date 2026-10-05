import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import {
  queryMemoryBank,
  UnknownMemoryBankError,
} from "@/lib/memory-reader";
import type { MemoryTable } from "@/lib/memory-types";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// GET /api/memory/banks/[bank]?table=working|episodic|facts&q=&limit=&offset=
// → { bank, table, total, limit, offset, items }
// Newest-first page of one whitelisted table with an optional substring
// filter. The bank must exist in the banks directory listing (404 otherwise);
// the database is only ever opened read-only.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ bank: string }> },
) {
  const { bank } = await params;
  const url = new URL(req.url);
  const tableParam = url.searchParams.get("table") ?? "facts";
  const table: MemoryTable | null = tableParam === "working" || tableParam === "episodic" || tableParam === "facts"
    ? tableParam
    : null;
  if (!table) {
    return NextResponse.json(
      { error: "Unknown memory table", code: "unknown_table" },
      { status: 400 },
    );
  }
  const q = url.searchParams.get("q")?.trim() ?? "";
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit")) || DEFAULT_LIMIT));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  try {
    return NextResponse.json(await queryMemoryBank(bank, { table, q, limit, offset }));
  } catch (error) {
    if (error instanceof UnknownMemoryBankError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 404 });
    }
    return apiErrorResponse(error);
  }
}
