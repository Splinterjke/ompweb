import { getPairingService } from "@/lib/remote-pairing-store";
import { hostClient, rustBackendActive } from "@/lib/omp/host-client";


/** Device roster. Doc 16 route 13: the Rust registry is the roster truth;
 *  config stays an HTTP-adapter concern (cookie name / publicUrl / ...). */
export async function GET() {
  const service = getPairingService();
  const devices = rustBackendActive()
    ? await hostClient.device.list()
    : service.listDevices().map((device) => ({
        id: device.id,
        name: device.name,
        platform: device.mobile ? "mobile" : "desktop",
        pairedAt: device.pairedAt,
        lastActiveAt: device.lastActiveAt,
        online: service.isOnline(device),
      }));
  return Response.json({ devices, config: service.getConfig() });
}