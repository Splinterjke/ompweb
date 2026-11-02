import * as manager from "@/lib/terminal-session-manager";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { id, data } = body;

    if (!id || typeof data !== "string") {
      return Response.json({ error: "Invalid request payload" }, { status: 400 });
    }

    const written = manager.writeToTerminal(id, data);
    return Response.json({ ok: written });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to write input";
    return Response.json({ error: message }, { status: 500 });
  }
}