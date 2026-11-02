import { getPairingService } from "@/lib/remote-pairing-store";


/** Presence heartbeat: refreshes the device's lastActiveAt from its cookie. */
export async function POST(request: Request) {
  const service = getPairingService();
  const deviceId = new Bun.CookieMap(request.headers.get("cookie") ?? "").get(service.getConfig().cookieName) ?? undefined;
  if (!deviceId) {
    return Response.json({ error: "not paired", code: "not_paired" }, { status: 401 });
  }
  const touched = service.touch(deviceId);
  return touched
    ? Response.json({ ok: true })
    : Response.json({ error: "unknown device", code: "unknown_device" }, { status: 401 });
}
