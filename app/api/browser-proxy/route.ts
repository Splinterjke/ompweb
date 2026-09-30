import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const MAX_BROWSER_PREVIEW_BYTES = 2 * 1024 * 1024;

// Permissive CSP for proxied pages. The iframe that renders them is sandboxed
// (no allow-same-origin), so its origin is opaque and 'self' matches nothing —
// the policy must name http(s) sources explicitly. This header is scoped to
// the proxy response only; the app's own CSP (next.config.ts) stays strict.
// Without it, the iframe inherits the app CSP (script-src 'self' …) and every
// external script/stylesheet (gstatic.com, fonts, …) is refused — the
// "partly loaded" pages.
const PROXY_CSP = [
  "default-src https: http: data: blob: 'unsafe-inline'",
  "script-src 'unsafe-inline' 'unsafe-eval' https: http:",
  "style-src 'unsafe-inline' https: http:",
  "img-src data: blob: https: http:",
  "font-src data: https: http:",
  "connect-src ws: wss: https: http:",
  "frame-src https: http:",
  "media-src blob: https: http:",
  "base-uri https: http:",
  "form-action https: http:",
  "object-src 'none'",
].join("; ");

function validTarget(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // Never forward credentials or non-web schemes through a server endpoint.
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

// Errors render as a styled HTML page (never raw JSON) so a sandboxed iframe
// shows something readable instead of a JSON blob.
function htmlErrorPage(message: string, status: number): NextResponse {
  const safeMsg = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Preview failed</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; background: #14161a; color: #d8d8d8; }
  .error { text-align: center; padding: 24px; max-width: 480px; }
  .error h2 { color: #e57373; font-size: 17px; margin: 0 0 12px; }
  .error p { font-size: 13.5px; line-height: 1.5; margin: 0; opacity: 0.85; }
</style>
</head>
<body>
<div class="error">
  <h2>Preview failed</h2>
  <p>${safeMsg}</p>
</div>
</body>
</html>`;
  return new NextResponse(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": PROXY_CSP,
    },
  });
}

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("url");
  const target = raw ? validTarget(raw) : null;
  if (!target) return htmlErrorPage("A valid http(s) URL is required.", 400);

  try {
    const response = await fetch(target, {
      headers: { Accept: "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.2" },
      redirect: "follow",
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    });
    const contentType = response.headers.get("content-type") ?? "";
    const length = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(length) && length > MAX_BROWSER_PREVIEW_BYTES) {
      return htmlErrorPage("Page is too large to preview (limit: 2 MB).", 413);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_BROWSER_PREVIEW_BYTES) {
      return htmlErrorPage("Page is too large to preview (limit: 2 MB).", 413);
    }

    // Non-HTML payloads (PDF, images, …) pass through with their own content
    // type so the browser's native viewers handle them.
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      return new NextResponse(bytes, {
        status: response.status,
        headers: {
          "Content-Type": contentType || "application/octet-stream",
          "Cache-Control": "no-store",
          "Content-Security-Policy": PROXY_CSP,
        },
      });
    }

    let html = new TextDecoder().decode(bytes);
    const finalUrl = response.url || target.toString();
    const escapedBase = finalUrl.replace(/"/g, "&quot;");
    // <base href> pins relative URL resolution (scripts, styles, fetch('/…'))
    // to the original origin, so the page's own resources load from the site
    // instead of 404ing against the proxy path.
    html = /<head[\s>]/i.test(html)
      ? html.replace(/<head([^>]*)>/i, `<head$1><base href="${escapedBase}">`)
      : `<!doctype html><html><head><base href="${escapedBase}"></head><body>${html}</body></html>`;

    return new NextResponse(html, {
      status: response.status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": PROXY_CSP,
      },
    });
  } catch (error) {
    return htmlErrorPage(error instanceof Error ? error.message : String(error), 502);
  }
}
