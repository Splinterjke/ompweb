import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { getGitFileDiff } from "@/lib/git-changes";
import { getCommitFileDiff } from "@/lib/git-log";
import { recordBackendError } from "@/lib/backend-errors";
import { isNonRepositoryError } from "@/lib/git-nonrepo";
import { hostClient, rustBackendActive } from "@/lib/omp/host-client";

// Two diff modes:
//   working tree  — cwd + path (absolute file path), the legacy contract
//   commit file   — cwd + hash + file (repo-relative path), per-file diff of
//                   one commit against its first parent (git-graph modal)
// The commit-file mode always runs the local git binary: the Rust host
// facade (doc 16 route 10) exposes only working-tree diffs.
export async function GET(request: NextRequest) {
  try {
    const cwd = request.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    const commitHash = request.nextUrl.searchParams.get("hash")?.trim() ?? "";
    const filePath = request.nextUrl.searchParams.get("path")?.trim() ?? "";
    const commitFile = request.nextUrl.searchParams.get("file")?.trim() ?? "";
    const isCommitMode = commitHash.length > 0 || commitFile.length > 0;

    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path", code: "cwd_must_be_absolute" }, { status: 400 });
    }
    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots) || !isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }

    if (isCommitMode) {
      if (!commitHash || !/^[0-9a-f]{7,40}$/.test(commitHash)) {
        return NextResponse.json({ error: "hash must be a 7-40 char hex commit id", code: "invalid_hash" }, { status: 400 });
      }
      if (!commitFile) {
        return NextResponse.json({ error: "file is required", code: "missing_file" }, { status: 400 });
      }
      try {
        return NextResponse.json(await getCommitFileDiff(cwd, commitHash, commitFile));
      } catch (error) {
        // A non-repo is a normal situation, not a backend failure: the
        // commit-file diff simply cannot be computed.
        if (isNonRepositoryError(error)) {
          return NextResponse.json({ supported: false });
        }
        recordBackendError("git_diff_failed", error instanceof Error ? error.message : String(error));
        return NextResponse.json({ error: error instanceof Error ? error.message : String(error), code: "git_diff_failed" }, { status: 400 });
      }
    }

    if (!filePath || (!filePath.startsWith("/") && !isWindowsAbsolutePath(filePath))) {
      return NextResponse.json({ error: "path must be an absolute path", code: "path_must_be_absolute" }, { status: 400 });
    }
    if (!isFilePathAllowed(filePath, allowedRoots) || !isExistingFilePathAllowed(filePath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }

    // Doc 16 route 10: in Rust mode the host owns single-file diff previews
    // (read-only parity frozen by lib/git-parity.test.mjs); the Node path
    // exists only for the explicit OMPWEB_BACKEND=node rollback.
    if (rustBackendActive()) {
      try {
        return NextResponse.json(await hostClient.git.diff([...allowedRoots], cwd, filePath));
      } catch (error) {
        // Non-repo workspaces are common and legitimate; a file diff is
        // simply unavailable, mirroring the Node path's { supported: false }.
        if (isNonRepositoryError(error)) {
          return NextResponse.json({ supported: false });
        }
        recordBackendError("git_diff_failed", error instanceof Error ? error.message : String(error));
        const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "git_diff_failed";
        return NextResponse.json({ error: error instanceof Error ? error.message : String(error), code }, { status: 500 });
      }
    }

    return NextResponse.json(await getGitFileDiff(cwd, filePath));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
