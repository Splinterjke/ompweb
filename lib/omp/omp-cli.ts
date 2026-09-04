import { execFile } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { delimiter, join } from "path";

/**
 * Locating and probing the user's installed `omp` CLI. omp-web never embeds
 * the (Bun-only) @oh-my-pi SDK — every live-agent capability goes through the
 * omp binary, so its absence is a first-class, user-visible state.
 */

let cachedBin: string | null = null;
let binMissAt = 0;
let cachedVersion: string | null = null;
let versionMissAt = 0;

// Windows installs vary: official binaries are `omp.exe`, npm/bun global
// installs ship `omp.cmd` (and a bare `omp` shim), so probe in that order.
const BIN_CANDIDATES = process.platform === "win32"
  ? ["omp.exe", "omp.cmd", "omp"]
  : ["omp"];
// Only successes are cached for the process lifetime. omp may be installed (or
// PATH repaired) while the server runs; a permanently cached "not found" would
// keep the UI reporting a missing binary until restart.
const MISS_TTL_MS = 30_000;

/** Clear probes after an explicit `omp update` so the next request rechecks it. */
export function invalidateOmpCliCache(): void {
  cachedBin = null;
  binMissAt = 0;
  cachedVersion = null;
  versionMissAt = 0;
}

function probeOmpBin(): string | null {
  const override = process.env.OMP_WEB_OMP_BIN;
  if (override) return existsSync(override) ? override : null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of BIN_CANDIDATES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  // GUI-launched processes often miss homebrew/bun dirs in PATH; probe the
  // usual install locations before giving up.
  const fallbackDirs = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".bun", "bin"),
    join(homedir(), ".local", "bin"),
  ];
  for (const dir of fallbackDirs) {
    for (const name of BIN_CANDIDATES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Resolve the omp binary: OMP_WEB_OMP_BIN override, then PATH lookup. Returns
 * null when omp is not installed. A hit is cached for the process lifetime; a
 * miss is re-probed after MISS_TTL_MS. */
export function resolveOmpBin(): string | null {
  // A global Bun/npm update can replace or remove its launcher while this
  // Next.js process is still alive. Never keep returning a stale cache entry.
  if (cachedBin && existsSync(cachedBin)) return cachedBin;
  cachedBin = null;
  if (Date.now() - binMissAt < MISS_TTL_MS) return null;
  const found = probeOmpBin();
  if (found) {
    cachedBin = found;
    binMissAt = 0;
    return found;
  }
  binMissAt = Date.now();
  return null;
}

/** `omp --version` output (e.g. "omp/17.1.3"), or null when unavailable.
 * Cached after the first successful probe; failures are retried after
 * MISS_TTL_MS so a later install is picked up without a server restart. */
export async function getOmpVersion(): Promise<string | null> {
  if (cachedVersion) return cachedVersion;
  if (Date.now() - versionMissAt < MISS_TTL_MS) return null;
  const bin = resolveOmpBin();
  if (!bin) {
    versionMissAt = Date.now();
    return null;
  }
  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(bin, ["--version"], { timeout: 10_000, windowsHide: true }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
    const version = output.trim();
    if (version) {
      cachedVersion = version;
      versionMissAt = 0;
      return version;
    }
  } catch {
    // Fall through to the miss path: retry after the TTL.
  }
  versionMissAt = Date.now();
  return null;
}

/**
 * PATH for child processes: the server's own PATH plus well-known install
 * locations that daemons, GUI launches, and container launchers often miss.
 * The scheduler spawns user scripts (e.g. `npm run build`) with this
 * repaired PATH so `npm`/`npx` resolve even when the launcher environment
 * is minimal. Order: existing entries first, extras appended, duplicates
 * dropped — applying it to an already-repaired PATH is a no-op.
 */
const CHILD_PATH_EXTRA_DIRS = [
  "/opt/node24/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  join(homedir(), ".bun", "bin"),
  join(homedir(), ".local", "bin"),
];

export function repairedChildPath(base: string | undefined): string {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const dir of [...(base ?? "").split(delimiter), ...CHILD_PATH_EXTRA_DIRS]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs.join(delimiter);
}
