import { getPairingService } from "@/lib/remote-pairing-store";


/** Revoke one device from the pairing registry. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    return Response.json({ error: "invalid device id", code: "invalid_device_id" }, { status: 400 });
  }
  const removed = getPairingService().revoke(id);
  return removed
    ? Response.json({ success: true })
    : Response.json({ error: "device not found", code: "device_not_found" }, { status: 404 });
}
