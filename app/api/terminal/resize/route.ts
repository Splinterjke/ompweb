import * as manager from "@/lib/terminal-session-manager";

/** POST /api/terminal/resize  body: { id, cols, rows } — sync the PTY size. */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { id, cols, rows } = body as { id?: unknown; cols?: unknown; rows?: unknown };
    if (typeof id !== "string" || !id) {
      return Response.json({ error: "Missing id" }, { status: 400 });
    }
    const c = Number(cols);
    const r = Number(rows);
    if (!Number.isFinite(c) || !Number.isFinite(r) || c < 2 || r < 1) {
      return Response.json({ error: "Invalid cols/rows" }, { status: 400 });
    }
    const ok = manager.resizeTerminal(id, Math.floor(c), Math.floor(r));
    return Response.json({ ok });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to resize terminal";
    return Response.json({ error: message }, { status: 500 });
  }
}