import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { validateScriptPath } from "@/lib/scheduler-store";

const MAX_REQUEST_BYTES = 4_096;

// POST /api/schedulers/validate
// body: { script }
// → { ok: true, path, shell } | 400 { ok: false, error }
// The modal checks the typed script path against the server filesystem
// (exists + regular file; the executable bit only where the engine spawns the
// file itself, not where it hands it to an interpreter) so the error surfaces
// before the user saves. The `shell` answer is that same decision.
export async function POST(req: Request) {
  try {
    const body = await parseJsonWithinLimit<{ script?: unknown }>(req, MAX_REQUEST_BYTES);
    const check = validateScriptPath(typeof body.script === "string" ? body.script : "");
    if (!check.ok) {
      return Response.json({ ok: false, error: check.error }, { status: 400 });
    }
    return Response.json({ ok: true, path: check.path, shell: check.shell });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json({ ok: false, error: "request_too_large" }, { status: 400 });
    }
    return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }
}
