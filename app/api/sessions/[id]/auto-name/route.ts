import { NextResponse } from "next/server";
import { deriveSessionTitleFromFirstMessage, sanitizeSessionTitle } from "@/lib/session-title";
import { getRpcSession, notifyRunningChange, startRpcSession, WebRpcError } from "@/lib/rpc-manager";
import { invalidateHostSessionList, sessionSpawnTarget } from "@/lib/hosts/session-index";
import { HostOpError } from "@/lib/hosts/link-protocol";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";
import { apiErrorResponse, opErrorResponse, resolveSessionHostOr404 } from "@/lib/api-utils";
import { LOCAL_HOST_ID } from "@/lib/hosts/registry";
import { scanSessionInfo } from "@/lib/omp/session-files";

/**
 * POST /api/sessions/[id]/auto-name
 *
 * Generates a title with omp's own title generator (the native `generate_title`
 * command, else argument-less `/rename`) through the session's omp process,
 * starting one when the session is not live. omp persists the title itself.
 * When omp cannot generate one (older omp, a run in flight, spawn failure) the
 * endpoint falls back to the existing title, else a title derived from the
 * first user message, and saves that fallback (through the live process when
 * there is one). `generated` tells the caller which path produced the title.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    // This runs before the path check because omp does not create the session
    // file until the history holds an assistant message.
    let rpc = getRpcSession(id);
    if (!rpc?.isAlive?.()) {
      const resolved = await resolveSessionHostOr404(id);
      if ("response" in resolved) return resolved.response;
      try {
        const target = await sessionSpawnTarget(id, resolved.host);
        if (target) {
          rpc = (await startRpcSession(id, target.sessionFile, target.cwd, undefined, undefined, target.recordedCwd, undefined, resolved.host)).session;
        }
      } catch {
        rpc = undefined; // Fall through to the fallback title.
      }
    }

    if (rpc?.isAlive?.()) {
      let generated: string | undefined;
      try {
        generated = sanitizeSessionTitle((await rpc.generateTitle()) ?? undefined);
      } catch (error) {
        // A busy/restarting session reports a typed error the UI can show; any
        // other failure degrades to the fallback below.
        if (error instanceof WebRpcError) {
          return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
        }
      }
      if (generated) {
        // Targeted (path-scoped) invalidation is a later upstream wave.
        invalidateSessionListCache();
        // omp persisted the title on its own machine: drop that host's cached
        // list on main so the sidebar shows the new name now.
        invalidateHostSessionList(rpc.host.id);
        return NextResponse.json({ title: generated, generated: true, usage: null });
      }
      // generateTitle declined because a run is in flight (`/rename` is a
      // prompt, omp cannot run it beside a turn). Say so — falling through to
      // the stored title would show the misleading "generator returned
      // nothing" toast for what is only a timing problem.
      if (rpc.isRunning()) {
        return NextResponse.json(
          { error: "Wait for the current run to finish", code: "session_busy" },
          { status: 409 },
        );
      }
    }

    const resolved = await resolveSessionHostOr404(id);
    if ("response" in resolved) return resolved.response;
    const { sessionOps } = resolved.host;

    // Path resolution yielded; Edit may have taken over this session while the
    // generator ran or the list cache aged. Never fall back to a title write —
    // or a stale-title answer — while Edit owns the history.
    if (getRpcSession(id)?.isEditingHistory?.()) {
      return NextResponse.json({ error: "Wait for the history edit to finish", code: "session_busy" }, { status: 409 });
    }

    // This machine's scan reads the file itself: the 30s session-list cache can
    // still hold the OLD title right after a generate, exactly the stale answer
    // this endpoint must never give. A remote session has no file here, so that
    // host's list stands in for the scan.
    let storedTitle: string | undefined;
    let firstMessage: string | undefined;
    if (resolved.host?.id === LOCAL_HOST_ID) {
      const filePath = await resolveSessionPath(id);
      const scanned = filePath ? scanSessionInfo(filePath, false) : undefined;
      storedTitle = sanitizeSessionTitle(scanned?.title);
      firstMessage = scanned?.firstMessage;
    } else {
      const listed = (await sessionOps.listSessions()).find((session) => session.id === id);
      storedTitle = sanitizeSessionTitle(listed?.name);
      firstMessage = listed?.firstMessage;
    }
    if (storedTitle) {
      // A previous generate may have raced omp's title-slot write and left
      // the (30s) list cache holding the OLD title. Clear it and re-signal
      // every sidebar so the list converges on this title now.
      invalidateSessionListCache();
      notifyRunningChange({ refreshSessionList: true });
      return NextResponse.json({ title: storedTitle, generated: false, usage: null });
    }

    const derived = deriveSessionTitleFromFirstMessage(firstMessage);
    if (!derived) {
      return NextResponse.json(
        { error: "The session has no user messages to name", code: "session_no_messages_to_name" },
        { status: 409 },
      );
    }

    // Title generation/title scan yielded; Edit may now own this session.
    if (getRpcSession(id)?.isEditingHistory?.()) {
      return NextResponse.json({ error: "Wait for the history edit to finish", code: "session_busy" }, { status: 409 });
    }

    // A live process owns the file; save through it so its next flush keeps the
    // title instead of clobbering ours. The file is only written when no live
    // process accepted the title.
    let saved = false;
    if (rpc?.isAlive?.()) {
      try {
        await rpc.send({ type: "set_session_name", name: derived });
        saved = true;
      } catch {
        // Fall back to the on-disk title slot.
      }
    }
    if (!saved) {
      // Write the title slot through the host that owns the file; the facade
      // drops this machine's caches for a local file.
      const renamed = await sessionOps.renameSessionFile(id, derived, "auto");
      if (!renamed.ok) return opErrorResponse(renamed);
    }
    invalidateSessionListCache();
    // A linked host's list is cached on main; its title just changed there.
    invalidateHostSessionList(resolved.host.id);
    return NextResponse.json({ title: derived, generated: false, usage: null });
  } catch (error) {
    if (error instanceof HostOpError) return apiErrorResponse(error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
