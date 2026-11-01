import { isApiRequestHostAllowed, isApiRequestOriginAllowed, shouldCheckApiRequestOrigin } from "@/lib/request-security";
import {
  isTrustedProxyRequest,
  isValidWebSession,
  isWebPasswordEnabled,
  OMP_WEB_SESSION_COOKIE,
  OMP_WEB_TRUSTED_HEADER,
  webPasswordConfigurationProblem,
} from "@/lib/web-auth";
import { readFileSync, statSync } from "fs";
import { join } from "path";
import { getAgentDir } from "@/lib/omp/paths";
import { verifiedRequestPeer } from "./bin/request-peer";

/**
 * Remote-access gate for /api/*: when pairing requires it, requests from a
 * non-loopback SOCKET peer (LAN IP or public tunnel) must carry a valid
 * paired-device cookie. Loopback exemption is decided by the socket peer
 * alone — the Host header is forgeable and never bypasses the gate. Only the
 * pairing FLOW itself is exempt — issuing and consuming tokens — so an
 * unpaired LAN attacker cannot reach revoke-all, config (which could disable
 * the gate), devices, or tunnel.
 */
const PAIRING_FLOW_PATHS = ["/api/pair/token", "/api/pair/accept"];

function isPairingFlowPath(pathname: string): boolean {
  return PAIRING_FLOW_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

// The pairing file is small but the gate runs on every remote /api request;
// cache by mtime so the file is only read when it actually changed.
interface PairingFileState {
  config?: Record<string, unknown>;
  devices?: Array<{ id?: unknown; lastActiveAt?: unknown }>;
}

let pairingCache: { mtimeMs: number; state: PairingFileState } | null = null;

function readPairingState(): PairingFileState | null {
  const path = join(getAgentDir(), "remote-pairing.json");
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (pairingCache && pairingCache.mtimeMs === mtimeMs) return pairingCache.state;
    const state = JSON.parse(readFileSync(path, "utf8")) as PairingFileState;
    pairingCache = { mtimeMs, state };
    return state;
  } catch {
    pairingCache = null;
    return null;
  }
}

function checkPairingGate(request: Request): Response | null {
  // Loopback exemption is decided by the SOCKET peer, carried from the HTTP
  // boundary by the launcher preload (bin/request-peer.js stamps the real
  // remoteAddress plus an HMAC proof; verifiedRequestPeer rejects forged
  // copies). The Host header and bare forwarding headers are forgeable and
  // never exempt a request. Without a verified peer the request is treated
  // as remote — fail closed.
  const loopback = isLoopbackSocket(request);
  if (loopback) return null;

  const pathname = new URL(request.url).pathname;
  // Token ISSUANCE must stay loopback-only: minting a token is how a device
  // pairs itself, so a remote peer must not be able to bootstrap one. The
  // phone only ever consumes tokens via /api/pair/accept, which stays
  // reachable below.
  if (pathname === "/api/pair/token") {
    return Response.json({ error: "Pairing tokens can only be issued from this computer", code: "token_loopback_only" }, { status: 403 });
  }
  if (isPairingFlowPath(pathname)) return null;
  // The /remote landing page is part of the pairing FLOW itself (the phone
  // opens it from the QR and it performs the accept): it renders no data,
  // so it must stay reachable before any device is paired.
  if (pathname === "/remote" || pathname.startsWith("/remote/")) return null;

  const state = readPairingState();
  const rawConfig = state?.config ?? {};
  // Pairing is opt-in (off by default): when it is not required, non-loopback
  // /api access is allowed without a paired-device cookie.
  if (rawConfig.requirePairingForLan !== true) return null;
  // Pairing is required but no state file exists: nothing can have been
  // paired — deny remote access.
  if (!state) return deny();

  const cookieName = typeof rawConfig.cookieName === "string" ? rawConfig.cookieName : "dsh_pair";
  const deviceId = parseCookie(request, cookieName);
  if (!deviceId) return deny();

  const devices = Array.isArray(state.devices) ? state.devices : [];
  const device = devices.find((d) => d.id === deviceId);
  if (!device || typeof device.lastActiveAt !== "number") return deny();

  const idleExpireMs = typeof rawConfig.idleExpireMs === "number" ? rawConfig.idleExpireMs : 7 * 24 * 60 * 60 * 1000;
  if (Date.now() - device.lastActiveAt > idleExpireMs) return deny();

  return null;
}

function deny(): Response {
  return Response.json({ error: "Remote access requires a paired device", code: "pairing_required" }, { status: 401 });
}

/** Socket-peer loopback detection — never infer a trusted peer from a
 * forgeable request header. A configured reverse proxy may provide the
 * client address; otherwise only a runtime-resolved peer IP counts. */
function isLoopbackSocket(request: { headers: Headers; ip?: string } | Request): boolean {
  const trustedProxy = process.env.OMP_WEB_TRUSTED_PROXY === "1";
  if (trustedProxy) {
    const cf = request.headers.get("cf-connecting-ip");
    if (cf) return isIpLoopback(cf);
    const fwd = request.headers.get("x-forwarded-for");
    if (fwd) {
      const first = fwd.split(",")[0]?.trim();
      if (first) return isIpLoopback(first);
    }
    const forwarded = request.headers.get("forwarded");
    if (forwarded) {
      const forMatch = forwarded.match(/(?:^|,\s*)for=(?:"?\[?)([^\];,"\s]+)/);
      if (forMatch?.[1]) return isIpLoopback(forMatch[1]);
    }
  }
  // Source-resolved IP when available. In Next versions that do not expose
  // it, unknown must fail closed as non-loopback; treating it as local would
  // silently open a wildcard listener to any LAN client.
  const srcIp = verifiedRequestPeer(request.headers) ?? (request as unknown as { ip?: string }).ip;
  if (srcIp) return isIpLoopback(srcIp);
  return false;
}

function isIpLoopback(ip: string): boolean {
  const value = ip.trim().toLowerCase();
  if (value === "::1" || value === "::ffff:127.0.0.1" || value === "0:0:0:0:0:0:0:1") return true;
  if (value.startsWith("127.")) return true;
  // IPv4-mapped / injected forms recovered above; anything else is remote.
  return false;
}

/** Pure loopback decision used by the pairing gate (exported for tests). */
export function isLoopbackConnection(request: Request): boolean {
  return isLoopbackSocket(request);
}

// The sign-in screen still needs its JavaScript, CSS and fonts (/assets/, and
// in dev only Bun's bundles under /_bun/) before a session exists; these and the
// ordinary browser icons are public assets, not workspace data. /api/manifest
// stays authenticated: its link includes credentials and its embedded
// installation icons need no separate request. The service worker script holds
// no data either, and the browser re-fetches it for update checks even after
// the sign-in cookie expired. /assets/ is a prefix on purpose: it holds only the
// hashed build output. The icon and sw.js names are exact (anchored), so no path
// below or beside them skips the gate. /api/hosts/link and its blob/ subpath
// authenticate the host's bearer token themselves before they read any body
// (lib/hosts/hub.ts).
export const UNGATED = /^\/(?:assets\/|(?:favicon\.ico|favicon\.png|favicon\.svg|favicon-\d+x\d+\.png|icon\.svg|icon\.png|icon-192\.png|badge-96\.png|sw\.js)$|api\/hosts\/link(?:\/|$))/;

// Relative: request.url is always http:// under Bun, so an absolute Location would leave https behind a TLS proxy.
const redirect = (location: string) => new Response(null, { status: 307, headers: { location } });

// Cookie reading shared by the gate paths; a plain parser keeps proxy.ts
// importable under Node (the pairing-gate tests run there) as well as Bun.
function parseCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > -1 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * The password gate and API origin check. A Response answers the request; otherwise it continues, "authenticated"
 * when it carries a session or the trusted header (or no password is set), "public" when it needs neither.
 */
export function proxy(request: Request): Response | "public" | "authenticated" {
  const url = new URL(request.url);
  const { pathname } = url;
  if (UNGATED.test(pathname) || (process.env.NODE_ENV === "development" && pathname.startsWith("/_bun/"))) return "public";
  if (!isApiRequestHostAllowed(request)) {
    return Response.json({ error: "Untrusted Host header" }, { status: 403 });
  }
  if (pathname.startsWith("/api/") && shouldCheckApiRequestOrigin(request) && !isApiRequestOriginAllowed(request)) {
    return Response.json({ error: "Cross-origin API requests are not allowed" }, { status: 403 });
  }
  const pairingDenied = checkPairingGate(request);
  if (pairingDenied) return pairingDenied;

  // A configured-but-unusable password (plaintext, or a truncated hash) must
  // never degrade into an open server: refuse every request with the fix. The
  // problem is also reported once at startup (instrumentation.ts), so this
  // deliberately logs nothing — a doomed request loop must not flood the log.
  const passwordProblem = webPasswordConfigurationProblem();
  if (passwordProblem) {
    return new Response(`omp-web password configuration error\n\n${passwordProblem}\n`, {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  if (!isWebPasswordEnabled()) {
    return pathname === "/login" ? redirect("/") : "authenticated";
  }

  // The pairing flow must stay reachable from a phone even when a web
  // password is enabled (the paired cookie is checked on every other
  // remote /api request; the password protects the session afterwards).
  // The /remote landing page performs the accept itself, so it is exempt
  // too; it renders no data.
  if (isPairingFlowPath(pathname) || pathname === "/remote") return "public";
  // The ordinary browser icons (tab/favicon) are covered by UNGATED above:
  // browsers fetch them without cookies, but the names are matched exactly, so
  // no path below or beside them skips the gate. /api/manifest is
  // authenticated instead — its link carries credentials and its embedded
  // installation icons need no separate request, so installs work behind the
  // web password.
  // The rebuild reaper POSTs /api/ui/refresh from loopback after every
  // restart (detached, no session cookie) to mark the boot "updated", wake
  // the host daemon, and fan out the refresh frame. The endpoint exposes no
  // data — it only pokes the host and broadcasts — so a loopback-only
  // exemption is safe. Same socket-peer precedent as the pairing gate above;
  // a non-loopback caller still 401s.
  if (pathname === "/api/ui/refresh" && isLoopbackConnection(request)) return "public";
  // `OMP_WEB_TRUSTED_PROXY=1` (loopback-via-forwarded-headers for the pairing
  // gate above) is separate legacy behavior; X-Omp-Web-Auth is the only
  // *authentication* vouch — a matching digest counts as signed in.
  const hasSession = isTrustedProxyRequest(request.headers.get(OMP_WEB_TRUSTED_HEADER))
    || isValidWebSession(parseCookie(request, OMP_WEB_SESSION_COOKIE));
  if (pathname === "/login") {
    return hasSession ? redirect("/") : "public";
  }
  if (pathname === "/api/web-auth/session") return "public";
  if (hasSession) return "authenticated";
  if (pathname.startsWith("/api/")) {
    return Response.json({ error: "Password required", code: "password_required" }, { status: 401 });
  }
  // Keep a deep link to a session (e.g. a notification click) across sign-in.
  return redirect(pathname === "/" && url.search ? `/login?${new URLSearchParams({ next: `/${url.search}` })}` : "/login");
}

