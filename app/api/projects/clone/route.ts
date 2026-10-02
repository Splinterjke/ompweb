import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { recordBackendError } from "@/lib/backend-errors";
import { allowFileRoot } from "@/lib/file-access";
import { cloneDirectoryName } from "@/lib/git-clone";
import { runGitClone } from "@/lib/git-clone-runner";
import {
  loadProjectRegistry,
  ProjectPathError,
  saveProjectRegistry,
  upsertProject,
  validateProjectPath,
} from "@/lib/project-registry";
import { resolveProject } from "@/lib/worktree";

// In-flight clones by client-chosen id, so DELETE can cancel one while its
// POST stream stays open to report the cleanup.
const clones = new Map<string, AbortController>();
const CLONE_ID = /^[A-Za-z0-9-]{1,64}$/;

type CloneFrame =
  | { type: "output"; text: string }
  | { type: "done"; path: string }
  | { type: "cancelled"; path: string }
  | { type: "error"; error: string; code: string };

// POST /api/projects/clone  body: { id, parent, url }
// Clones `url` into `<parent>/<repo name>` and streams NDJSON frames:
// output chunks, then exactly one of done / cancelled / error. The target is
// removed on failure or cancellation (DELETE, or the client disconnecting).
// On success the clone is registered exactly like POST /api/projects does
// (registry upsert + allowFileRoot), so it immediately appears in the project
// list and is browsable.
export async function POST(req: Request) {
  let body: { id?: unknown; parent?: unknown; url?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request", code: "invalid_request" }, { status: 400 });
  }
  const id = typeof body.id === "string" && CLONE_ID.test(body.id) ? body.id : null;
  const url = typeof body.url === "string" ? body.url.trim() : "";
  const name = cloneDirectoryName(url);
  if (!id || clones.has(id)) return NextResponse.json({ error: "Invalid request", code: "invalid_request" }, { status: 400 });
  if (!name) return NextResponse.json({ error: "Enter an https:// or ssh Git URL", code: "invalid_git_url" }, { status: 400 });
  let target: string;
  try {
    target = join(validateProjectPath(typeof body.parent === "string" ? body.parent : ""), name);
  } catch (error) {
    if (error instanceof ProjectPathError) return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    throw error;
  }
  // Registered before any await so a cancel sent while the target is being
  // created is not a 404; runGitClone then skips git and the stream cleans up.
  const controller = new AbortController();
  clones.set(id, controller);
  req.signal.addEventListener("abort", () => controller.abort(), { once: true });
  if (req.signal.aborted) controller.abort();
  // Creating the (empty) target up front makes the existence check atomic, so
  // cleanup only ever removes a directory this request created.
  try {
    await mkdir(target);
  } catch (error) {
    clones.delete(id);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return NextResponse.json({ error: `Already exists: ${target}`, code: "clone_target_exists" }, { status: 409 });
    }
    return apiErrorResponse(error);
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(streamController) {
      const send = (frame: CloneFrame) => {
        try {
          streamController.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        } catch {
          // Client gone; the clone still finishes its cleanup.
        }
      };
      const code = await runGitClone(url, target, controller.signal, (text) => send({ type: "output", text }));
      clones.delete(id);
      if (code === 0 && !controller.signal.aborted) {
        // Register the clone the same way POST /api/projects does: resolve the
        // (worktree) project root, upsert it into the registry, and authorize
        // the root for file browsing. If this fails, the picker's selection
        // flow retries the registration via POST /api/projects.
        let projectRoot: string;
        try {
          ({ projectRoot } = await resolveProject(target));
          const registry = loadProjectRegistry();
          saveProjectRegistry(upsertProject(registry, projectRoot));
          allowFileRoot(projectRoot);
        } catch (error) {
          recordBackendError("git_clone_failed", `Registration failed for ${target}: ${error instanceof Error ? error.message : String(error)}`);
          projectRoot = target;
        }
        send({ type: "done", path: projectRoot });
      } else {
        const removed = await rm(target, { recursive: true, force: true, maxRetries: 5 }).then(() => true, () => false);
        if (!removed) {
          recordBackendError("git_clone_failed", `Could not remove the partial clone at ${target}`);
          send({ type: "error", error: `Could not remove ${target}`, code: "clone_cleanup_failed" });
        } else if (controller.signal.aborted) {
          send({ type: "cancelled", path: target });
        } else if (code === null) {
          recordBackendError("git_clone_failed", "git executable could not be started");
          send({ type: "error", error: "Could not run git — is it installed?", code: "git_not_found" });
        } else {
          recordBackendError("git_clone_failed", `git clone exited with code ${code}`);
          send({ type: "error", error: `git clone exited with code ${code}`, code: "clone_failed" });
        }
      }
      try {
        streamController.close();
      } catch {
        // Already closed by a disconnect.
      }
    },
    cancel() {
      controller.abort();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}

// DELETE /api/projects/clone  body: { id } — cancel an in-flight clone.
export async function DELETE(req: Request) {
  const body = await req.json().catch(() => ({})) as { id?: unknown };
  const controller = typeof body.id === "string" ? clones.get(body.id) : undefined;
  if (!controller) return NextResponse.json({ error: "No clone in progress", code: "clone_not_found" }, { status: 404 });
  controller.abort();
  return NextResponse.json({ ok: true });
}
