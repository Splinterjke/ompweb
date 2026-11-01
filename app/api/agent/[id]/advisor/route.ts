import { resolveSessionPathOr404 } from "@/lib/api-utils";
import { getSessionAdvisorEnabled, setSessionAdvisorEnabled } from "@/lib/session-preferences";


export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const resolved = await resolveSessionPathOr404(id);
  if ("response" in resolved) return resolved.response;
  return Response.json({ enabled: getSessionAdvisorEnabled(id) });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const resolved = await resolveSessionPathOr404(id);
  if ("response" in resolved) return resolved.response;
  const body = (await request.json()) as { enabled?: unknown };
  if (typeof body.enabled !== "boolean")
    return Response.json({ error: "enabled must be a boolean" }, { status: 400 });
  setSessionAdvisorEnabled(id, body.enabled);
  return Response.json({ success: true, enabled: body.enabled });
}
