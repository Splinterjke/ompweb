import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { getGitCommitLog } from "@/lib/git-log";

// Read-only commit history + graph geometry for the git-graph modal. Unlike
// the other git routes this one always runs the local git binary: the Rust
// host facade (doc 16 route 10) exposes no history API, and log output is
// bounded and read-only, so the Node path needs no host fallback.
export async function GET(request: NextRequest) {
  try {
    const cwd = request.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    const limitParam = request.nextUrl.searchParams.get("limit")?.trim() ?? "";
    const limit = limitParam ? Number(limitParam) : 400;
    const roots = await getAllowedFileRoots();
    if (!cwd || !isExistingFilePathAllowed(cwd, roots)) return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    const { rows, maxLane } = await getGitCommitLog(cwd, Number.isFinite(limit) ? limit : 400);
    return NextResponse.json({ rows, maxLane });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error), code: "git_log_failed" }, { status: 400 });
  }
}
