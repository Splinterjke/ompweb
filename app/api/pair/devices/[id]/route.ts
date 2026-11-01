import { getPairingService } from "@/lib/remote-pairing-store";
import { hostClient, rustBackendActive } from "@/lib/omp/host-client";
import { syncPairingMirror } from "@/lib/remote-pairing-mirror";


/** Revoke one device. Doc 16 route 13: revocation runs on the Rust registry. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    return Response.json({ error: "invalid device id", code: "invalid_device_id" }, { status: 400 });
  }
  if (rustBackendActive()) {
    const { ok } = await hostClient.device.revoke(id);
    if (!ok) {
      return Response.json({ error: "device not found", code: "device_not_found" }, { status: 404 });
    }
    await syncPairingMirror();
    return Response.json({ success: true });
  }
  const removed = getPairingService().revoke(id);
  return removed
    ? Response.json({ success: true })
    : Response.json({ error: "device not found", code: "device_not_found" }, { status: 404 });
}