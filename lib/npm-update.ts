import { execFile } from "child_process";
import packageJson from "../package.json";
import { homedir } from "os";
import { join, normalize, sep } from "path";
import { isUpdateDisabled } from "./update-policy";
// Type-only: the ProxyAgent itself is imported lazily (below) so this module
// stays importable from the host-update fixtures' disposable releases, which
// carry no node_modules.
import type { ProxyAgent } from "undici";

const NPM_PACKAGE = "@Splinterjke/ompweb";
const RELEASES_URL = "https://github.com/Splinterjke/ompweb/releases/latest";
const CHECK_TTL_MS = 60 * 60 * 1000;

// The registry check must honor the app's resolved proxy (warm-up in
// instrumentation.ts): on hosts where the registry is only reachable through
// a local proxy, Node's plain fetch cannot connect and the update card would
// always show a failed check. Same pattern as lib/github.ts. Without a proxy
// the plain global fetch is used, and the undici agent loads lazily so the
// module graph never requires undici where no proxy is configured.
let cachedProxyAgent: Promise<ProxyAgent | null> | undefined;
async function proxyDispatcher(): Promise<ProxyAgent | undefined> {
  const url = process.env.OMP_WEB_PROXY_URL;
  if (!url) return undefined;
  cachedProxyAgent ??= import("undici")
    .then(({ ProxyAgent }) => new ProxyAgent(url))
    .catch(() => null);
  return (await cachedProxyAgent) ?? undefined;
}

export interface NpmUpdateStatus {
  currentVersion: string;
  availableVersion: string | null;
  updateAvailable: boolean;
  /** "binary": the compiled release (scripts/build-binary.ts), which updates by download, not by a package manager. */
  installMethod: "npm" | "bun" | "binary";
  /** True when OMP_WEB_DISABLE_AUTOUPDATE is set; the UI shows "updates disabled". */
  updatesDisabled?: boolean;
  updateCommand: string;
  /** True when the registry check itself failed (network/proxy); the UI
   *  should not claim "up to date" in that case. */
  checkError?: boolean;
  /** Server boot epoch (ms). The client latches it once to show the
   *  "OmpWeb started" notice exactly once per server boot. */
  startedAt: number;
  /** True whenever the server has started (always, right now) — carried so
   *  the client's startup-notice path is explicit rather than implicit. */
  justStarted: boolean;
  /** True when this boot was a rebuild (a new build was deployed + restarted).
   *  Lets the client show "OmpWeb updated" (with a Refresh button) instead of
   *  the plain "OmpWeb started". */
  updated?: boolean;
 }

let cached: { checkedAt: number; status: NpmUpdateStatus } | null = null;

function parseVersion(version: string): { parts: number[]; prerelease: boolean } | null {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)(-.+)?$/);
  if (!match) return null;
  return { parts: match.slice(1, 4).map(Number), prerelease: Boolean(match[4]) };
}

export function isNewerVersion(availableVersion: string, currentVersion: string): boolean {
  const available = parseVersion(availableVersion);
  const current = parseVersion(currentVersion);
  if (!available || !current) return false;

  for (let index = 0; index < available.parts.length; index += 1) {
    if (available.parts[index] !== current.parts[index]) {
      return available.parts[index] > current.parts[index];
    }
  }
  return !available.prerelease && current.prerelease;
}

// Server boot epoch: the "OmpWeb started" notice shows once per process boot,
// independent of the npm version (a rebuild may not bump the version).
export const SERVER_STARTED_AT = Date.now();

export async function checkNpmUpdate(force = false): Promise<NpmUpdateStatus> {
  const currentVersion = packageJson.version;
  const packageDir = process.env.OMP_WEB_PACKAGE_DIR ?? process.cwd();
  // Bun.isStandaloneExecutable exists only in the compiled release; under Node (tests,
  // legacy tooling) there is no Bun global at all, so probe it through globalThis.
  const standalone = (globalThis as unknown as { Bun?: { isStandaloneExecutable?: boolean } }).Bun?.isStandaloneExecutable === true;
  const installMethod = standalone ? "binary" as const : detectInstallMethod(packageDir);
  const updateCommand = installMethod === "binary" ? RELEASES_URL : installMethod === "bun" ? "bun add -g @Splinterjke/ompweb" : "npm install -g @Splinterjke/ompweb";

  // Opt-out: OMP_WEB_DISABLE_AUTOUPDATE skips the registry round-trip and
  // never reports an available update, even if a stale cache claims one.
  if (isUpdateDisabled()) {
    return {
      currentVersion,
      availableVersion: null,
      updateAvailable: false,
      installMethod,
      updateCommand,
      updatesDisabled: true,
      startedAt: SERVER_STARTED_AT,
      justStarted: true,
    };
  }

  if (!force && cached && Date.now() - cached.checkedAt < CHECK_TTL_MS) return cached.status;

  const base = { currentVersion, updateCommand, startedAt: SERVER_STARTED_AT, justStarted: true };
  try {
    const dispatcher = await proxyDispatcher();
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(NPM_PACKAGE)}/latest`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
      ...(dispatcher ? { dispatcher } : {}),
    });
    const data = response.ok ? await response.json() as { version?: unknown } : null;
    const availableVersion = typeof data?.version === "string" ? data.version : null;
    const status: NpmUpdateStatus = {
      ...base,
      availableVersion,
      updateAvailable: Boolean(availableVersion && isNewerVersion(availableVersion, currentVersion)),
      installMethod,
    };
    cached = { checkedAt: Date.now(), status };
    return status;
  } catch {
    return { ...base, installMethod, availableVersion: null, updateAvailable: false, checkError: true };
  }
}

/** Which package manager owns a given install dir, so updates always run
 * through the manager that manages it (bun global root, npm global root,
 * anything else → npm as the fallback). Separators are normalized so the
 * classification is deterministic even when a Windows-style path is passed
 * on a POSIX host (e.g. in CI tests). */
export function detectInstallMethod(packageDir: string): "bun" | "npm" {
  const toPlatformPath = (value: string): string => normalize(value).replaceAll("\\", sep);
  const normalized = toPlatformPath(packageDir);
  const bunRoots = [
    // bun 1.3.x globals on Windows live in ~/node_modules; POSIX uses the
    // standard ~/.bun/install/global/node_modules.
    join(process.env.USERPROFILE ?? process.env.HOME ?? "", "node_modules"),
    join(homedir(), ".bun", "install", "global", "node_modules"),
  ].map(toPlatformPath);
  return bunRoots.some((root) => normalized.startsWith(root + sep)) ? "bun" : "npm";
}

/** Installs the latest npm release through the detected package manager.
 *  Returns the command output; the running server needs a restart afterwards
 *  to pick up the new code. */
export async function runNpmUpdate(): Promise<string> {
  const packageDir = process.env.OMP_WEB_PACKAGE_DIR ?? process.cwd();
  const method = detectInstallMethod(packageDir);
  // Literal executables + literal argv only — the method is a fixed enum, so
  // no externally influenced string reaches execFile.
  if (method !== "bun" && method !== "npm") throw new Error(`Unknown install method: ${String(method)}`);
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const execOptions = {
    timeout: 600_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  };
  const callback = (error: Error | null, stdout: string, stderr: string) => {
    if (error) reject(new Error((stderr || stdout || error.message).trim().slice(-1000)));
    else resolve(`${stdout}\n${stderr}`.trim());
  };
  // npm refuses to overwrite an existing global bin shim (EEXIST) after a
  // manual install; --force makes re-running the updater idempotent.
  if (method === "bun") execFile("bun", ["add", "-g", NPM_PACKAGE], execOptions, callback);
  else execFile("npm", ["install", "-g", "--force", NPM_PACKAGE], execOptions, callback);
  return promise;
}

