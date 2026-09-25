import { restoreActiveRpcSessions } from "@/lib/rpc-manager";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Warm the effective network proxy into the process env before the first
  // omp spawn / GitHub request: Bun's fetch (omp) and undici (GitHub client)
  // ignore the system proxy without TUN mode, so we resolve the configured
  // proxy (auto-detected or manual) once at startup. Lives here, not in
  // next.config.ts — that file must stay free of app-code imports (it is
  // transpiled outside the app bundle where lib/ does not exist).
  void (async () => {
    try {
      const { resolveEffectiveProxy } = await import("@/lib/proxy-config");
      const url = await resolveEffectiveProxy();
      if (url) process.env.OMP_WEB_PROXY_URL = url;
    } catch {
      // Best-effort; lib/proxy-config consumers resolve on demand too.
    }
  })();

  // Honor HTTP(S)_PROXY/NO_PROXY for server-side fetch (update checks, skill
  // search, model connection tests). Node's built-in fetch ignores proxy env
  // vars (NODE_USE_ENV_PROXY is Node 24+ only; engines floor is 22).
  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  // Startup diagnostics: agent dir. Kept to one line so it greps cleanly;
  // failures here must never block boot.
  try {
    const { getAgentDir } = await import("@/lib/session-reader");
    console.log(
      `[omp-web] starting (agent-dir ${getAgentDir()})`,
    );
  } catch {
    // Diagnostics are best-effort.
  }

  // A service restart tears down the in-memory RPC registry. The previous
  // process snapshots its live sessions during SIGTERM; recreate those omp
  // children before serving so conversations continue without a browser turn.
  try {
    await restoreActiveRpcSessions();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[omp-web] active-session restore failed: ${detail}`);
  }
  // Ship the repo's rebuild script in "Script schedulers" (manual launch) on
  // first boot. Best-effort: a packaged install without the script skips it,
  // and a pre-existing entry is never duplicated. scheduler-store is
  // node-only (fs/os/path) and this file is also bundled for the edge
  // runtime, so it is imported dynamically like the other node-only deps.
  try {
    const { ensureSeedSchedulers } = await import("@/lib/scheduler-store");
    ensureSeedSchedulers();
  } catch (error) {
    console.warn(`[omp-web] scheduler seed skipped: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Warm the shared utility omp process so the first models/auth request does
  // not pay the multi-second cold spawn (measured 1.2-4s on a real install).
  // Fire-and-forget: register() must not block boot, and a missing omp binary
  // is reported per-request by the routes — log once here and move on.
  // The shared process registers its own SIGINT/SIGTERM/exit disposal hook on
  // first use (lib/omp/rpc-utility.ts), as the session registry does.
  void (async () => {
    try {
      const { runUtilityCommand } = await import("@/lib/omp/rpc-utility");
      await runUtilityCommand({ type: "get_state" });
      const { getOmpVersion } = await import("@/lib/omp/omp-cli");
      const version = await getOmpVersion();
      console.log(`[omp-web] omp utility ready (${version ?? "version unknown"})`);
    } catch (error) {
      const { resolveOmpBin } = await import("@/lib/omp/omp-cli");
      const bin = resolveOmpBin();
      const detail = error instanceof Error ? error.message : String(error);
      const hint = bin
        ? `resolved ${bin}; repair with: omp update (or: bun install -g @oh-my-pi/pi-coding-agent@latest)`
        : "omp binary not found; install oh-my-pi or set OMP_WEB_OMP_BIN";
      console.warn(`[omp-web] omp utility warm-up failed (routes will retry on demand): ${detail} — ${hint}`);
    }
  })();

  // Crash/stall journal: a long-running server that dies or wedges while the
  // user is away leaves no trace in a terminal that no longer exists (CLI
  // runs are killed with their terminal; pages then show endless loading
  // until the process is restarted). Append fatal errors and event-loop
  // stalls to a file so the next incident explains itself. Node's default
  // crash semantics are preserved — this only adds the record before exiting.
  // fs/path are node-only and this file is also bundled for the edge runtime,
  // so they are imported dynamically like the other node-only deps.
  const { appendFileSync, mkdirSync, renameSync, statSync } = await import("fs");
  const { join } = await import("path");
  const { getConfigRoot } = await import("@/lib/omp/paths");
  const logDir = join(getConfigRoot(), "omp-web");
  const logPath = join(logDir, "diagnostics.log");
  const appendDiag = (kind: string, detail: string) => {
    try {
      mkdirSync(logDir, { recursive: true });
      try {
        if (statSync(logPath).size > 1_000_000) renameSync(logPath, `${logPath}.old`);
      } catch {
        // First write or unreadable — append anyway.
      }
      appendFileSync(logPath, `${new Date().toISOString()} [${kind}] ${detail}\n`, { encoding: "utf8" });
    } catch {
      // Diagnostics must never crash the server.
    }
  };
  const describe = (value: unknown) =>
    value instanceof Error ? `${value.name}: ${value.message}\n${value.stack ?? ""}` : String(value);
  process.on("uncaughtException", (error) => {
    appendDiag("crash", `uncaughtException ${describe(error)}`);
    // An uncaughtException listener suppresses Node's default exit; keep the
    // crash-visible semantics by exiting explicitly.
    process.exit(2);
  });
  process.on("unhandledRejection", (reason) => {
    appendDiag("crash", `unhandledRejection ${describe(reason)}`);
    // Same as above: preserve Node's crash-on-unhandled-rejection default.
    process.exit(2);
  });
  let lastTick = Date.now();
  let lastCpu = process.cpuUsage();
  const watchdog = setInterval(() => {
    const now = Date.now();
    const cpu = process.cpuUsage();
    const drift = now - lastTick;
    const cpuMs = (cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1000;
    lastTick = now;
    lastCpu = cpu;
    if (drift > 45_000) {
      // Wall-clock drift alone cannot tell a blocked loop from a sleeping
      // machine: an hour with the lid closed looks like an hour-long stall
      // but burns no CPU. Label accordingly so the journal does not mislead
      // the next long-idle investigation.
      const seconds = Math.round(drift / 1000);
      if (cpuMs < Math.min(5_000, drift / 2)) {
        appendDiag("sleep", `event loop gap of ~${seconds}s with negligible CPU time — machine was asleep/suspended or CPU-starved, not a synchronous block`);
      } else {
        appendDiag("stall", `event loop unresponsive for ~${seconds}s — a synchronous operation is blocking every request`);
      }
    }
  }, 15_000);
  watchdog.unref?.();
}
