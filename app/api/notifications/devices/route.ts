import { NextResponse } from "next/server";
import { isValidNotificationId, parseNotificationPrefs } from "@/lib/notification-events";
import { getNotificationDevice, getVapidPublicKey, parsePushSubscription, saveNotificationDevice } from "@/lib/notification-hub";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

/** GET /api/notifications/devices?deviceId= — VAPID public key and whether this device has a push subscription. */
export async function GET(req: Request) {
  const deviceId = new URL(req.url).searchParams.get("deviceId");
  const device = isValidNotificationId(deviceId) ? getNotificationDevice(deviceId) : undefined;
  return NextResponse.json({ publicKey: getVapidPublicKey(), subscribed: Boolean(device?.subscription) });
}

/** PUT /api/notifications/devices { deviceId, prefs, subscription? } — an omitted subscription keeps the stored one. */
export async function PUT(req: Request) {
  const body: unknown = await req.json().catch(() => null);
  if (!isRecord(body) || !isValidNotificationId(body.deviceId)) {
    return NextResponse.json({ error: "deviceId is required", code: "invalid_device" }, { status: 400 });
  }
  const subscription = body.subscription === undefined ? undefined : parsePushSubscription(body.subscription);
  if (subscription === null) return NextResponse.json({ error: "Invalid push subscription", code: "invalid_subscription" }, { status: 400 });
  const device = saveNotificationDevice(body.deviceId, parseNotificationPrefs(body.prefs), subscription);
  return NextResponse.json({ subscribed: Boolean(device.subscription) });
}
