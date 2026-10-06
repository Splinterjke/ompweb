import { isIP } from "node:net";

/** Display-only label shared by installation metadata and browser titles. */
export function getInstallName(headers: Pick<Headers, "get">): string {
  const host = headers.get("host");
  // "@", "#", "?", "/", backslash and whitespace are illegal in a Host header,
  // but URL.parse would silently strip userinfo/fragments/queries instead of
  // failing — so reject them up front and fail closed to the generic name.
  if (!host || /[@#?/\\\s]/.test(host)) return "omp web";
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
    return "omp web";
  }
  return isIP(hostname.startsWith("[") ? hostname.slice(1, -1) : hostname) ? "omp web" : hostname;
}
