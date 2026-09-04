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
  return requestOrigin !== null && canonicalOrigin(origin) === requestOrigin;
}

export function shouldCheckApiRequestOrigin(request: Request): boolean {
  return request.headers.has("origin") || request.headers.has("sec-fetch-site");
}
