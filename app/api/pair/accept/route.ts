import { getPairingService } from "@/lib/remote-pairing-store";


/**
 * Exchange a one-time token for a paired-device cookie. The device is
 * registered with the User-Agent-derived name; the cookie is HttpOnly and
 * SameSite=Lax so gated /api requests from LAN/public hosts pass. The
 * PairingService persists the registry in the JSON file proxy.ts's pairing
 * gate reads.
 */
export async function POST(request: Request) {
  let body: { token?: unknown; mobile?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid body", code: "invalid_body" }, { status: 400 });
  }
  if (typeof body.token !== "string" || !body.token) {
    return Response.json({ error: "token is required", code: "token_required" }, { status: 400 });
  }
  const service = getPairingService();
  const userAgent = request.headers.get("user-agent") ?? "";
  const device = service.accept(body.token, userAgent, body.mobile === true);
  if (!device) {
    return Response.json({ error: "invalid or expired token", code: "invalid_or_expired_token" }, { status: 403 });
  }
  // Preserve LAN HTTP pairing while preventing a paired-device credential
  // from ever being replayed over plaintext when the configured remote URL
  // is HTTPS (for example a Cloudflare Tunnel or reverse proxy).
  const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  const cookie = new Bun.Cookie(service.getConfig().cookieName, device.id, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: 365 * 24 * 60 * 60,
  });
  return Response.json({ device }, { status: 201, headers: { "set-cookie": cookie.serialize() } });
}
