import { getPairingService } from "@/lib/remote-pairing-store";


/** Device roster. The PairingService registry is the truth; config stays an
 *  HTTP-adapter concern (cookie name / publicUrl / ...). */
export async function GET() {
  const service = getPairingService();
  const devices = service.listDevices().map((device) => ({
    id: device.id,
    name: device.name,
    platform: device.mobile ? "mobile" : "desktop",
    pairedAt: device.pairedAt,
    lastActiveAt: device.lastActiveAt,
    online: service.isOnline(device),
  }));
  return Response.json({ devices, config: service.getConfig() });
}
