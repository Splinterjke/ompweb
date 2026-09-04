import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { getSchedulerWithState } from "@/lib/scheduler-engine";
import {
  deleteSchedulerEntry,
  isValidSchedulerId,
  saveSchedulerFile,
  SchedulerStoreError,
  updateSchedulerEntry,
  validateScriptPath,
} from "@/lib/scheduler-store";
import { ScheduleValidationError, validateSchedule, type ScheduleSpec } from "@/lib/schedule";

const MAX_REQUEST_BYTES = 8_192;

function notFound(id: string): NextResponse {
  return NextResponse.json({ error: "Scheduler not found", code: "scheduler_not_found" }, { status: 404 });
}

// GET /api/schedulers/[id]  →  { scheduler: SchedulerEntry & { running } }
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isValidSchedulerId(id)) return notFound(id);
  try {
    const scheduler = getSchedulerWithState(id);
    if (!scheduler) return notFound(id);
    return NextResponse.json({ scheduler });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

// PATCH /api/schedulers/[id]
// body: { name?, script?, args?, schedule?, enabled?, timeoutMs? }
// Any subset; schedule/script are re-validated. Changing the schedule resets
// nextRunAt to the next slot. Toggling enabled off clears nextRunAt.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isValidSchedulerId(id)) return notFound(id);
  try {
    const body = await parseJsonWithinLimit<{
      name?: unknown;
      script?: unknown;
      args?: unknown;
      schedule?: unknown;
      enabled?: unknown;
      timeoutMs?: unknown;
    }>(req, MAX_REQUEST_BYTES);

    if (body.script !== undefined) {
      const check = validateScriptPath(typeof body.script === "string" ? body.script : "");
      if (!check.ok) {
        return NextResponse.json({ error: check.error, code: check.error }, { status: 400 });
      }
      body.script = check.path;
    }

    let schedule: ScheduleSpec | undefined;
    if (body.schedule !== undefined) {
      try {
        schedule = validateSchedule(body.schedule);
      } catch (err) {
        if (err instanceof ScheduleValidationError) {
          return NextResponse.json({ error: err.code, code: err.code }, { status: 400 });
        }
        throw err;
      }
    }

    const { file, entry } = updateSchedulerEntry(
      id,
      {
        name: typeof body.name === "string" ? body.name : undefined,
        script: typeof body.script === "string" ? body.script : undefined,
        args: Array.isArray(body.args) ? body.args.filter((a): a is string => typeof a === "string") : undefined,
        schedule,
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
      },
    );
    saveSchedulerFile(file);
    return NextResponse.json({ scheduler: entry });
  } catch (error) {
    if (error instanceof ScheduleValidationError) {
      return NextResponse.json({ error: error.code, code: error.code }, { status: 400 });
    }
    if (error instanceof SchedulerStoreError) {
      const status = error.code === "scheduler_not_found" ? 404 : 400;
      return NextResponse.json({ error: String(error), code: error.code }, { status });
    }
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: String(error), code: "request_too_large" }, { status: 400 });
    }
    return apiErrorResponse(error);
  }
}

// DELETE /api/schedulers/[id]  →  { success: true }
// Removes the entry and its run history. An in-flight run, if any, is allowed
// to finish; its final record is dropped (recordRun is no-op for deleted ids).
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isValidSchedulerId(id)) return notFound(id);
  try {
    saveSchedulerFile(deleteSchedulerEntry(id));
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof SchedulerStoreError && error.code === "scheduler_not_found") {
      return notFound(id);
    }
    return apiErrorResponse(error);
  }
}
