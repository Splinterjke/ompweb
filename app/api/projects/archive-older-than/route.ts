import { NextResponse } from "next/server";
import {
  ARCHIVE_OLDER_THAN_BUCKET_MS,
  isArchiveOlderThanBucket,
  selectSessionsForBulkArchive,
  type BulkArchiveSkip,
} from "@/lib/archive-older-than";
import { apiErrorResponse } from "@/lib/api-utils";
import { comparableProjectPath } from "@/lib/comparable-path";
import {
  ProjectPathError,
  validateProjectPath,
} from "@/lib/project-registry";
import { archiveSessionFileWithArtifacts } from "@/lib/omp/session-files";
import { clearExitedRpcSession, getRpcSession } from "@/lib/rpc-manager";
import {
  invalidateSessionListCache,
  invalidateSessionPathCache,
  listAllSessions,
} from "@/lib/session-reader";
import { findExternallyHeldSessionIds } from "@/lib/session-watcher";
import { resolveProject } from "@/lib/worktree";

/** POST /api/projects/archive-older-than — body { path, olderThan }.
 * Archives every session of the workspace (worktrees included, they group
 * under the main projectRoot) whose last file activity is older than the
 * selected bucket. Selection, ordering (children before parents) and the
 * skip rules live in `selectSessionsForBulkArchive`; archiving itself uses
 * the same discipline as the single-session route: stop the live child and
 * wait for its final flush before moving the JSONL + artifacts. */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      path?: unknown;
      olderThan?: unknown;
    };
    if (!isArchiveOlderThanBucket(body.olderThan)) {
      return NextResponse.json(
        { error: "Unknown olderThan bucket", code: "invalid_older_than" },
        { status: 400 },
      );
    }
    let normalized: string;
    try {
      normalized = validateProjectPath(typeof body.path === "string" ? body.path : "");
    } catch (error) {
      if (error instanceof ProjectPathError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
      }
      throw error;
    }
    const { projectRoot } = await resolveProject(normalized);

    const sessions = await listAllSessions();
    const { targets, skipped } = selectSessionsForBulkArchive(sessions, {
      projectKey: comparableProjectPath(projectRoot),
      cutoffMs: Date.now() - ARCHIVE_OLDER_THAN_BUCKET_MS[body.olderThan],
      externallyHeld: new Set(findExternallyHeldSessionIds()),
    });

    const archived: string[] = [];
    for (const session of targets) {
      try {
        // OMP owns writes while a child is live; wait for its final flush so
        // the archive contains the complete native transcript.
        await getRpcSession(session.id)?.destroyAndWait?.();
        archiveSessionFileWithArtifacts(session.path);
        clearExitedRpcSession(session.id);
        invalidateSessionPathCache(session.id);
        archived.push(session.id);
      } catch (error) {
        // One unreadable/movable file must not abort the rest of the batch.
        skipped.push({
          id: session.id,
          reason: "error",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (archived.length > 0) invalidateSessionListCache();
    return NextResponse.json({ ok: true, archived, skipped });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
