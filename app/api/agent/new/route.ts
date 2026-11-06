import { apiErrorResponse, opErrorResponse, resolveHostOrError } from "@/lib/api-utils";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { LOCAL_HOST_ID } from "@/lib/hosts/registry";
import { WebRpcError, startNewRpcSession, type AgentSessionWrapper } from "@/lib/rpc-manager";
import { RpcCommandError } from "@/lib/omp/rpc-process";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { setSessionAdvisorEnabled } from "@/lib/session-preferences";
import { MAX_AGENT_COMMAND_REQUEST_BYTES } from "@/lib/image-attachments";

function newSessionErrorResponse(error: unknown) {
  if (error instanceof RequestBodyTooLargeError) {
    return Response.json({ error: "New session request is too large", code: "request_too_large" }, { status: 413 });
  }
  if (error instanceof SyntaxError) {
    return Response.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  // host_offline falls through to apiErrorResponse: 503 {hostOffline: true}.
  if ((error instanceof WebRpcError && error.code !== "host_offline") || error instanceof RpcCommandError) {
    return Response.json(
      { error: error.message, code: error instanceof WebRpcError ? error.code : (error.code ?? "rpc_command_failed") },
      { status: 400 },
    );
  }
  return apiErrorResponse(error);
}
// POST /api/agent/new  body: { cwd: string; type: string; hostId?: string; message?: string; ... }
// Spawns a brand-new omp session on `hostId` (this machine when absent). Most
// calls immediately send the first command;
// type:"ensure_session" only creates the runtime so clients can query commands.
// Returns { sessionId, data } where sessionId is omp's real session id.
// Model/thinking presets are applied post-ready via RPC set_model /
// set_thinking_level (not CLI flags) so failures surface as command errors and
// the live model catalog (incl. background discovery) is consulted.
export async function POST(req: Request) {
  let spawnedSession: AgentSessionWrapper | undefined;
  // Surfaced on a 503 so a dropped host link lets the client open the session
  // the host may still be running instead of starting a second one.
  let spawnedSessionId: string | undefined;
  try {
    const body = await parseJsonWithinLimit<{ cwd?: string; hostId?: unknown; [key: string]: unknown }>(req, MAX_AGENT_COMMAND_REQUEST_BYTES);
    const { cwd: requestedCwd, hostId, ...command } = body;
    // New-chat uploads have no session file to attach into; never forward bearer authority to native RPC.
    if (Object.hasOwn(command, "uploadProofs") || Object.hasOwn(command, "uploads")) {
      return Response.json({ error: "Files attach only to an existing session", code: "invalid_uploads" }, { status: 400 });
    }
    const target = resolveHostOrError(hostId);
    if ("response" in target) return target.response;
    const { host } = target;

    if (!requestedCwd || typeof requestedCwd !== "string") {
      return Response.json({ error: "cwd is required", code: "cwd_required" }, { status: 400 });
    }

    // Enforce workspace authorization before spawning: a caller may only start
    // a session in a directory that is already an allowed root (registered via
    // /api/cwd/validate, /api/projects, an existing session's cwd/projectRoot, or
    // an explicit allowFileRoot). This prevents spawning into arbitrary absolute
    // paths that were never browsed/validated. The allowlist holds this
    // machine's paths, so a remote cwd is checked by that host instead.
    if (host.id === LOCAL_HOST_ID) {
      const allowedRoots = await getAllowedFileRoots();
      if (!isExistingFilePathAllowed(requestedCwd, allowedRoots)) {
        return Response.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
      }
    }
    const { provider, modelId, toolNames, thinkingLevel, advisor, ...promptCommand } = command as { provider?: string; modelId?: string; toolNames?: string[]; thinkingLevel?: string; advisor?: boolean; [key: string]: unknown };
    // A fresh child owns the id it receives from omp. Never forward a stale or
    // forged request id into its first command, where it could target another
    // session after a reconnect.
    delete promptCommand.sessionId;
    if (typeof promptCommand.type !== "string" || !promptCommand.type.trim()) {
      return Response.json({ error: "command type is required", code: "command_type_required" }, { status: 400 });
    }

    // The cwd is checked on its host; the host answers with the path it will use.
    const preparing = promptCommand.type !== "ensure_session" || !!(provider && modelId) || !!thinkingLevel;
    const started = await startNewRpcSession(host, requestedCwd, toolNames, advisor === true, preparing);
    if (!started.ok) return opErrorResponse(started);
    const { session, realSessionId } = started.value;
    setSessionAdvisorEnabled(realSessionId, advisor === true);
    spawnedSession = session;
    spawnedSessionId = realSessionId;

    try {
      const run = async () => {
        if (provider && modelId) await session.send({ type: "set_model", provider, modelId });
        if (thinkingLevel) await session.send({ type: "set_thinking_level", level: thinkingLevel });
        if (promptCommand.type === "ensure_session") {
          return Response.json({ success: true, sessionId: realSessionId, data: null });
        }
        const result = await session.send(promptCommand);
        return Response.json({ success: true, sessionId: realSessionId, data: result });
      };
      return await (preparing ? session.withPendingCommand(run, true) : run());
    } catch (error) {
      // The child was spawned but the prompt never ran: without this cleanup a
      // failed set_model/set_thinking_level/prompt leaves an orphaned omp
      // process and a registry entry nobody will ever use.
      // The link dropped: the first command may be running there, so the
      // wrapper stays for the reconnect (and disposing it would wait for the link).
      // Its id lets the client open it instead of starting a second session.
      if (error instanceof WebRpcError && error.code === "host_offline") {
        return Response.json({ error: error.message, code: error.code, hostOffline: true, delivery: error.delivery, sessionId: realSessionId }, { status: 503 });
      }
      await session.destroyAndWait();
      throw error;
    }
  } catch (error) {
    // The link dropped: the first command may be running there, so the wrapper
    // stays for the reconnect (and disposing it would wait for the link). Its
    // id lets the client open it instead of starting a second session.
    if (error instanceof WebRpcError && error.code === "host_offline") {
      return Response.json(
        { error: error.message, code: error.code, hostOffline: true, delivery: error.delivery, ...(spawnedSessionId ? { sessionId: spawnedSessionId } : {}) },
        { status: 503 },
      );
    }
    // Setup runs after spawn (model/thinking/first prompt) can fail. Leaving
    // that brand-new child alive creates an orphan with no owner and can keep
    // its session file or database lock around for the next retry.
    await spawnedSession?.destroyAndWait().catch(() => {});
    return newSessionErrorResponse(error);
  }
}
