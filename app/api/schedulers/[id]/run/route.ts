import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { ensureSchedulerEngine, triggerManualRun } from "@/lib/scheduler-engine";
import { isValidSchedulerId } from "@/lib/scheduler-store";

// POST /api/schedulers/[id]/run  →  202 { started: true }
// Fires the script immediately (independent of the schedule; nextRunAt is
// untouched). 409 when a run for this scheduler is already active — runs are
// serial per scheduler.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isValidSchedulerId(id)) {
    return NextResponse.json({ error: "Scheduler not found", code: "scheduler_not_found" }, { status: 404 });
  }
  try {
    ensureSchedulerEngine();
    const result = triggerManualRun(id);
    if (!result.ok) {
      const status = result.error === "scheduler_not_found" ? 404 : 409;
      return NextResponse.json({ error: result.error, code: result.error }, { status });
    }
    return NextResponse.json({ started: true }, { status: 202 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
