import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isPathWithinRootsAllowingMissing, isWindowsAbsolutePath } from "@/lib/file-access";
import { getGitFileDiff } from "@/lib/git-changes";
import { getCommitFileDiff, getGitRefDiff } from "@/lib/git-log";

import { recordBackendError } from "@/lib/backend-errors";
import { isNonRepositoryError } from "@/lib/git-nonrepo";
import { hostClient, rustBackendActive } from "@/lib/omp/host-client";

// Three diff modes:
//   working tree  — cwd + path (absolute file path), the legacy contract
//   commit file   — cwd + hash + file (repo-relative path), per-file diff of
//                   one commit against its first parent (git-graph modal)
//   ref compare   — cwd + from + to + file, per-file diff between two refs;
//                   `to = "*"` compares against the working tree (embedded
//                   Git Graph view-diff actions)
// The commit-file and ref-compare modes always run the local git binary: the
// Rust host facade (doc 16 route 10) exposes only working-tree diffs.

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const cwd = searchParams.get("cwd")?.trim() ?? "";
    const commitHash = searchParams.get("hash")?.trim() ?? "";
    const filePath = searchParams.get("path")?.trim() ?? "";
    const commitFile = searchParams.get("file")?.trim() ?? "";
    const isCommitMode = commitHash.length > 0 || commitFile.length > 0;
    const compareFrom = searchParams.get("from")?.trim() ?? "";
    const compareTo = searchParams.get("to")?.trim() ?? "";
    // `contents=1` adds both file versions to the response so the client can
    // expand hidden context. Contents always come from the local git binary
    // (the Rust host exposes only the default working-tree diff), so a
    // contents request bypasses the host branch below.
    const wantContents = searchParams.get("contents") === "1";

    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return Response.json({ error: "cwd must be an absolute path", code: "cwd_must_be_absolute" }, { status: 400 });
    }
    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots) || !isExistingFilePathAllowed(cwd, allowedRoots)) {
      return Response.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }

    if (compareFrom && compareTo) {
      if (!commitFile) {
        return Response.json({ error: "file is required", code: "missing_file" }, { status: 400 });
      }
      try {
        return Response.json(await getGitRefDiff(cwd, compareFrom, compareTo, commitFile, wantContents));
      } catch (error) {
        if (isNonRepositoryError(error)) {
          return Response.json({ supported: false });
        }
        recordBackendError("git_diff_failed", error instanceof Error ? error.message : String(error));
        return Response.json({ error: error instanceof Error ? error.message : String(error), code: "git_diff_failed" }, { status: 400 });
      }
    }

    if (isCommitMode) {
      if (!commitHash || !/^[0-9a-f]{7,40}$/.test(commitHash)) {
        return Response.json({ error: "hash must be a 7-40 char hex commit id", code: "invalid_hash" }, { status: 400 });
      }
      if (!commitFile) {
        return Response.json({ error: "file is required", code: "missing_file" }, { status: 400 });
      }
      try {
        return Response.json(await getCommitFileDiff(cwd, commitHash, commitFile, wantContents));
      } catch (error) {
        // A non-repo is a normal situation, not a backend failure: the
        // commit-file diff simply cannot be computed.
        if (isNonRepositoryError(error)) {
          return Response.json({ supported: false });
        }
        recordBackendError("git_diff_failed", error instanceof Error ? error.message : String(error));
        return Response.json({ error: error instanceof Error ? error.message : String(error), code: "git_diff_failed" }, { status: 400 });
      }
    }

    if (!filePath || (!filePath.startsWith("/") && !isWindowsAbsolutePath(filePath))) {
      return Response.json({ error: "path must be an absolute path", code: "path_must_be_absolute" }, { status: 400 });
    }
    // Working-tree diffs read git objects, not the file — a DELETED file is a
    // legitimate diff subject, so containment falls back to its existing
    // ancestor instead of requiring the leaf itself to exist.
    if (!isFilePathAllowed(filePath, allowedRoots) || !isPathWithinRootsAllowingMissing(filePath, allowedRoots)) {
      return Response.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }

    // Doc 16 route 10: in Rust mode the host owns single-file diff previews
    // (read-only parity frozen by lib/git-parity.test.mjs); the Node path
    // exists only for the explicit OMPWEB_BACKEND=node rollback — and for
    // contents-enabled diffs, which the host cannot serve.
    if (rustBackendActive() && !wantContents) {
      try {
        return Response.json(await hostClient.git.diff([...allowedRoots], cwd, filePath));
      } catch (error) {
        // Non-repo workspaces are common and legitimate; a file diff is
        // simply unavailable, mirroring the Node path's { supported: false }.
        if (isNonRepositoryError(error)) {
          return Response.json({ supported: false });
        }
        recordBackendError("git_diff_failed", error instanceof Error ? error.message : String(error));
        const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "git_diff_failed";
        return Response.json({ error: error instanceof Error ? error.message : String(error), code }, { status: 500 });
      }
    }

    return Response.json(await getGitFileDiff(cwd, filePath, wantContents));

  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
