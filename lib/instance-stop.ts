/** Stopping a neighboring ompweb instance from the diagnostics panel. The
 * listener, not the kill call, is the oracle everywhere here: Windows taskkill
 * exits nonzero both for an already-gone process and for a refused elevated
 * one, and POSIX SIGTERM needs its escalation window — so a stop is only
 * reported once the port itself stopped answering. */

import { execFileSync } from "node:child_process";

/** The pid listening on the given TCP port, or null when nothing listens.
 * POSIX: lsof. Windows: `netstat -ano`, parsed on the numeric columns only —
 * the connection-state column is localized (a non-English build prints its
 * own word for LISTENING) while protocol, addresses and pids stay ASCII, and
 * a listener row is the one whose remote side is port 0. */
export function pidOnPort(port: number): number | null {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano"], {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      for (const line of out.split("\n")) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 5 || !/^tcp6?$/i.test(cols[0])) continue;
        if (!cols[1].endsWith(`:${port}`) || !/:0$/.test(cols[2])) continue;
        const pid = Number(cols[4]);
        if (Number.isInteger(pid) && pid > 0) return pid;
      }
      return null;
    }
    const out = execFileSync("lsof", ["-ti", `TCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pid = Number(out.trim().split("\n")[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Stop one instance process for good. On Windows the whole tree is taken
 * from the farthest ompweb-named ancestor — the supervised deploy is
 * supervisor → launcher node → Bun child, and killing only the port listener
 * lets the relauncher take the port back within seconds — and falls back to
 * the listener itself when no ancestor names ompweb, so an unrelated parent
 * chain (a plain terminal hosting some other server) is never taken down.
 * POSIX escalates SIGTERM to SIGKILL. */
export async function terminateInstanceProcess(pid: number): Promise<void> {
  if (process.platform === "win32") {
    const root = windowsInstanceRoot(pid);
    // taskkill's output is localized console-codepage text; callers judge
    // against the port, so it is discarded here.
    try {
      execFileSync("taskkill", ["/PID", String(root), "/T", "/F"], { stdio: "ignore", timeout: 8000, windowsHide: true });
    } catch { /* already gone or refused — the port check decides */ }
    return;
  }
  process.kill(pid, "SIGTERM");
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 1200);
  await promise;
  try {
    process.kill(pid, 0);
    process.kill(pid, "SIGKILL");
  } catch { /* already gone */ }
}

/** Poll until nothing listens on the port anymore, up to the budget. */
export async function waitForPortRelease(port: number, budgetMs: number): Promise<boolean> {
  for (let waited = 0; ; waited += 750) {
    if (pidOnPort(port) === null) return true;
    if (waited >= budgetMs) return false;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, Math.min(750, budgetMs - waited));
    await promise;
  }
}

/** Walk the Windows process ancestry from `pid` upward and return the
 * farthest ancestor whose command line names ompweb (the deploy's powershell
 * supervisor, the `omp-web.js` launcher, or the Bun server child), so one
 * tree-kill stops the instance for good; `pid` itself when none matches. */
function windowsInstanceRoot(pid: number): number {
  try {
    const script = [
      `$p=${pid}`,
      "while($p){",
      '$q=Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue;',
      "if(-not $q){break}",
      '"{0}`t{1}" -f $q.ProcessId,$q.CommandLine',
      "$p=$q.ParentProcessId}",
    ].join("");
    const out = execFileSync("powershell", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let root = pid;
    for (const line of out.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const ancestorPid = Number(line.slice(0, tab));
      const commandLine = line.slice(tab + 1);
      if (!Number.isInteger(ancestorPid) || ancestorPid <= 0 || ancestorPid === process.pid) continue;
      if (/omp[-_]?web/i.test(commandLine) || /\bsupervise\b/i.test(commandLine)) root = ancestorPid;
    }
    return root;
  } catch {
    return pid;
  }
}
