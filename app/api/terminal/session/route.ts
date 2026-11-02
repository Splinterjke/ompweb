import * as manager from "@/lib/terminal-session-manager";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));

    // The shell cwd must be inside the allowed roots (same rule as /api/files
    // and /api/reveal); anything else falls back to the process cwd.
    let cwd = typeof body?.cwd === "string" ? body.cwd : undefined;
    if (cwd && typeof cwd === "string") {
      const allowedRoots = await getAllowedFileRoots();
      if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
        cwd = process.cwd();
      }
    }

    const { id, cwd: resolvedCwd } = await manager.createTerminalSession(cwd);
    return Response.json({ ok: true, sessionId: id, cwd: resolvedCwd });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to create terminal session";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) {
      return Response.json({ error: "Missing sessionId" }, { status: 400 });
    }
    const closed = manager.closeTerminalSession(id);
    return Response.json({ ok: closed });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to close terminal session";
    return Response.json({ error: message }, { status: 500 });
  }
}
