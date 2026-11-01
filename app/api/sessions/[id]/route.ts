import { NextResponse } from "next/server";
import { closeSync, openSync, readFileSync, readdirSync, readSync, statSync } from "fs";
import * as fsRuntime from "fs";
import { dirname, join } from "path";
import {
  deleteSessionFileWithArtifacts,
  MAX_SESSION_LOAD_BYTES,
  parseTitleSlotLine,
  setSessionTitle,
  writeSessionFileAtomicSync,
} from "@/lib/omp/session-files";
import {
  buildSessionContext,
  invalidateSessionListCache,
  invalidateSessionPathCache,
  readSessionHeader,
  resolveParentSessionId,
  resolveSessionIdByPath,
  resolveSessionPath,
} from "@/lib/session-reader";
import { apiErrorResponse, hostOfflineResponse, opErrorResponse, resolveSessionHostOr404 } from "@/lib/api-utils";
import { recordBackendError } from "@/lib/backend-errors";
import { sessionPathKey } from "@/lib/paths";
import { hostClient, rustBackendActive } from "@/lib/omp/host-client";
import { getAgentDir } from "@/lib/omp/paths";
import { HostOpError } from "@/lib/hosts/link-protocol";
import { LOCAL_HOST_ID } from "@/lib/hosts/registry";
import { getHost } from "@/lib/hosts/hub";
import { hostForSessionId, invalidateHostSessionList } from "@/lib/hosts/session-index";
import { RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { clearExitedRpcSession, getLiveRpcSessionIds, getRpcSession, WebRpcError } from "@/lib/rpc-manager";

/** Rethrow a Rust-domain failure as a structured error, preserving the source
 * code (e.g. `runtime_unavailable`) when present. Phase 1 "No Hidden
 * Fallback": in Rust mode the host is the session-domain authority — a failed
 * mutation is an error response, never a silent Node-authority write. */
function rustAuthorityError(kind: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const sourceCode = (error as { code?: unknown } | null)?.code;
  return Object.assign(new Error(`Rust session service unavailable: ${message}`), {
    code: typeof sourceCode === "string" ? sourceCode : kind,
  });
}

/** Stable, client-safe error body for the catch-all handlers: a WebRpcError
 *  fence (e.g. a live history edit holding the session) keeps its 409; every
 *  other error goes through the generic stable-body mapper. */
function sessionsErrorResponse(error: unknown): NextResponse {
  if (error instanceof WebRpcError && error.code === "session_busy") {
    return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
  }
  if (error instanceof RequestBodyTooLargeError) {
    return NextResponse.json({ error: "Request body is too large", code: "request_too_large" }, { status: 413 });
  }
  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  // A host link failure keeps its status: 503 offline, 504 timeout.
  if (error instanceof HostOpError) return apiErrorResponse(error);
  console.error("[api/sessions]", error);
  // Every other typed error keeps its own stable code through the generic
  // mapper (e.g. the Rust session service's `runtime_unavailable`), so clients
  // branch on the failure class instead of parsing the message.
  return apiErrorResponse(error);
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const resolved = await resolveSessionHostOr404(id);
    if ("response" in resolved) return resolved.response;

    const searchParams = new URL(req.url).searchParams;
    const includeState = searchParams.has("includeState");
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = searchParams.has("deferMedia");
    const read = await resolved.host.sessionOps.readSession(id, { deferThinking, deferMedia: deferToolResultImages });
    if (!read.ok) {
      // omp does not create the session file until the first assistant message
      // commits, so a live web-owned session (e.g. its first turn still running)
      // can have no file yet — on a linked host, none there. A live wrapper
      // proves the session exists — answer with an empty transcript instead of a
      // 404 so the client can attach its event stream and show the running
      // state; a 404 would leave the UI frozen (no running indicator, no
      // streaming) until a manual refresh.
      const live = getRpcSession(id);
      if (read.code === "session_not_found" && live?.isAlive() && live.host === resolved.host) {
        const now = new Date().toISOString();
        let agent: { running: boolean; state?: unknown } | undefined;
        if (includeState) {
          try {
            agent = { running: true, state: await live.send({ type: "get_state" }) };
          } catch {
            // Leave agent unset; the session payload is still valid without it.
          }
        }
        return NextResponse.json({
          sessionId: id,
          filePath: "",
          info: {
            path: "",
            id,
            cwd: live.cwd,
            created: now,
            modified: now,
            messageCount: 0,
            firstMessage: "(no messages)",
          },
          leafId: null,
          tree: [],
          context: buildSessionContext([], null, { deferThinking, deferToolResultImages }),
          ...(agent ? { agent } : {}),
        });
      }
      return opErrorResponse(read);
    }

    // ?includeState=1 inlines the wrapper's live agent state (same shape as
    // GET /api/agent/[id]) so the client's post-turn refresh is one request
    // instead of two. On a get_state failure the field is omitted entirely —
    // callers treat a missing `agent` as "fetch it separately".
    let agent: { running: boolean; state?: unknown } | undefined;
    if (includeState) {
      const rpc = getRpcSession(id);
      if (rpc?.isAlive()) {
        try {
          agent = { running: true, state: await rpc.send({ type: "get_state" }) };
        } catch {
          // Leave agent unset; the session payload is still valid without it.
        }
      } else {
        agent = { running: false };
      }
    }

    return NextResponse.json({
      sessionId: id,
      ...read.value,
      ...(agent ? { agent } : {}),
    });
  } catch (error) {
    return sessionsErrorResponse(error);
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const { name } = await req.json() as { name?: string };
    if (typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "name is required", code: "session_name_required" }, { status: 400 });
    }
    // Update the in-memory title in the live omp process so the next file
    // flush cannot clobber the on-disk rename. omp does not create the session
    // file until the history holds an assistant message, so the in-memory update
    // may be the only place the title exists for a moment.
    const rpc = getRpcSession(id);
    let rpcRenamed = false;
    if (rpc?.isAlive?.() && typeof rpc.send === "function") {
      try {
        await rpc.send({ type: "set_session_name", name: name.trim() });
        rpcRenamed = true;
      } catch (error) {
        if (error instanceof WebRpcError && error.code === "session_busy") throw error;
        console.warn("[ompweb] set_session_name RPC failed:", error instanceof Error ? error.message : error);
      }
    }
    // Also write the title to disk (when the file exists) so the sidebar list
    // reflects the rename immediately instead of waiting for the next flush.
    let diskWritten = false;
    // This machine's cached path lookup first; only when there is no local file
    // do we ask the linked hosts. A session on another host has no file here.
    const filePath = await resolveSessionPath(id);
    const host = filePath ? getHost(LOCAL_HOST_ID) : await hostForSessionId(id);
    // Resolution awaited: an Edit may have started on the current wrapper
    // since the failed native rename. Never bypass its fence with a file write.
    if (getRpcSession(id)?.isEditingHistory?.()) {
      throw new WebRpcError("Wait for the history edit to finish", "session_busy");
    }
    if (host && host.id !== LOCAL_HOST_ID) {
      // The title slot lives on the owning host: write it through the facade.
      const result = await host.sessionOps.renameSessionFile(id, name.trim());
      if (!result.ok) return opErrorResponse(result);
      diskWritten = true;
    } else if (filePath) {
      if (rustBackendActive()) {
        try {
          await hostClient.sessions.rename(join(getAgentDir(), "sessions"), filePath, name.trim());
          diskWritten = true;
        } catch (error) {
          recordBackendError("session_rename_failed", `Rust session.rename failed: ${error instanceof Error ? error.message : String(error)}`);
          throw rustAuthorityError("session_rename_failed", error);
        }
      } else {
        diskWritten = setSessionTitle(filePath, name.trim(), "user");
      }
    }
    if (!rpcRenamed && !diskWritten) {
      return NextResponse.json({ error: "Session not found", code: "session_not_found" }, { status: 404 });
    }
    invalidateSessionListCache();
    // A linked host caches its own list on main; its title just changed there.
    if (host) invalidateHostSessionList(host.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return sessionsErrorResponse(error);
  }
}

// DELETE /api/sessions/[id]
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const resolved = await resolveSessionHostOr404(id);
    if ("response" in resolved) return resolved.response;
    // A session on another host is re-parented and deleted there (the host
    // facade call below). This machine's files keep the local cascade: in Rust
    // mode the session service owns the delete, and children have to be
    // re-attached before the file goes away.
    let filePath = "";
    const skippedChildren: Array<{ id: string; reason: string }> = [];
    if (resolved.host?.id === LOCAL_HOST_ID) {
      const localPath = await resolveSessionPath(id);
      if (!localPath) {
        return NextResponse.json({ error: "Session not found", code: "session_not_found" }, { status: 404 });
      }
      filePath = localPath;

      // Read only the bounded header before deleting.
      const deletedHeader = readSessionHeader(filePath);
      const deletedSessionId = deletedHeader?.id ?? id;
      const parentSession = deletedHeader?.parentSession;

      // Children reference their parent either by file path or by bare session id
      // (see resolveParentSessionId), so the grandparent has to be written back in
      // whichever form each child used. Resolve both forms up front.
      let grandparentPath: string | undefined;
      let grandparentId: string | undefined;
      if (parentSession) {
        const idForPath = await resolveSessionIdByPath(parentSession);
        if (idForPath) {
          grandparentPath = parentSession;
          grandparentId = idForPath;
        } else {
          const pathForId = await resolveSessionPath(parentSession);
          if (pathForId) {
            grandparentPath = pathForId;
            grandparentId = parentSession;
          }
        }
      }

      // Re-attach all direct children to this session's parent (cascade re-parent)
      // Scan sibling files in the same directory
      const targetPathKey = sessionPathKey(filePath);
      const dir = dirname(filePath);
      try {
        const readDirectorySync = Reflect.get(fsRuntime, "readdirSync") as typeof readdirSync;
        const files = readDirectorySync(dir).filter(
          (file) => file.endsWith(".jsonl") && sessionPathKey(join(dir, file)) !== targetPathKey,
        );
        for (const file of files) {
          const childPath = join(dir, file);

          // Re-parenting rewrites the whole child file; a child at/above the
          // load ceiling would cause a huge allocation (RangeError) during the
          // read and a full-file rewrite. Skip it like a live session.
          try {
            if (statSync(childPath).size > MAX_SESSION_LOAD_BYTES) {
              // Report the real session id when the header is readable without
              // loading the whole file (bounded 64KB prefix read).
              let oversizedId = file;
              try {
                const fd = openSync(childPath, "r");
                try {
                  const head = Buffer.alloc(64 * 1024);
                  const bytes = readSync(fd, head, 0, head.length, 0);
                  const lines = head.toString("utf8", 0, bytes).split("\n");
                  const headerIndex = parseTitleSlotLine(lines[0] ?? "") ? 1 : 0;
                  const parsed = JSON.parse(lines[headerIndex] ?? "{}") as { id?: unknown };
                  if (typeof parsed.id === "string") oversizedId = parsed.id;
                } finally {
                  closeSync(fd);
                }
              } catch {
                // Header unreadable — fall back to the basename.
              }
              skippedChildren.push({ id: oversizedId, reason: "session_child_too_large" });
              continue;
            }
          } catch {
            continue; // vanished between readdir and stat — not a child we can fix
          }
          // Parse phase: an unreadable or non-matching sibling is simply not a
          // child of the deleted session, so it must not be reported as skipped.
          let lines: string[];
          let headerIndex: number;
          let header: { type?: string; id?: string; parentSession?: string };
          let linkedByPath: boolean;
          try {
            lines = readFileSync(childPath, "utf8").split("\n");
            // v3 files carry a fixed-width title slot on line 1; the session
            // header is then line 2. The slot line is left byte-identical.
            headerIndex = parseTitleSlotLine(lines[0] ?? "") ? 1 : 0;
            header = JSON.parse(lines[headerIndex]) as typeof header;
            if (header.type !== "session" || !header.parentSession) continue;
            linkedByPath = sessionPathKey(header.parentSession) === targetPathKey;
            if (!linkedByPath && header.parentSession !== deletedSessionId) continue;
          } catch {
            continue;
          }

          // A live omp process owns its session file and flushes its whole
          // in-memory state on write — our rewrite would be clobbered by (or
          // interleaved with) its next flush.
          const childId = typeof header.id === "string" ? header.id : undefined;
          if (childId && getRpcSession(childId)?.isAlive?.()) {
            skippedChildren.push({ id: childId, reason: "session_child_live" });
            continue;
          }

          // Write the replacement in the same form the child used.
          header.parentSession = linkedByPath
            ? (grandparentPath ?? parentSession)
            : (grandparentId ?? parentSession);
          lines[headerIndex] = JSON.stringify(header);
          try {
            // Atomic: writeFileSync truncates first, so a crash or ENOSPC here
            // would permanently truncate a session the user did NOT delete.
            writeSessionFileAtomicSync(childPath, lines.join("\n"), "reparent");
          } catch {
            skippedChildren.push({ id: childId ?? file, reason: "session_child_rewrite_failed" });
          }
        }
      } catch { /* skip if dir unreadable */ }
    }

    // Await the child's exit before unlinking: omp flushes session state on
    // shutdown and would recreate the file if it were still running.
    // Disposing a child behind a down link would wait for the link to return.
    const offline = hostOfflineResponse(resolved.host);
    if (offline) return offline;
    await getRpcSession(id)?.destroyAndWait?.();
    if (resolved.host?.id === LOCAL_HOST_ID) {
      if (rustBackendActive()) {
        try {
          await hostClient.sessions.delete(join(getAgentDir(), "sessions"), filePath);
        } catch (error) {
          // No Hidden Fallback (Phase 1): the Node file deletion exists only in
          // the explicit OMPWEB_BACKEND=node rollback mode.
          recordBackendError("session_delete_failed", `Rust session.delete failed: ${error instanceof Error ? error.message : String(error)}`);
          throw rustAuthorityError("session_delete_failed", error);
        }
      } else {
        deleteSessionFileWithArtifacts(filePath);
      }
      clearExitedRpcSession(id);
      invalidateSessionPathCache(id);
      invalidateSessionListCache();
      return NextResponse.json({
        ok: true,
        ...(skippedChildren.length > 0 ? { skippedChildren } : {}),
      });
    }

    // Live children are skipped by the re-parent rewrite: their omp process
    // owns the file and would clobber it on its next flush. The host re-parents
    // and deletes on its own machine; main's live child ids travel with the call
    // because the wrappers are registered here.
    const result = await resolved.host.sessionOps.deleteSession(id, getLiveRpcSessionIds());
    if (!result.ok) return opErrorResponse(result);
    invalidateHostSessionList(resolved.host.id);
    clearExitedRpcSession(id);
    return NextResponse.json({ ok: true, ...result.value });
  } catch (error) {
    return sessionsErrorResponse(error);
  }
}
