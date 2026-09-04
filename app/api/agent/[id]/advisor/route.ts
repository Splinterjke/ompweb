import { NextResponse } from "next/server";
import { resolveSessionPathOr404 } from "@/lib/api-utils";
import { getSessionAdvisorEnabled, setSessionAdvisorEnabled } from "@/lib/session-preferences";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const resolved = await resolveSessionPathOr404(id);
  if ("response" in resolved) return resolved.response;
  return NextResponse.json({ enabled: getSessionAdvisorEnabled(id) });
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
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  setSessionAdvisorEnabled(id, body.enabled);
  return NextResponse.json({ success: true, enabled: body.enabled });
}
