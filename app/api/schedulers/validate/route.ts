import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { validateScriptPath } from "@/lib/scheduler-store";

const MAX_REQUEST_BYTES = 4_096;

// POST /api/schedulers/validate
// body: { script }
// → { ok: true, path, shell } | 400 { ok: false, error }
// The modal checks the typed script path against the server filesystem
// (exists + regular file; .sh via bash, others need the executable bit) so
// the error surfaces before the user saves.
export async function POST(req: Request) {
  try {
    const body = await parseJsonWithinLimit<{ script?: unknown }>(req, MAX_REQUEST_BYTES);
    const check = validateScriptPath(typeof body.script === "string" ? body.script : "");
    if (!check.ok) {
      return NextResponse.json({ ok: false, error: check.error }, { status: 400 });
    }
    return NextResponse.json({ ok: true, path: check.path, shell: check.shell });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ ok: false, error: "request_too_large" }, { status: 400 });
    }
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }
}
