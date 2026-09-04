import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { ensureSchedulerEngine, getEngineStartedAt, listSchedulersWithState } from "@/lib/scheduler-engine";
import { createSchedulerEntry, saveSchedulerFile, SchedulerStoreError, validateScriptPath } from "@/lib/scheduler-store";
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
// body: { name?, script, args?, schedule, enabled?, timeoutMs? }
// Validates the schedule and the script path (exists + regular file; .sh via
// bash, others must be executable), then creates the entry. 400 on any
// validation failure with a stable `code`.
export async function POST(req: Request) {
  try {
    const body = await parseJsonWithinLimit<{
      name?: unknown;
      script?: unknown;
      args?: unknown;
      schedule?: unknown;
      enabled?: unknown;
      timeoutMs?: unknown;
    }>(req, MAX_REQUEST_BYTES);

    const scriptCheck = validateScriptPath(typeof body.script === "string" ? body.script : "");
    if (!scriptCheck.ok) {
      return NextResponse.json({ error: scriptCheck.error, code: scriptCheck.error }, { status: 400 });
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

    const args = Array.isArray(body.args) ? body.args.filter((a): a is string => typeof a === "string") : [];
    const { file, entry } = createSchedulerEntry({
      name: typeof body.name === "string" ? body.name : undefined,
      script: scriptCheck.path,
      args,
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
