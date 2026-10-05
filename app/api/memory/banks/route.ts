import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { listMemoryBanks } from "@/lib/memory-reader";

// GET /api/memory/banks → { banks: MemoryBankInfo[] }
// Lists the Mnemopi banks (<agent dir>/memories/mnemopi/banks) with per-table
// row counts and the database mtime. Strictly read-only: the reader opens
// every live database with mode=ro and only counts whitelisted tables.
export async function GET() {
  try {
    return NextResponse.json({ banks: await listMemoryBanks() });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
