import { NextResponse } from "next/server";
import { scanSessionInfo, setSessionTitle } from "@/lib/omp/session-files";
import { deriveSessionTitleFromFirstMessage, sanitizeSessionTitle } from "@/lib/session-title";
import { getRpcSession, notifyRunningChange, resolveSpawnCwdResult, startRpcSession, WebRpcError } from "@/lib/rpc-manager";
import { invalidateSessionListCache, readSessionHeader } from "@/lib/session-reader";
import { resolveSessionPathOr404 } from "@/lib/api-utils";

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
      const resolved = await resolveSessionPathOr404(id);
      if ("response" in resolved) return resolved.response;
      try {
        const header = readSessionHeader(resolved.filePath);
        const { cwd } = resolveSpawnCwdResult(header?.cwd);
        rpc = (await startRpcSession(id, resolved.filePath, cwd, undefined, undefined, header?.cwd)).session;
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

    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return resolved.response;
    const filePath = resolved.filePath;

    // Path resolution yielded; Edit may have taken over this session while the
    // generator ran or the list cache aged. Never fall back to a title write —
    // or a stale-title answer — while Edit owns the history.
    if (getRpcSession(id)?.isEditingHistory?.()) {
      return NextResponse.json({ error: "Wait for the history edit to finish", code: "session_busy" }, { status: 409 });
    }

    const info = scanSessionInfo(filePath, false);
    const storedTitle = sanitizeSessionTitle(info?.title);
    if (storedTitle) {
      // A previous generate may have raced omp's title-slot write and left
      // the (30s) list cache holding the OLD title. Clear it and re-signal
      // every sidebar so the list converges on this title now.
      invalidateSessionListCache();
      notifyRunningChange({ refreshSessionList: true });
      return NextResponse.json({ title: storedTitle, generated: false, usage: null });
    }

    const derived = deriveSessionTitleFromFirstMessage(info?.firstMessage);
    if (!derived) {
      return NextResponse.json(
        { error: "The session has no user messages to name", code: "session_no_messages_to_name" },
        { status: 409 },
      );
    }

    // A live process owns the file; save through it so its next flush keeps the
    // title instead of clobbering ours.
    let saved = false;
    if (rpc?.isAlive?.()) {
      try {
        await rpc.send({ type: "set_session_name", name: derived });
        saved = true;
      } catch {
        // Fall back to the on-disk title slot.
      }
    }
    if (!saved) setSessionTitle(filePath, derived, "auto");
    invalidateSessionListCache();
    return NextResponse.json({ title: derived, generated: false, usage: null });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
