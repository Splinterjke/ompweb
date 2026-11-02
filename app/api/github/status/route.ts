import { resolveProject } from "@/lib/worktree";
import { resolveGitHubRepo } from "@/lib/git-remote";
import { getRepoStatus } from "@/lib/github";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { getGitStatus } from "@/lib/git-changes";
import { recordBackendError } from "@/lib/backend-errors";
import { isNonRepositoryError } from "@/lib/git-nonrepo";


// Short-TTL cache so the sidebar can poll without hammering GitHub's quota.
const CACHE_TTL_MS = 5 * 60 * 1000;
declare global {
  // eslint-disable-next-line no-var
  var __ompGithubStatusCache: Map<string, { data: unknown; expiresAt: number }> | undefined;
}
function getCache(): Map<string, { data: unknown; expiresAt: number }> {
  if (!globalThis.__ompGithubStatusCache) globalThis.__ompGithubStatusCache = new Map();
  return globalThis.__ompGithubStatusCache;
}

/**
 * GET /api/github/status?cwd=<dir>
 * GitHub identity of the checkout plus open-PR / check-run status.
 * Best effort: non-git or non-GitHub projects return { repo: null } with 200.
 */
export async function GET(req: Request) {
  const cwd = new URL(req.url).searchParams.get("cwd");
  if (!cwd) return Response.json({ error: "Missing cwd", code: "missing_cwd" }, { status: 400 });
  const forceRefresh = new URL(req.url).searchParams.get("refresh") === "1";

  const cacheKey = cwd;
  const cached = getCache().get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return Response.json(cached.data);

  try {
    const project = await resolveProject(cwd);
    // Only checkouts under the file allowlist may be probed (a bare path would
    // otherwise leak repo identity + PR/CI state for arbitrary local dirs).
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(project.projectRoot, allowedRoots)) {
      // Not silently empty: the frontend shows why (allowlist may not have
      // caught up with the session list on cold start).
      return Response.json({ repo: null, pulls: [], reason: "workspace_not_allowed", projectRoot: project.projectRoot });
    }
    const ref = await resolveGitHubRepo(project.projectRoot);
    if (!ref) {
      const data = { repo: null, pulls: [], reason: "not_github" };
      getCache().set(cacheKey, { data, expiresAt: Date.now() + CACHE_TTL_MS });
      return Response.json(data);
    }
    // The local git half runs in Node; the GitHub API half (getRepoStatus)
    // is HTTP over the proxy, not git. A genuine git failure is recorded like
    // on the /api/git/status route (non-repo answers stay benign).
    const gitStatusOrNull = getGitStatus(project.projectRoot).catch((error: unknown) => {
      if (!isNonRepositoryError(error)) recordBackendError("git_status_failed", error instanceof Error ? error.message : String(error));
      throw error;
    });
    const [gitStatus, status] = await Promise.all([gitStatusOrNull, getRepoStatus(ref.owner, ref.repo)]);
    const data = { repo: status, pulls: status.pulls, git: { branch: gitStatus.branch, upstream: gitStatus.upstream, ahead: gitStatus.ahead ?? 0, behind: gitStatus.behind ?? 0, files: gitStatus.files } };
    getCache().set(cacheKey, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    return Response.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub status failed";
    return Response.json({ error: message, code: "github_status_failed" }, { status: 500 });
  }
}
