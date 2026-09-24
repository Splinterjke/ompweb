import { execFile, execFileSync, spawn } from "child_process";
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ProxyAgent, request } from "undici";
import { resolveOmpBin, wrapWindowsScript } from "./omp-cli";
import { proxyEnv, readProxyConfig, resolveEffectiveProxy } from "../proxy-config";
import { isUpdateDisabled } from "../update-policy";

const OMP_RELEASE_ASSET_URL = "https://github.com/can1357/oh-my-pi/releases/latest/download/{tag}";

function ompAssetName(): string {
  const osName = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const archName = process.arch === "arm64" ? "arm64" : "x64";
  const exe = process.platform === "win32" ? ".exe" : "";
  return "omp-" + osName + "-" + archName + exe;
}

export interface OmpUpdateStatus {
  currentVersion: string | null;
  availableVersion: string | null;
  updateAvailable: boolean;
  updateCommand: string;
  /** True when OMP_WEB_DISABLE_AUTOUPDATE is set; the UI shows "updates disabled". */
  updatesDisabled?: boolean;
}

/**
 * Stream `omp update` output lines as they arrive (live progress UI).
 * The effective proxy (system / manual / common local ports) is injected
 * into the child env — without it, GitHub downloads die with a closed-socket
 * error behind a non-TUN proxy (omp/Bun fetch ignores HTTPS_PROXY). A failed
 * attempt is retried once; if both fail, the release asset is downloaded
 * through the proxy ourselves (curl first, undici ProxyAgent second) and
 * installed atomically with a backup/rollback.
 */
export async function runOmpUpdateStream(args: string[], onLine?: (line: string) => void): Promise<{ exitCode: number; output: string }> {
  const bin = resolveOmpBin();
  if (!bin) throw new Error("omp binary not found. Install oh-my-pi or set OMP_WEB_OMP_BIN.");
  const proxyUrl = await resolveEffectiveProxy().catch(() => null);
  const env = {
    ...process.env,
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    ...proxyEnv(proxyUrl),
  };
  onLine?.("[omp-web] Proxy: " + (proxyUrl ?? "not detected (direct)") + " — injected into the update command environment");
  const attemptOnce = (): Promise<{ exitCode: number; output: string }> => new Promise((resolve, reject) => {
    const target = wrapWindowsScript(bin, ["update", ...args]);
    const child = spawn(target.file, target.args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let pending = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      reject(new Error("omp update timed out after 300s"));
    }, 300_000);
    const push = (text: string) => {
      output += text;
      pending += text;
      let index: number;
      while ((index = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, index).replace(/\r$/, "");
        pending = pending.slice(index + 1);
        if (line.trim()) onLine?.(line);
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => push(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => push(chunk.toString()));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (pending.trim()) onLine?.(pending.trim());
      resolve({ exitCode: code ?? 1, output: output.trim() });
    });
  });
  const first = await attemptOnce();
  if (first.exitCode === 0) return first;
  onLine?.("[omp-web] Update failed (exit code " + first.exitCode + "); auto-retrying once in 1.2s…");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const second = await attemptOnce();
  if (second.exitCode === 0) return second;
  onLine?.("[omp-web] Auto-fallback: downloading and installing the binary via proxy…");
  const installed = await downloadOmpBinaryViaProxy(proxyUrl, onLine).catch((error) => {
    onLine?.("[omp-web] Proxy download failed: " + (error instanceof Error ? error.message : String(error)));
    return false;
  });
  return { exitCode: installed ? 0 : second.exitCode, output: (second.output || first.output) };
}

/**
 * Download the omp release asset through the effective proxy and atomically
 * replace the current binary (backup + rollback on verification failure).
 * curl is the primary transport (proven against the CDN behind the proxy);
 * undici ProxyAgent is the fallback for environments without curl.
 */
async function downloadOmpBinaryViaProxy(proxyUrl: string | null, onLine?: (line: string) => void): Promise<boolean> {
  const binPath = resolveOmpBin();
  if (!binPath) return false;
  const assetUrl = OMP_RELEASE_ASSET_URL.replace("{tag}", ompAssetName());
  const tempFile = join(tmpdir(), "omp-download-" + process.pid);
  let downloaded = Buffer.alloc(0);
  onLine?.("[omp-web] Downloading via curl through proxy: " + assetUrl + " …");
  const viaCurl = await new Promise<boolean>((resolve) => {
    const args = ["-sSL", "--fail", "-o", tempFile];
    if (proxyUrl) args.push("-x", proxyUrl);
    args.push(assetUrl);
    execFile("curl", args, { timeout: 300_000 }, (error, _stdout, stderr) => {
      if (error) {
        onLine?.("[omp-web] curl download failed: " + String(stderr || error.message).slice(0, 300));
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
  if (viaCurl && existsSync(tempFile)) {
    downloaded = readFileSync(tempFile);
    onLine?.("[omp-web] curl download complete: " + Math.round(downloaded.length / 1024 / 1024) + " MB");
  } else {
    onLine?.("[omp-web] Falling back to undici ProxyAgent download…");
    const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
    let assetUrlFinal = assetUrl;
    let response = await request(assetUrlFinal, { dispatcher, headersTimeout: 30_000 });
    for (let redirects = 0; redirects < 5 && response.statusCode >= 300 && response.statusCode < 400; redirects++) {
      const location = response.headers.location;
      if (typeof location !== "string" || !location) break;
      assetUrlFinal = location;
      response = await request(assetUrlFinal, { dispatcher, headersTimeout: 30_000 });
    }
    if (response.statusCode !== 200) throw new Error("HTTP " + response.statusCode);
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buffer);
      received += buffer.length;
    }
    downloaded = Buffer.concat(chunks);
  }
  if (downloaded.length < 1024 * 1024) throw new Error("downloaded asset too small: " + downloaded.length);
  const backup = binPath + ".bak-ompweb";
  if (!existsSync(backup)) copyFileSync(binPath, backup);
  writeFileSync(tempFile, downloaded);
  chmodSync(tempFile, 0o755);
  renameSync(tempFile, binPath);
  onLine?.("[omp-web] Replaced " + binPath + ", verifying new binary…");
  try {
    const version = execFileSync(binPath, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
    onLine?.("[omp-web] Verified: " + version);
    return true;
  } catch {
    if (existsSync(backup)) {
      copyFileSync(backup, binPath);
      onLine?.("[omp-web] New binary verification failed; restored the previous version");
    }
    return false;
  }
}
async function runOmpUpdate(args: string[]): Promise<string> {
  const bin = resolveOmpBin();
  if (!bin) throw new Error("omp binary not found. Install oh-my-pi or set OMP_WEB_OMP_BIN.");
  // The updater downloads from GitHub; a configured web proxy (FlClash etc.)
  // must be visible to it or the fetch dies with a closed-socket error.
  const proxyUrl = await resolveEffectiveProxy().catch(() => null);
  const env = {
    ...process.env,
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    ...proxyEnv(proxyUrl),
  };
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const target = wrapWindowsScript(bin, ["update", ...args]);
  execFile(target.file, target.args, {
    timeout: 300_000,
    maxBuffer: 1024 * 1024,
    env,
    windowsHide: true,
  }, (error, stdout, stderr) => {
    if (error) reject(new Error((stderr || stdout || error.message).trim().slice(-1000)));
    else resolve(`${stdout}\n${stderr}`.trim());
  });
  return promise;
}

export function parseOmpUpdateStatus(output: string): OmpUpdateStatus {
  const currentVersion = output.match(/^Current version:\s*(\S+)/mi)?.[1] ?? null;
  const availableVersion = output.match(/^New version available:\s*(\S+)/mi)?.[1] ?? null;
  return {
    currentVersion,
    availableVersion,
    updateAvailable: availableVersion !== null,
    updateCommand: "omp update",
  };
}

export async function checkOmpUpdate(): Promise<OmpUpdateStatus> {
  if (isUpdateDisabled()) {
    return {
      currentVersion: null,
      availableVersion: null,
      updateAvailable: false,
      updateCommand: "omp update",
      updatesDisabled: true,
    };
  }
  return parseOmpUpdateStatus(await runOmpUpdate(["--check"]));
}

/** Runs the real `omp update` (installs the newer version) and returns the
 *  command output. Callers restart RPC sessions afterwards. */
export async function runOmpUpdateNow(): Promise<string> {
  return runOmpUpdate([]);
}

