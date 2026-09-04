import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { humanizeSchedule, nextRunAfter, ScheduleValidationError, validateSchedule } from "@/lib/schedule";

const MAX_REQUEST_BYTES = 4_096;

// POST /api/schedulers/preview
// body: { schedule }
// → { ok: true, human, nextRunAt } | 400 { ok: false, error }
// Lets the modal show a live "next run" as the user edits the schedule; the
// server stays the source of truth for cron parsing.
export async function POST(req: Request) {
  try {
    const body = await parseJsonWithinLimit<{ schedule?: unknown }>(req, MAX_REQUEST_BYTES);
    try {
      const schedule = validateSchedule(body.schedule);
      const next = nextRunAfter(schedule, new Date());
      return NextResponse.json({
        ok: true,
        human: humanizeSchedule(schedule),
        nextRunAt: next ? next.toISOString() : null,
      });
    } catch (err) {
      if (err instanceof ScheduleValidationError) {
        return NextResponse.json({ ok: false, error: err.code }, { status: 400 });
      }
      throw err;
    }
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ ok: false, error: "request_too_large" }, { status: 400 });
    }
    return apiErrorResponse(error);
  }
}
