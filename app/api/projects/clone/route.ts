import { apiErrorResponse, opErrorResponse, resolveWorkspaceHost } from "@/lib/api-utils";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { isRecord } from "@/lib/type-guards";
import type { CloneProgress } from "@/lib/git-clone";
import { recordBackendError } from "@/lib/backend-errors";
import { allowFileRoot } from "@/lib/file-access";
import { loadProjectRegistry, saveProjectRegistry, upsertProject } from "@/lib/project-registry";
import { resolveProject } from "@/lib/worktree";

/**
 * Fork behavior kept on the daemon-routed clone: after a successful LOCAL clone,
 * register the directory the same way POST /api/projects does (resolve the
 * worktree project root, upsert the registry, authorize browsing). Best-effort:
 * the picker's selection flow retries the registration via POST /api/projects.
 * Remote clones are never registered here — the project registry and the file
 * allow-list are this machine's.
 */
async function registerClonedProject(hostLocal: boolean, target: string): Promise<string> {
  if (!hostLocal || !target) return target;
  try {
    const { projectRoot } = await resolveProject(target);
    saveProjectRegistry(upsertProject(loadProjectRegistry(), projectRoot));
    allowFileRoot(projectRoot);
    return projectRoot;
  } catch (error) {
    recordBackendError("git_clone_failed", `Registration failed for ${target}: ${error instanceof Error ? error.message : String(error)}`);
    return target;
  }
}

export async function POST(request: Request, { disableIdleTimeout }: { disableIdleTimeout: () => void }) {
  try {
    const body: unknown = await parseJsonWithinLimit(request, 64 * 1024);
    if (!isRecord(body) || typeof body.id !== "string" || typeof body.parent !== "string" || typeof body.url !== "string") return Response.json({ error: "Invalid clone request", code: "invalid_request" }, { status: 400 });
    const resolved = await resolveWorkspaceHost(body.hostId, null);
    if ("response" in resolved) return resolved.response;
    const { host } = resolved;
    const id = body.id;
    let active = true;
    const cancel = () => { void host.workspaceOps.cancelClone(id).catch(() => {}); };
    const started = await host.workspaceOps.startClone(id, body.parent, body.url.trim());
    if (!started.ok) { request.signal.removeEventListener("abort", cancel); return opErrorResponse(started); }
    request.signal.addEventListener("abort", cancel, { once: true });
    if (request.signal.aborted) cancel();
    let cursor = 0;
    const encoder = new TextEncoder();
    disableIdleTimeout();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          let page: CloneProgress;
          do {
            const result = await host.workspaceOps.readClone(id, cursor);
            if (!active) return;
            if (!result.ok) throw new Error(result.error);
            page = result.value;
          } while (!page.terminal && page.frames.length === 0);
          cursor = page.cursor;
          if (page.reset) controller.enqueue(encoder.encode(`${JSON.stringify({ type: "output", text: "", reset: true })}\n`));
          for (const frame of page.frames) {
            // Fork: a successful local clone registers its directory as a project.
            const type = frame && typeof frame === "object" ? (frame as { type?: unknown }).type : undefined;
            const out = type === "done"
              ? { ...(frame as { type: "done"; path: string }), path: await registerClonedProject(host.id === "local", (frame as { path?: string }).path ?? "") }
              : frame;
            controller.enqueue(encoder.encode(`${JSON.stringify(out)}\n`));
          }
          if (page.terminal) { active = false; request.signal.removeEventListener("abort", cancel); controller.close(); }
        } catch {
          if (!active) return;
          active = false;
          request.signal.removeEventListener("abort", cancel);
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: "error", code: "clone_uncertain", error: "The clone connection was interrupted; its outcome is unknown. Check the destination before retrying." })}\n`));
          controller.close();
        }
      },
      cancel() { active = false; request.signal.removeEventListener("abort", cancel); cancel(); },
    }, { highWaterMark: 0 });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error, error instanceof RequestBodyTooLargeError ? 413 : error instanceof SyntaxError ? 400 : 500);
  }
}

export async function DELETE(request: Request) {
  try {
    const body: unknown = await parseJsonWithinLimit(request, 64 * 1024);
    if (!isRecord(body) || typeof body.id !== "string") return Response.json({ error: "Invalid clone request", code: "invalid_request" }, { status: 400 });
    const resolved = await resolveWorkspaceHost(body.hostId, null);
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.cancelClone(body.id);
    return result.ok ? Response.json({ ok: true, ...result.value }) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error, error instanceof RequestBodyTooLargeError ? 413 : error instanceof SyntaxError ? 400 : 500);
  }
}
