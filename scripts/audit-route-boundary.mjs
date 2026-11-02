// Route boundary gate: production API routes must not reach domain
// authorities directly — no OMP process construction, no node-pty. Allowed
// exceptions are registered with the reason they are exempt.
//
//   node scripts/audit-route-boundary.mjs [--check]
//
// `--check` (used by the test suite) fails with exit 1 on any non-allowlisted
// finding.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const ROUTE_AUTHORITY_MARKERS = [
  {
    marker: "new RpcProcess(",
    description: "route directly spawns OMP (bypasses the rpc-manager / host-daemon seam)",
  },
  {
    marker: "node-pty",
    description: "route directly creates a PTY (must go through lib/terminal-session-manager)",
  },
];

/** Files that may contain the markers above, with the reason. */
const ROUTE_ALLOWLIST = [
  {
    file: "app/api/auth/login/[provider]/route.ts",
    reasons: ["auth login is an interactive stream (extension_ui_request two-way UI); it runs through the shared utility omp, the one deliberate direct-spawn exception (lib/omp/rpc-utility.ts)"],
  },
];

/** Scan app/api route files for direct authority markers. */
export function auditRouteBoundary({ productionRoot = root } = {}) {
  const problems = [];
  const apiDir = join(productionRoot, "app", "api");
  const routeFiles = [];
  collectRouteFiles(apiDir, routeFiles);
  for (const file of routeFiles) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const rel = file.slice(productionRoot.length + 1).replaceAll("\\", "/");
    const allowlisted = ROUTE_ALLOWLIST.find((entry) => entry.file === rel);
    for (const { marker, description } of ROUTE_AUTHORITY_MARKERS) {
      if (!text.includes(marker)) continue;
      if (allowlisted) {
        problems.push(`(allowlisted) ${rel}: contains "${marker}" — ${allowlisted.reasons.join("; ")}`);
        continue;
      }
      problems.push(`${rel}: contains "${marker}" — ${description}`);
    }
  }
  return {
    ok: problems.every((p) => p.startsWith("(allowlisted)")),
    problems,
  };
}

function collectRouteFiles(dir, out) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectRouteFiles(full, out);
    else if (entry.name === "route.ts") out.push(full);
  }
}

// CLI
if (process.argv[1] && process.argv[1].endsWith("audit-route-boundary.mjs")) {
  const result = auditRouteBoundary();
  for (const p of result.problems) console.error("route-boundary: " + p);
  console.log(result.ok ? "route-boundary: OK" : "route-boundary: FAIL");
  if (!result.ok) process.exit(1);
}
