import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { recordBackendError } from "@/lib/backend-errors";
import { isNonRepositoryError } from "@/lib/git-nonrepo";
import { hostClient, rustBackendActive } from "@/lib/omp/host-client";
import { checkoutGitBranch } from "@/lib/git-changes";
import { invalidateGitReadCache } from "@/lib/git-cache";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { cwd?: unknown; branch?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    const branch = typeof body.branch === "string" ? body.branch.trim() : "";
    const roots = await getAllowedFileRoots();
    if (!cwd || !isExistingFilePathAllowed(cwd, roots)) return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    if (!branch) return NextResponse.json({ error: "branch is required", code: "branch_required" }, { status: 400 });
    // Doc 16 route 10: checkout runs on the host in Rust mode; the Node
    // implementation exists only for OMPWEB_BACKEND=node.
    if (rustBackendActive()) {
      try {
        invalidateGitReadCache();
        return NextResponse.json({ success: true, ...(await hostClient.git.checkout([...roots], cwd, branch)) });
      } catch (error) {
        // Non-repo is a normal situation, not a backend failure.
        if (!isNonRepositoryError(error)) {
          recordBackendError("git_checkout_failed", error instanceof Error ? error.message : String(error));
        }
        const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "git_checkout_failed";
        return NextResponse.json({ error: error instanceof Error ? error.message : String(error), code }, { status: 400 });
      }
    }
    invalidateGitReadCache();
    return NextResponse.json({ success: true, ...(await checkoutGitBranch(cwd, branch)) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error), code: "git_checkout_failed" }, { status: 400 });
  }
}