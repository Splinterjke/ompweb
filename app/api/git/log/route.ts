import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { getGitCommitLog } from "@/lib/git-log";
import { withGitReadCache } from "@/lib/git-cache";

// Read-only commit history + graph geometry for the git-graph modal. Unlike
// the other git routes this one always runs the local git binary: the Rust
// host facade (doc 16 route 10) exposes no history API, and log output is
// bounded and read-only, so the Node path needs no host fallback.
// The graph is the heaviest git call (`git log --all --graph --numstat`);
// a short TTL cache makes re-opening the modal cheap. ?refresh=1 bypasses.
const LOG_TTL_MS = 30_000;
export async function GET(request: NextRequest) {
  try {
    const cwd = request.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    const limitParam = request.nextUrl.searchParams.get("limit")?.trim() ?? "";
    const limit = limitParam ? Number(limitParam) : 400;
    const roots = await getAllowedFileRoots();
    if (!cwd || !isExistingFilePathAllowed(cwd, roots)) return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    const refresh = request.nextUrl.searchParams.get("refresh") === "1";
    const { rows, maxLane } = refresh
      ? await getGitCommitLog(cwd, Number.isFinite(limit) ? limit : 400)
      : await withGitReadCache(`log:${cwd}:${Number.isFinite(limit) ? limit : 400}`, LOG_TTL_MS, () =>
          getGitCommitLog(cwd, Number.isFinite(limit) ? limit : 400));
    return NextResponse.json({ rows, maxLane });
  } catch (error) {
    const err = error as { killed?: boolean; signal?: string; message?: string } | null;
    const isTimeout = err && (err.killed || err.signal === "SIGTERM" || /timeout|timed out|ETIMEDOUT/i.test(err.message ?? ""));
    return NextResponse.json({
      error: isTimeout ? "Git log timed out — the repository is too large or slow; try again after a while or reduce the limit." : err?.message ? String(err.message) : "Git log failed",
      code: "git_log_failed",
    }, { status: 400 });
  }
}
