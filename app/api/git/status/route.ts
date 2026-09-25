import fs from "fs";
import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { recordBackendError } from "@/lib/backend-errors";
import { isNonRepositoryError } from "@/lib/git-nonrepo";
import { hostClient, rustBackendActive } from "@/lib/omp/host-client";
import { getGitStatus } from "@/lib/git-changes";
import { withGitReadCache } from "@/lib/git-cache";

// Short-TTL cache: the git tab, the composer git bar and the sidebar badges
// all poll this endpoint for the same repo; the cache collapses them into a
// single `git status` (single-flight) and serves repeats without spawning git.
const STATUS_TTL_MS = 5000;

export async function GET(request: NextRequest) {
  try {
    const cwd = request.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path", code: "cwd_must_be_absolute" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(cwd);
    } catch {
      return NextResponse.json({ error: "Directory not found", code: "directory_not_found" }, { status: 404 });
    }
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "Not a directory", code: "not_a_directory" }, { status: 400 });
    }
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }

    // Doc 16 route 10: in Rust mode the host owns local git (status parity
    // against the Node implementation is frozen by lib/git-parity.test.mjs);
    // the Node path exists only for the explicit OMPWEB_BACKEND=node rollback.
    // ?refresh=1 bypasses the cache (manual refresh / right after a commit).
    const refresh = request.nextUrl.searchParams.get("refresh") === "1";
    const status = refresh
      ? await (rustBackendActive() ? hostClient.git.status([...allowedRoots], cwd) : getGitStatus(cwd))
      : await withGitReadCache(`status:${cwd}`, STATUS_TTL_MS, () =>
          rustBackendActive() ? hostClient.git.status([...allowedRoots], cwd) : getGitStatus(cwd));
    return NextResponse.json(status);
  } catch (error) {
    // A non-repo is a normal situation, not a backend failure — recording
    // it would degrade the whole app for every non-git workspace.
    if (!isNonRepositoryError(error)) {
      recordBackendError("git_status_failed", error instanceof Error ? error.message : String(error));
    }
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "git_status_failed";
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error), code }, { status: 500 });
  }
}
