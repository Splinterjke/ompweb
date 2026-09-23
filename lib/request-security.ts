import { isIP } from "node:net";

const LOOPBACK_HOSTNAMES: Record<string, true> = { localhost: true, "::1": true, "0:0:0:0:0:0:0:1": true };

function hostnameFromAuthority(authority: string): string | null {
  try {
    return new URL(`http://${authority}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES[hostname] === true || hostname.startsWith("127.");
}

function configuredHostnames(): string[] {
  return [
    process.env.OMP_WEB_HOSTNAME,
    ...(process.env.OMP_WEB_ALLOWED_HOSTS?.split(",") ?? []),
  ].flatMap((value) => {
    const trimmed = value?.trim();
    if (!trimmed) return [];
    const hostname = isIP(trimmed) ? trimmed : hostnameFromAuthority(trimmed.includes(":") ? trimmed : `${trimmed}:80`);
    return hostname ? [hostname] : [];
  });
}

export function isApiRequestHostAllowed(
  request: Request,
  allowedHostnames = configuredHostnames(),
): boolean {
  const host = request.headers.get("host");
  const hostname = host ? hostnameFromAuthority(host) : null;
  if (!hostname) return false;
  if (isLoopbackHostname(hostname)) return true;
  return allowedHostnames.includes(hostname);
}

function canonicalOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function getRequestOrigin(request: Request): string | null {
  const requestUrl = new URL(request.url);
  const host = request.headers.get("host");
  return host ? canonicalOrigin(`${requestUrl.protocol}//${host}`) : requestUrl.origin;
}

/** Reject DNS rebinding and browser cross-site API requests while preserving trusted non-browser clients. */
export function isApiRequestOriginAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!origin) return fetchSite !== "cross-site";

  const requestOrigin = getRequestOrigin(request);
  if (requestOrigin === null) return false;
  if (canonicalOrigin(origin) === requestOrigin) return true;
  // Some local HTTP proxies strip the port from the forwarded Origin header
  // (e.g. `http://127.0.0.1:30177` arrives as `http://127.0.0.1`), which
  // would otherwise 403 every API request. Accept that shape only when
  // protocol + hostname match the Host-derived origin exactly and the
  // received Origin carries the scheme's default port (i.e. no explicit
  // port — browsers always send a non-default port, so a same-host attacker
  // on another explicit port such as :9999 is still rejected). Hostname
  // mismatches (the evil.com drive-by case) are still rejected here.
  try {
    const received = new URL(origin);
    const expected = new URL(requestOrigin);
    return received.protocol === expected.protocol
      && received.hostname === expected.hostname
      && received.port === "";
  } catch {
    return false;
  }
}

export function shouldCheckApiRequestOrigin(request: Request): boolean {
  return request.headers.has("origin") || request.headers.has("sec-fetch-site");
}
