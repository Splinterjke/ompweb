import { checkOmpUpdate, runOmpUpdateNow, runOmpUpdateStream } from "@/lib/omp/updates";
import { pidOnPort, terminateInstanceProcess, waitForPortRelease } from "@/lib/instance-stop";
import { invalidateOmpCliCache } from "@/lib/omp/omp-cli";
import { clearRpcFailures, restartAllRpcSessions } from "@/lib/rpc-manager";
import { isUpdateDisabled } from "@/lib/update-policy";


export async function POST(request: Request, { disableIdleTimeout }: { disableIdleTimeout: () => void }) {
  try {
    const body = await request.json() as { action?: unknown; stream?: unknown; port?: unknown };
    if (body.action === "check") return Response.json(await checkOmpUpdate());
    if (body.action === "update" && isUpdateDisabled()) {
      return Response.json(
        { error: "Updates are disabled (OMP_WEB_DISABLE_AUTOUPDATE)", code: "updates_disabled" },
        { status: 403 },
      );
    }
    if (body.action === "update") {
      if (body.stream === true) {
        // The handler returns while the update still runs: Bun's idle timeout
        // would cut the stream through silent npm stretches.
        disableIdleTimeout();
        const stream = new ReadableStream<string>({
          async start(controller) {
            const done = () => { try { controller.close(); } catch { /* already closed */ } };
            const fail = (error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              try { controller.enqueue(JSON.stringify({ type: "error", message }) + "\n"); } catch { /* closed */ }
              done();
            };
            try {
              const result = await runOmpUpdateStream([], (line) => {
                try { controller.enqueue(JSON.stringify({ type: "out", text: line }) + "\n"); } catch { /* closed */ }
              });
              await restartAllRpcSessions();
              invalidateOmpCliCache();
              // Terminate the stream with a done frame: the client's reader loop
              // exits on stream close, which is what releases the "Updating"
              // button (setUpdatingOmp(false) in the finally block). Without a
              // close the stream stays open and the button spins forever.
              try { controller.enqueue(JSON.stringify({ type: "done", exitCode: result.exitCode }) + "\n"); } catch { /* closed */ }
              done();
            } catch (error) {
              fail(error);
            }
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
          },
        });
      }
      const output = await runOmpUpdateNow();
      const sessionsRestarted = await restartAllRpcSessions();
      invalidateOmpCliCache();
      return Response.json({ success: true, output: output.slice(-2000), sessionsRestarted });
    }
    if (body.action === "restart") {
      const stoppedInstances = await stopOtherOmpWebInstances();
      const sessionsRestarted = await restartAllRpcSessions();
      clearRpcFailures();
      return Response.json({
        success: true,
        sessionsRestarted,
        stoppedInstances,
        reconnectRequired: true,
      });
    }
    if (body.action === "repair") {
      // 无损恢复动作（供自动静默修复与诊断面板「修复」按钮使用）：只清错误
      // 环，绝不重启用户 RPC 会话或 stop 其他实例，因此不会打断正在进行的
      // 对话。
      clearRpcFailures();
      return Response.json({
        success: true,
        reconnectRequired: false,
      });
    }
    if (body.action === "stop-instance") {
      // Close stale local ompweb instances (leftover dev servers / old app)
      // on other ports of this machine, clearing session-lock contention.
      // Only a port other than this server's own may be stopped.
      const port = Number(body.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        return Response.json({ error: "invalid port", code: "invalid_port" }, { status: 400 });
      }
      const selfPort = Number(
        process.env.OMP_WEB_PORT ?? process.env.OMP_WEB_APP_PORT ?? process.env.PORT ?? (process.env.NODE_ENV === "production" ? "30177" : "30178"),
      );
      if (port === selfPort) {
        return Response.json({ error: "refusing to stop self", code: "stop_self" }, { status: 400 });
      }
      const pid = pidOnPort(port);
      if (pid === null) {
        return Response.json({ success: true, stopped: false, reason: "nothing listening" });
      }
      if (pid === process.pid) {
        return Response.json({ error: "refusing to stop self", code: "stop_self" }, { status: 400 });
      }
      try {
        await terminateInstanceProcess(pid);
      } catch (error) {
        return Response.json({
          error: `failed to stop pid ${pid}: ${error instanceof Error ? error.message : String(error)}`,
          code: "stop_failed",
        }, { status: 500 });
      }
      // The listener, not the kill call, decides: on Windows taskkill exits
      // nonzero both for an already-gone process and for a refused elevated
      // one, and on POSIX SIGTERM needs its escalation window. A success
      // answer is only made once the port stopped answering — the previous
      // silent no-op on Windows (lsof is not shipped there, so the lookup
      // always failed) toasted "instance stopped" while both instances kept
      // running behind the still-occupied ports.
      if (!(await waitForPortRelease(port, 3000))) {
        return Response.json({
          error: `pid ${pid} is still listening on :${port} — if that instance was started from an elevated shell, stop it from an elevated shell too`,
          code: "stop_failed",
        }, { status: 500 });
      }
      return Response.json({ success: true, stopped: true, pid });
    }
    return Response.json(
      { error: "action must be check, restart or stop-instance", code: "invalid_action" },
      { status: 400 },
    );
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

/** Best-effort self-healing for stale local ompweb servers. Never targets the
 * current listener and never uses a broad pkill pattern; a port is counted as
 * stopped only when its listener is actually gone. */
async function stopOtherOmpWebInstances(): Promise<number[]> {
  const selfPort = Number(process.env.OMP_WEB_PORT ?? process.env.OMP_WEB_APP_PORT ?? process.env.PORT ?? (process.env.NODE_ENV === "production" ? "30177" : "30178"));
  const stopped: number[] = [];
  for (const port of [30177, 30178, 30179, 30180]) {
    if (port === selfPort) continue;
    const pid = pidOnPort(port);
    if (!pid || pid === process.pid) continue;
    try {
      await terminateInstanceProcess(pid);
      if (await waitForPortRelease(port, 2000)) stopped.push(port);
    } catch { /* stale race / permission: leave it visible to diagnostics */ }
  }
  return stopped;
}
