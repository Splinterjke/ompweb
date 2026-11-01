import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { recordBackendError } from "@/lib/backend-errors";
import { isNonRepositoryError } from "@/lib/git-nonrepo";
import { hostClient, rustBackendActive } from "@/lib/omp/host-client";
import { listGitBranches } from "@/lib/git-changes";

export async function GET(request: Request) {
  try {
    const cwd = new URL(request.url).searchParams.get("cwd")?.trim() ?? "";
    const roots = await getAllowedFileRoots();
    if (!cwd || !isExistingFilePathAllowed(cwd, roots)) return Response.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    // Doc 16 route 10: in Rust mode the host owns git — branch listing runs
    // there; the Node implementation exists only for OMPWEB_BACKEND=node.
    if (rustBackendActive()) {
      try {
        return Response.json({ branches: await hostClient.git.branches([...roots], cwd) });
      } catch (error) {
        // Non-repo is a normal situation (empty branch list), not a failure.
        if (!isNonRepositoryError(error)) {
          recordBackendError("git_branches_failed", error instanceof Error ? error.message : String(error));
        }
        const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "git_branches_failed";
        return Response.json({ error: error instanceof Error ? error.message : String(error), code }, { status: 400 });
      }
    }
    return Response.json({ branches: await listGitBranches(cwd) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error), code: "git_branches_failed" }, { status: 400 });
  }
}