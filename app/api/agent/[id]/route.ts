import { NextResponse } from "next/server";
import { readSessionHeader } from "@/lib/session-reader";
import { apiErrorResponse, resolveSessionPathOr404 } from "@/lib/api-utils";
import { startRpcSession, getRpcSession, getExitedRpcSession, resolveSpawnCwdResult, WebRpcError } from "@/lib/rpc-manager";
import { RpcCommandError } from "@/lib/omp/rpc-process";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { MAX_AGENT_COMMAND_REQUEST_BYTES } from "@/lib/image-attachments";
import { getSessionAdvisorEnabled, setSessionAdvisorEnabled } from "@/lib/session-preferences";
import { isExternallyActive, heldSessionsWithPendingTurn, EXTERNAL_ACTIVITY_WINDOW_MS } from "@/lib/session-watcher";
import { parseSessionStartupBinding } from "@/lib/session-model-check";

// Commands that ride whatever child is alive and never spawn or replace one:
// keystroke predictions (NOTE: stock omp 18.3.x has no predict_word RPC; see
// lib/word-prediction.ts), and the side-question reads/cancel omp-web sends in
// the background (SSE connect, reconcile). Without a live process there is no
// ghost text, no running side question and nothing to cancel, so the reply is
// known without omp. Asking (`btw`) and opening the history start omp first.
const NO_SPAWN_REPLIES: Record<string, unknown> = {
  predict_word: { suffix: null },
  predict_word_feedback: null,
  get_btw_history: { records: [] },
  btw_cancel: { cancelled: false },
  // Goal reads are silent background refreshes (SSE open, reconcile poll).
  // With no live child the session has no web-visible goal: a goal restored
  // from disk surfaces on the first run (the wrapper is then alive for the
  // next refresh). Mutating goal ops must NEVER be here — they would return
  // a fake success without touching any session.
  goal_get: { goal: null },
};

// Live diagnostics of a skill-resolving omp. A saved or exited session has none,
// and resuming a full child (MCP, LSP) just to answer a read-only inspection or
// flip one setting is not what the click asked for: with no live wrapper these
// answer 409 instead of starting omp, and a live idle child is never replaced
// because the advisor flag differs.
const LIVE_SESSION_ONLY = new Set(["get_skill_diagnostics", "set_skill_startup_diagnostics"]);


/** omp-web's own failures carry a stable code the client can localize; omp's
 * errors stay opaque English text. */
function commandErrorResponse(error: unknown) {
  if (error instanceof RequestBodyTooLargeError) {
    return NextResponse.json({ error: "Agent command is too large", code: "request_too_large" }, { status: 413 });
  }
  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  if (error instanceof WebRpcError) {
    return NextResponse.json(
      { error: error.message, code: error.code, ...(error.data !== undefined ? { data: error.data } : {}) },
      { status: 400 },
    );
  }
  if (error instanceof RpcCommandError) {
    return NextResponse.json({ error: error.message, code: error.code ?? "rpc_command_failed" }, { status: 400 });
  }
  return apiErrorResponse(error);
}

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body = await parseJsonWithinLimit<{ type?: unknown; [key: string]: unknown }>(req, MAX_AGENT_COMMAND_REQUEST_BYTES);
    if (typeof body.type !== "string" || !body.type.trim()) {
      return NextResponse.json({ error: "command type is required", code: "command_type_required" }, { status: 400 });
    }

    // The explicit query updates the durable per-session choice; requests
    // without it reuse the choice set by ompweb or external surfaces.
    const advisorParam = new URL(req.url).searchParams.get("advisor");
    if (advisorParam === "1" || advisorParam === "0")
      setSessionAdvisorEnabled(id, advisorParam === "1");
    const advisor = getSessionAdvisorEnabled(id);
    // Optional spawn-time binding ({ modelOverride } rebinds an unrestorable
    // saved model, { forceModelCheck } skips the pre-flight). omp must never
    // see it: it is stripped before the command is forwarded.
    const startup = parseSessionStartupBinding(body.startup);
    const command = { ...body };
    delete command.startup;
    // Fast path: already-running session. --advisor is a spawn-time flag with
    // no runtime RPC, so a toggle that now differs from the live child's spawn
    // flag must replace an idle child to take effect; busy children keep
    // running and pick the flag up at the next natural respawn.
    const existing = getRpcSession(id);
    const noSpawnKey = body.type === "goal"
      ? (body.op === "get" ? "goal_get" : undefined)
      : (Object.hasOwn(NO_SPAWN_REPLIES, body.type) ? body.type : undefined);
    const liveOnly = LIVE_SESSION_ONLY.has(body.type);
    if (existing?.isAlive()) {
      if (noSpawnKey || liveOnly || existing.advisorSpawned === advisor || existing.isRunning()) {
        const result = await existing.send(command);
        return NextResponse.json({ success: true, data: result });
      }
      await existing.destroyAndWait();
    }
    if (noSpawnKey) return NextResponse.json({ success: true, data: NO_SPAWN_REPLIES[noSpawnKey] });
    if (liveOnly) {
      return NextResponse.json(
        { error: "Skill diagnostics require a running session", code: "skill_diagnostics_unavailable" },
        { status: 409 },
      );
    }

    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return resolved.response;
    const filePath = resolved.filePath;

    const header = readSessionHeader(filePath);
    const { cwd } = resolveSpawnCwdResult(header?.cwd);

    const { session } = await startRpcSession(id, filePath, cwd, undefined, advisor, header?.cwd, startup);
    const result = await session.send(command);

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return commandErrorResponse(error);
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
          return NextResponse.json({ running: true, external: true, state: null });
        }
        return NextResponse.json({ running: true, ...(idle ? { external: false } : {}), state });
      } catch (error) {
        // A wedged child is recycled by the wrapper. Treat state inspection as
        // recoverably idle so browser reconciliation can unlock the composer.
        if (error instanceof WebRpcError && error.code === "session_unresponsive") {
          return NextResponse.json({ running: false, recovered: true });
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
      if (externallyActive) return NextResponse.json({ running: true, external: true, state: null });
      return NextResponse.json({ running: false, exited });
    }
    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return NextResponse.json({ running: false });
    // Same detection as /state: a live external holder (long thinking/tool
    // gap) keeps the session running even after the activity window lapses.
    const externallyActive =
      (await isExternallyActive(id, EXTERNAL_ACTIVITY_WINDOW_MS)) ||
      heldSessionsWithPendingTurn().includes(id);
    return NextResponse.json({
      running: externallyActive,
      external: externallyActive,
      state: null,
    });
  } catch (error) {
    return commandErrorResponse(error);
  }
}
