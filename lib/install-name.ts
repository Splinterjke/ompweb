import { isIP } from "node:net";

const DEFAULT_NAME = "omp web";
// OMP_WEB_NAME values (case-insensitive) that derive the name from the request.
const FROM_REQUEST = ["url", "host", "domain"];

/**
 * Display-only label shared by installation metadata and browser titles.
 * `OMP_WEB_NAME` decides it: unset or blank keeps `omp web`; `url`, `host` or
 * `domain` derives it from the request's Host header; anything else is used
 * verbatim.
 */
export function getInstallName(
  headers: Pick<Headers, "get">,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const name = env.OMP_WEB_NAME?.trim();
  if (!name) return DEFAULT_NAME;
  return FROM_REQUEST.includes(name.toLowerCase()) ? nameFromHost(headers.get("host")) : name;
}

function nameFromHost(host: string | null): string {
  // "@", "#", "?", "/", backslash and whitespace are illegal in a Host header,
  // but URL.parse would silently strip userinfo/fragments/queries instead of
  // failing — so reject them up front and fail closed to the generic name.
  if (!host || /[@#?/\\\s]/.test(host)) return DEFAULT_NAME;
  const hostname = URL.parse(`http://${host}`)?.hostname;
  // Browsers resolve *.localhost to loopback, so it is localhost by another
  // name. (WHATWG already lowercases, so no case handling is needed here.)
  if (
    !hostname
    || hostname === "localhost"
    || hostname === "localhost."
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".localhost.")
  ) {
    return DEFAULT_NAME;
  }
  return isIP(hostname.startsWith("[") ? hostname.slice(1, -1) : hostname) ? DEFAULT_NAME : hostname;
}
