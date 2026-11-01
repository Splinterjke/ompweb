import { getPairingService } from "@/lib/remote-pairing-store";
import { hostClient, rustBackendActive } from "@/lib/omp/host-client";
import { syncPairingMirror } from "@/lib/remote-pairing-mirror";


/** Presence heartbeat: refreshes the device's lastActiveAt from its cookie.
 *  Doc 16 route 13: presence lives in the Rust registry; the JSON mirror
 *  keeps the proxy pairing gate in sync. */
export async function POST(request: Request) {
  const service = getPairingService();
  const deviceId = new Bun.CookieMap(request.headers.get("cookie") ?? "").get(service.getConfig().cookieName) ?? undefined;
  if (!deviceId) {
    return Response.json({ error: "not paired", code: "not_paired" }, { status: 401 });
  }
  if (rustBackendActive()) {
    const { ok } = await hostClient.device.touch(deviceId);
    if (!ok) {
      return Response.json({ error: "unknown device", code: "unknown_device" }, { status: 401 });
    }
    await syncPairingMirror();
    return Response.json({ ok: true });
  }
  const touched = service.touch(deviceId);
  return touched
    ? Response.json({ ok: true })
    : Response.json({ error: "unknown device", code: "unknown_device" }, { status: 401 });
}