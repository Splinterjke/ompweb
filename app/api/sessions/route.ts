import { createHash } from "crypto";
import { listSessionsAllHosts } from "@/lib/hosts/session-index";
import { getRunningRpcSessionIds, getRunningRpcSessionMeta } from "@/lib/rpc-manager";
import { getAutomationSessions } from "@/lib/scheduler-store";

// The session list mixes on-disk sessions with the live runningSessionIds set,
// which changes on every agent turn, so it must never be cached by proxies or
// the browser. An ETag is still computed so conditional GETs short-circuit to
// a 304 when nothing changed (cheap client-side polling, server-side response
// body skipped).
const SESSION_LIST_HEADERS = {
  "Cache-Control": "no-store",
  Vary: "Cookie",
} as const;

export async function GET(req: Request) {
  try {
    // Every host's sessions (this machine first, each tagged with its hostId);
    // the automation annotation is main's own scheduler metadata.
    const sessions = await listSessionsAllHosts();
    const automation = getAutomationSessions();
    const annotated = automation && Object.keys(automation).length > 0
      ? sessions.map((s) => (automation[s.id] ? { ...s, automation: automation[s.id] } : s))
      : sessions;
    const runningSessionIds = getRunningRpcSessionIds();
    const body = { sessions: annotated, runningSessionIds, runningSessionMeta: getRunningRpcSessionMeta() };
    const bodyJson = JSON.stringify(body);
    const etag = `"${createHash("sha1").update(bodyJson).digest("hex").slice(0, 16)}"`;
    if (req.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag, ...SESSION_LIST_HEADERS } });
    }
    return new Response(bodyJson, { headers: { ETag: etag, "Content-Type": "application/json", ...SESSION_LIST_HEADERS } });
  } catch (error) {
    const code = typeof (error as { code?: unknown } | null)?.code === "string"
      ? (error as { code: string }).code
      : "session_list_failed";
    return Response.json(
      { error: error instanceof Error ? error.message : String(error), code },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
