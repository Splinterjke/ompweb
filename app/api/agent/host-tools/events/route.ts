import { subscribeHostToolCalls } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// GET /api/agent/host-tools/events - SSE stream of host tool calls (open_url,
// notify, open_file) from sessions no tab is watching. Every open omp-web tab
// holds one, so a session keeps its host tools while the user views another.
export async function GET(req: Request) {
  let streamCleanup: (() => void) | null = null;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // controller already closed
        }
      };
      const unsubscribe = subscribeHostToolCalls((call) => {
        send(`data: ${JSON.stringify({ type: "host_tool_call", ...call })}\n\n`);
      });
      // Heartbeat to keep the connection alive through proxies/timeouts.
      const heartbeat = setInterval(() => send(":\n\n"), 30_000);
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        req.signal?.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          // controller already closed
        }
      };
      streamCleanup = cleanup;
      // Emit an initial comment frame immediately: Next does not flush the
      // response headers for a ReadableStream body until the first byte, so
      // without this the client would see no headers for up to the first
      // host-tool call or the 30 s heartbeat.
      send(":\n\n");

      req.signal?.addEventListener("abort", cleanup);
      if (req.signal?.aborted) {
        cleanup();
        return;
      }
    },
    cancel() {
      streamCleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
