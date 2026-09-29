import { NextResponse } from "next/server";
import { syncInterruptibleSessions } from "@/lib/rpc-manager";
import { loadWebServerSettings, saveWebServerSettings } from "@/lib/web-settings";

export const dynamic = "force-dynamic";

// GET/PUT /api/web-settings - omp-web's own server-side settings.
export async function GET() {
  return NextResponse.json(loadWebServerSettings());
}

export async function PUT(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  const autoResumeSessions = (body as { autoResumeSessions?: unknown } | null)?.autoResumeSessions;
  if (typeof autoResumeSessions !== "boolean") {
    return NextResponse.json({ error: "autoResumeSessions must be a boolean", code: "invalid_settings" }, { status: 400 });
  }
  const settings = saveWebServerSettings({ autoResumeSessions });
  // Apply to sessions that are already running, not only the next run.
  syncInterruptibleSessions();
  return NextResponse.json(settings);
}
