import { spawn } from "child_process";

// Server-only: the client bundle (DirectoryPicker imports the pure helpers in
// git-clone.ts) must never pull child_process into it.

/** Runs `git clone`, streaming its output. Resolves the exit code, or null if
 *  git could not start. Never prompts: credentials must come from helpers/agents.
 *  On POSIX git leads its own session (no controlling terminal, so ssh fails
 *  fast on host-key or passphrase prompts instead of blocking on /dev/tty) and
 *  cancel signals the whole group: ssh/remote helpers hold the output pipes
 *  open, so killing git alone would leave the clone hanging until they exit. */
export function runGitClone(url: string, target: string, signal: AbortSignal, onOutput: (text: string) => void): Promise<number | null> {
  // Aborted while the target was being created: skip git; the caller cleans up.
  if (signal.aborted) return Promise.resolve(null);
  const { promise, resolve } = Promise.withResolvers<number | null>();
  const child = spawn("git", ["clone", "--progress", "--", url, target], {
    stdio: ["ignore", "pipe", "pipe"],
    // An empty GIT_ASKPASS also overrides core.askPass/SSH_ASKPASS fallbacks.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", GIT_ALLOW_PROTOCOL: "https:ssh" },
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const kill = () => {
    if (!child.pid) return;
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      return;
    }
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Group already gone.
    }
  };
  signal.addEventListener("abort", kill, { once: true });
  child.stdout.setEncoding("utf8").on("data", onOutput);
  child.stderr.setEncoding("utf8").on("data", onOutput);
  child.on("error", () => resolve(null));
  child.on("close", (code) => {
    signal.removeEventListener("abort", kill);
    resolve(code);
  });
  return promise;
}
