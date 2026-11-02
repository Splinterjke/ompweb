import { getPairingService } from "@/lib/remote-pairing-store";


/** Revoke every paired device and clear the active token (Stop). */
export async function POST() {
  getPairingService().stop();
  return Response.json({ success: true });
}
