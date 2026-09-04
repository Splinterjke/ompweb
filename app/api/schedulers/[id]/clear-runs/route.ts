import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { clearRuns, isValidSchedulerId, saveSchedulerFile, SchedulerStoreError } from "@/lib/scheduler-store";

// POST /api/schedulers/[id]/clear-runs  →  { success: true }
// Empties the scheduler's run history in schedulers.json (the entry itself is
// untouched). 404 when the id does not exist.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isValidSchedulerId(id)) {
    return NextResponse.json({ error: "Scheduler not found", code: "scheduler_not_found" }, { status: 404 });
  }
  try {
    saveSchedulerFile(clearRuns(id));
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof SchedulerStoreError && error.code === "scheduler_not_found") {
      return NextResponse.json({ error: String(error), code: error.code }, { status: 404 });
    }
    return apiErrorResponse(error);
  }
}
