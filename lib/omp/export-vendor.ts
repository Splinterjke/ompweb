import { readFileSync } from "fs";
import { join } from "path";

/**
 * The session-export HTML produced by `omp --export` (see
 * app/api/sessions/[id]/export/route.ts) loads two libraries from cdnjs:
 *
 *   <script src="https://cdnjs.cloudflare.com/ajax/libs/marked/15.0.4/marked.min.js" ...></script>
 *   <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js" ...></script>
 *
 * The global CSP (next.config.ts) allows only `script-src 'self' 'unsafe-inline'
 * 'unsafe-eval'`, so the browser blocks those remote scripts. The page's boot
 * script then throws `marked is not defined` and no session entries are ever
 * rendered — the export page opens blank.
 *
 * To keep the export self-contained (it must work inline under the CSP, as a
 * downloaded file, and offline), each CDN <script> tag is replaced with an
 * inline copy of the same library, vendored under public/vendor/.
 */

const VENDOR_DIR = join(process.cwd(), "public", "vendor");

const CDN_SCRIPT_RE =
  /<script\b[^>]*src="https:\/\/[^"']*\/(marked|highlight\.js)\/[^"']*"[^>]*>\s*<\/script>/g;

const VENDOR_FILE: Record<string, string> = {
  marked: "marked.min.js",
  "highlight.js": "highlight.min.js",
};
const vendorCache: Record<string, string> = {};

function vendorScript(file: string): string {
  if (!(file in vendorCache)) {
    vendorCache[file] = readFileSync(join(VENDOR_DIR, file), "utf8");
  }
  return vendorCache[file];
}

/**
 * Replace every cdnjs <script> tag for a known export dependency with an
 * inline <script> carrying the vendored copy. HTML without such tags (or with
 * tags we do not recognize) is returned unchanged, so a future `omp` template
 * change degrades to the previous behavior instead of breaking the page.
 */
export function inlineExportVendorScripts(html: string): string {
  return html.replace(CDN_SCRIPT_RE, (_tag, lib: string) => {
    const file = VENDOR_FILE[lib];
    if (!file) return _tag;
    return `<script>${vendorScript(file)}</script>`;
  });
}
