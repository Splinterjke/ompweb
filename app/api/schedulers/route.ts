import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { ensureSchedulerEngine, getEngineStartedAt, listSchedulersWithState } from "@/lib/scheduler-engine";
import { createSchedulerEntry, saveSchedulerFile, SchedulerStoreError, validateScriptPath, validateWorkspacePath } from "@/lib/scheduler-store";
import { ScheduleValidationError, validateSchedule } from "@/lib/schedule";

const MAX_REQUEST_BYTES = 8_192;

// GET /api/schedulers  →  { schedulers: (SchedulerEntry & { running })[], engineStartedAt }
// Ensures the in-process engine is running (catch-up tick included) so the
// list always reflects live state, then returns the store plus the engine's
// process-start time (so the client can ignore stale pre-restart failures).
export async function GET() {
  try {
    ensureSchedulerEngine();
    return NextResponse.json({ schedulers: listSchedulersWithState(), engineStartedAt: getEngineStartedAt() });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

// POST /api/schedulers
// body (script): { name?, script, args?, schedule, enabled?, timeoutMs? }
// body (prompt): { name?, kind: "prompt", prompt, provider?, modelId?,
//                  noSession?, clearContext?, compactContext?, schedule, enabled?, timeoutMs? }
// Script entries validate the script path (exists + regular file; .sh via
// bash, others must be executable). Prompt entries validate the prompt text
// (non-empty) and the clear/compact mutual exclusion. 400 on any validation
// failure with a stable `code`.
export async function POST(req: Request) {
  try {
    const body = await parseJsonWithinLimit<{
      name?: unknown;
      kind?: unknown;
      script?: unknown;
      args?: unknown;
      prompt?: unknown;
      provider?: unknown;
      modelId?: unknown;
      cwd?: unknown;
      noSession?: unknown;
      clearContext?: unknown;
      compactContext?: unknown;
      schedule?: unknown;
      enabled?: unknown;
      timeoutMs?: unknown;
    }>(req, MAX_REQUEST_BYTES);

    const kind = body.kind === "prompt" ? "prompt" : "script";

    let scriptPath: string | undefined;
    if (kind === "script") {
      const scriptCheck = validateScriptPath(typeof body.script === "string" ? body.script : "");
      if (!scriptCheck.ok) {
        return NextResponse.json({ error: scriptCheck.error, code: scriptCheck.error }, { status: 400 });
      }
      scriptPath = scriptCheck.path;
    }

    let schedule;
    try {
      schedule = validateSchedule(body.schedule);
    } catch (err) {
      if (err instanceof ScheduleValidationError) {
        return NextResponse.json({ error: err.code, code: err.code }, { status: 400 });
      }
      throw err;
    }

    // Prompt workspace: optional; when set it must resolve to an existing
    // directory — the engine starts the omp session there.
    const workspaceCheck = validateWorkspacePath(body.cwd);
    if (!workspaceCheck.ok) {
      return NextResponse.json({ error: workspaceCheck.error, code: workspaceCheck.error }, { status: 400 });
    }
    const workspaceCwd = kind === "prompt" ? workspaceCheck.path : undefined;

    const args = kind === "script" && Array.isArray(body.args) ? body.args.filter((a): a is string => typeof a === "string") : [];
    const { file, entry } = createSchedulerEntry({
      name: typeof body.name === "string" ? body.name : undefined,
      kind,
      script: scriptPath,
      args,
      prompt: typeof body.prompt === "string" ? body.prompt : undefined,
      provider: typeof body.provider === "string" && body.provider ? body.provider : undefined,
      modelId: typeof body.modelId === "string" && body.modelId ? body.modelId : undefined,
      cwd: workspaceCwd,
      noSession: typeof body.noSession === "boolean" ? body.noSession : undefined,
      clearContext: typeof body.clearContext === "boolean" ? body.clearContext : undefined,
      compactContext: typeof body.compactContext === "boolean" ? body.compactContext : undefined,
      schedule,
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
    });
    saveSchedulerFile(file);
    ensureSchedulerEngine();
    return NextResponse.json({ scheduler: entry }, { status: 201 });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError || error instanceof SchedulerStoreError) {
      const code = error instanceof SchedulerStoreError ? error.code : "request_too_large";
      return NextResponse.json({ error: String(error), code }, { status: 400 });
    }
    return apiErrorResponse(error);
  }
}
