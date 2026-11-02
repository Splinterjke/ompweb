import { resolveOmpBin, getOmpVersion } from "@/lib/omp/omp-cli";
import { readProxyConfig, resolveEffectiveProxy } from "@/lib/proxy-config";
import { recentRpcFailures } from "@/lib/rpc-manager";
import { localHostRow } from "@/lib/hosts/hub";
import { isLinkUp } from "@/lib/hosts/host";
import { clearBackendErrors, recentBackendErrors } from "@/lib/backend-errors";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { getConfigRoot, getAgentDir, getSessionsDir, getSettingsPath, getModelsConfigPath } from "@/lib/omp/paths";


/**
 * GET /api/diagnostics — backend service health for the settings panel:
 * omp runtime, network proxy, RPC sessions, server identity.
 */
export async function GET() {
  const ompBin = resolveOmpBin();
  const ompVersion = await getOmpVersion();
  const proxyConfig = readProxyConfig();
  const effectiveProxy = await resolveEffectiveProxy();
  const rpcSessionCount = getRpcSessionIds().length;
  const activeRpc = rpcSessionCount;
  const webPort = process.env.OMP_WEB_PORT ?? process.env.OMP_WEB_APP_PORT
    ?? process.env.PORT
    ?? (process.env.NODE_ENV === "production" ? "30177" : "30178");

  // RPC 健康信号：最近 60s 内的 omp 子进程异常退出 / 会话分裂——这些直接
  // 导致"消息发不出去"，必须纳入健康判断（仅看 omp 是否安装是不够的）。
  const recentFailures = recentRpcFailures(60_000);

  // 其他 ompweb 实例探测：旧实例（残留的开发服务/旧 app）会持有会话锁、
  // 扰乱 --resume，是"服务异常但健康显示正常"的主要来源。扫描本机常见端口。
  const selfPort = Number(webPort);
  const otherInstances: Array<{ port: number; alive: boolean }> = [];
  // Include the historical dev ports as well: a leftover server on one of
  // them can still hold session locks beside the current instance.
  for (const port of [30177, 30178, 30179, 30180]) {
    if (port === selfPort) continue;
    otherInstances.push({ port, alive: await probeOmpWebPort(port) });
  }

  // Installer dependency probes (ompSetup): which download/exec tools exist on
  // this host. The wizard uses these to suggest alternatives when e.g. curl
  // is absent. Never blocks: a probe failure simply marks the tool missing.
  const tools = {
    curl: hasTool("curl"),
    wget: hasTool("wget"),
    powershell: hasTool("powershell") || hasTool("pwsh"),
    bun: hasTool("bun"),
    node: hasTool("node"),
  };

  // This machine's host daemon (the `ompweb host` link, `lib/hosts`): every
  // omp child runs under it, so the topology card shows the real chain
  // server → WebSocket link → daemon → omp children.
  const localHost = localHostRow();

  return Response.json({
    server: {
      // Bun runs the server (`process.versions.bun`); `node` stays for the
      // Node-emulation version and for any non-Bun launch form.
      node: process.version,
      bun: process.versions.bun ?? null,
      platform: process.platform,
      arch: process.arch,
      uptimeSeconds: Math.round(process.uptime()),
      tools,
    },
    daemon: {
      linked: isLinkUp(localHost.status),
      status: localHost.status,
      daemonManaged: localHost.daemonManaged,
      hostVersion: localHost.hostVersion,
    },
    omp: {
      installed: Boolean(ompBin),
      path: ompBin,
      version: ompVersion,
    },
    proxy: {
      config: proxyConfig,
      effective: effectiveProxy,
    },
    rpc: {
      activeSessions: activeRpc,
      recentFailures: recentFailures.map((f) => f.detail),
    },
    // Backend failures recorded by lib/backend-errors.ts — the App-level
    // visible error feed for the banner and diagnostics panel.
    backendErrors: recentBackendErrors().map((e) => ({ at: e.at, kind: e.kind, detail: e.detail })),
    instances: {
      selfPort,
      others: otherInstances.filter((instance) => instance.alive).map((instance) => instance.port),
    },
    web: {
      port: webPort,
      url: `http://127.0.0.1:${webPort}`,
    },
    system: {
      memory: {
        rss: process.memoryUsage().rss,
        heapUsed: process.memoryUsage().heapUsed,
        heapTotal: process.memoryUsage().heapTotal,
      },
      cpus: os.cpus()?.length ?? 1,
      hostname: os.hostname(),
    },
    paths: {
      ompBin: ompBin ?? null,
      configRoot: getConfigRoot(),
      agentDir: getAgentDir(),
      sessionsDir: getSessionsDir(),
      settingsPath: getSettingsPath(),
      modelsPath: getModelsConfigPath(),
    },
  });
}

/** POST /api/diagnostics  { action: "clear" } — explicit dismissal of the
 * recorded backend errors (Phase 1). Intentionally manual: errors never clear
 * on a timer, only after the user acknowledges or a recovery action succeeded
 * (the restart route clears them too). */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as { action?: string };
    if (body.action !== "clear") {
      return Response.json({ error: "unknown action", code: "unknown_action" }, { status: 400 });
    }
    clearBackendErrors();
    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

/** 探测本机另一端口上是否有 ompweb 服务（快速 GET，1s 超时）。
 * Use the non-recursive health endpoint: probing /api/diagnostics here would
 * make two ompweb instances call each other's diagnostics routes recursively,
 * multiplying latency whenever both dev and packaged App are running. */
async function probeOmpWebPort(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

function hasTool(name: string): boolean {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(cmd, [name], { stdio: "ignore", timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

function getRpcSessionIds(): string[] {
  try {
    // rpc-manager keeps the registry private; expose via getRunningRpcSessionIds.
    return getRunningRpcSessionIds();
  } catch {
    return [];
  }
}

// Import lazily to avoid circular imports at module load.
import { getRunningRpcSessionIds } from "@/lib/rpc-manager";
