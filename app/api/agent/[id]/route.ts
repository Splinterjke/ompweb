import { resolveSessionHostOr404 } from "@/lib/api-utils";
import { getRpcSession, getExitedRpcSession, WebRpcError } from "@/lib/rpc-manager";
import { commandErrorResponse, runAgentCommand } from "@/lib/agent-command";
import { LOCAL_HOST_ID } from "@/lib/hosts/registry";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { MAX_AGENT_COMMAND_REQUEST_BYTES } from "@/lib/image-attachments";
import { getSessionAdvisorEnabled, setSessionAdvisorEnabled } from "@/lib/session-preferences";
import { isExternallyActive, heldSessionsWithPendingTurn, EXTERNAL_ACTIVITY_WINDOW_MS } from "@/lib/session-watcher";

/** Stamp when the handler had the request and when it answered, so the browser
 * can split network time from server time. */
function timed(receivedAt: number, res: Response): Response {
  res.headers.set("x-omp-received-at", String(receivedAt));
  res.headers.set("x-omp-replied-at", String(Date.now()));
  return res;
}

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // Once the body is in, as a socket's ack is stamped after its whole frame: proxies stream uploads through, so the
  // handler starts before a large body has arrived. A body that fails to read is stamped when it failed.
  let receivedAt: number | undefined;

  try {
    const body = await parseJsonWithinLimit<unknown>(req, MAX_AGENT_COMMAND_REQUEST_BYTES);
    receivedAt = Date.now();
    // The explicit query updates the durable per-session advisor choice;
    // requests without it reuse the choice set by ompweb or external surfaces.
    // It rides the query string (never the RPC body, which is forwarded to omp
    // verbatim) and only matters when this request spawns or replaces the
    // session's omp process.
    const advisorParam = new URL(req.url).searchParams.get("advisor");
    if (advisorParam === "1" || advisorParam === "0")
      setSessionAdvisorEnabled(id, advisorParam === "1");
    const advisor = getSessionAdvisorEnabled(id);
    return timed(receivedAt, await runAgentCommand(id, body, advisor));
  } catch (error) {
    return timed(receivedAt ?? Date.now(), commandErrorResponse(error));
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const session = getRpcSession(id);
    if (session?.isAlive()) {
      try {
        const state = await session.send({ type: "get_state" }) as { isPromptRunning?: boolean; isStreaming?: boolean; isBashRunning?: boolean; isCompacting?: boolean } | undefined;
        // Idle web process + another live omp holding the same session file
        // (terminal run / survivor of a restart): the external process drives
        // the turn, so report it as externally running. Mirrors /state.
        const idle = !state?.isStreaming && !state?.isPromptRunning && !state?.isBashRunning && !state?.isCompacting;
        if (idle && heldSessionsWithPendingTurn().includes(id)) {
          return Response.json({ running: true, external: true, state: null });
        }
        return Response.json({ running: true, ...(idle ? { external: false } : {}), state });
      } catch (error) {
        // A wedged child is recycled by the wrapper. Treat state inspection as
        // recoverably idle so browser reconciliation can unlock the composer.
        if (error instanceof WebRpcError && error.code === "session_unresponsive") {
          return Response.json({ running: false, recovered: true });
        }
        throw error;
      }
    }
    // Not managed by this server. A session written by an external omp (a
    // terminal run, or one whose child outlived a server restart) must still
    // be reported as running: the client's reconcile poll treats "no registry
    // session + not running" as the run having ended, which would drop a live
    // external run from the UI. Mirror the /state route's detection.
    const exited = getExitedRpcSession(id);
    if (exited) {
      const externallyActive =
        (await isExternallyActive(id, EXTERNAL_ACTIVITY_WINDOW_MS)) ||
        heldSessionsWithPendingTurn().includes(id);
      if (externallyActive) return Response.json({ running: true, external: true, state: null });
      return Response.json({ running: false, exited });
    }
    const resolved = await resolveSessionHostOr404(id);
    if ("response" in resolved) return Response.json({ running: false });
    // The watcher below sees this machine's files only: an omp on another host
    // is invisible here, so a remote session can never look externally held.
    if (resolved.host?.id !== LOCAL_HOST_ID) return Response.json({ running: false, external: false, state: null });
    // Same detection as /state: a live external holder (long thinking/tool
    // gap) keeps the session running even after the activity window lapses.
    const externallyActive =
      (await isExternallyActive(id, EXTERNAL_ACTIVITY_WINDOW_MS)) ||
      heldSessionsWithPendingTurn().includes(id);
    return Response.json({
      running: externallyActive,
      external: externallyActive,
      state: null,
    });
  } catch (error) {
    return commandErrorResponse(error);
  }
}
