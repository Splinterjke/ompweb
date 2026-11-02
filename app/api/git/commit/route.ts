import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { recordBackendError } from "@/lib/backend-errors";
import { isNonRepositoryError } from "@/lib/git-nonrepo";
import { commitGitChanges } from "@/lib/git-changes";
import { invalidateGitReadCache } from "@/lib/git-cache";


export async function POST(request: Request) {
  try {
    const body = await request.json() as { cwd?: unknown; message?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!cwd) return Response.json({ error: "cwd is required", code: "cwd_required" }, { status: 400 });
    if (!message) return Response.json({ error: "Commit message is required", code: "commit_message_required" }, { status: 400 });
    if (message.length > 200) return Response.json({ error: "Commit message is too long", code: "commit_message_too_long" }, { status: 400 });
    const roots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, roots)) return Response.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    try {
      invalidateGitReadCache();
      const result = await commitGitChanges(cwd, message);
      return Response.json({ success: true, ...result });
    } catch (error) {
      // Non-repo is a normal situation, not a backend failure.
      if (!isNonRepositoryError(error)) {
        recordBackendError("git_commit_failed", error instanceof Error ? error.message : String(error));
      }
      const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "git_commit_failed";
      return Response.json({ error: error instanceof Error ? error.message : String(error), code }, { status: 400 });
    }
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error), code: "git_commit_failed" }, { status: 400 });
  }
}
