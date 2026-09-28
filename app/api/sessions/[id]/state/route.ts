import { NextResponse } from "next/server";
import { clearExitedRpcSession, getExitedRpcSession, getRpcSession } from "@/lib/rpc-manager";
import { apiErrorResponse, resolveSessionPathOr404 } from "@/lib/api-utils";
import { isExternallyActive, heldSessionsWithPendingTurn, EXTERNAL_ACTIVITY_WINDOW_MS } from "@/lib/session-watcher";

// An external omp goes quiet while the model is thinking or a long tool runs
// (no session-file writes). The window must outlast typical thinking gaps or
// the client's reclaim poller drops the running state mid-run; the trade-off
// is a genuinely finished run stays "running" until the window lapses.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    // A live web-owned process is the authority for this session: its own
    // writes to the session file (the just-finished turn) must never make
    // the route report the session as externally running, so trust the RPC
    // state here. The file-activity branch below covers sessions with no
    // live RPC — terminal `omp` and the post-restart case.
    //
    // One exception: an IDLE web process sharing the session file with
    // another live omp process (a terminal run, or a child that outlived an
    // ompweb restart) is not the turn's authority — the external process is
    // driving the turn. Report external so the client shows the running UI
    // and follows the transcript from the file instead of an idle Send
    // button. A busy RPC keeps authority: it is the run the user is
    // watching.
    const rpc = getRpcSession(id);
    if (rpc?.isAlive()) {
      try {
        const state = await rpc.send({ type: "get_state" }) as { isPromptRunning?: boolean; isStreaming?: boolean; isBashRunning?: boolean; isCompacting?: boolean } | undefined;
        const idle = !state?.isStreaming && !state?.isPromptRunning && !state?.isBashRunning && !state?.isCompacting;
        if (idle) {
          const externallyHeld = heldSessionsWithPendingTurn().includes(id);
          return NextResponse.json(externallyHeld
            ? { running: true, external: true, state: null }
            : { running: true, external: false, state });
        }
        return NextResponse.json({ running: true, state });
      } catch {
        // RPC unavailable (e.g. the external CLI took over the session) —
        // fall through to file-based mode below.
      }
    }
    // A failed web-side spawn (the session file is owned by another omp
    // process — an orphaned child from before a restart, a terminal run — so
    // `--resume` fails with "already in use") leaves a crash record. The
    // session is not dead in that case: the external writer keeps appending.
    // Recent file activity or a live holder with a turn in flight (long
    // thinking/tool gaps outlive the activity window) wins over the stale
    // exit so the client shows the external-running UI instead of a false
    // "process exited" state; the record is dropped so the sidebar badge and
    // later fetches agree.
    const exited = getExitedRpcSession(id);
    if (exited) {
      const externallyActive =
        (await isExternallyActive(id, EXTERNAL_ACTIVITY_WINDOW_MS)) ||
        heldSessionsWithPendingTurn().includes(id);
      if (externallyActive) {
        clearExitedRpcSession(id);
        return NextResponse.json({ running: true, external: true, state: null });
      }
      return NextResponse.json({ running: false, exited });
    }

    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return resolved.response;
    // File activity alone lapses after EXTERNAL_ACTIVITY_WINDOW_MS of silence,
    // but a live external holder goes quiet while the model thinks or a long
    // tool runs. The holder's committed tail (heldTurnInFlight) is the
    // authority for that case — same union the running-events stream uses,
    // so the badge and the state route never disagree.
    const externallyActive =
      (await isExternallyActive(id, EXTERNAL_ACTIVITY_WINDOW_MS)) ||
      heldSessionsWithPendingTurn().includes(id);
    return NextResponse.json({
      running: externallyActive,
      external: externallyActive,
      state: null,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
