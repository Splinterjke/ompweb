import { NextResponse } from "next/server";
import { loadSessionFile } from "@/lib/omp/session-files";
import { buildSessionContext, resolveSessionPath } from "@/lib/session-reader";
import { getLeafEntryId } from "@/lib/omp/session-files";
import { apiErrorResponse, opErrorResponse, resolveSessionHostOr404 } from "@/lib/api-utils";
import { localHost } from "@/lib/hosts/local-host";
import { getRpcSession } from "@/lib/rpc-manager";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const leafId = url.searchParams.get("leafId") ?? undefined;
  const deferThinking = url.searchParams.has("deferThinking");
  const deferToolResultImages = url.searchParams.has("deferMedia");
  // Read-only transcript mode: include entries omitted from the active agent context.
  const includePreCompaction = url.searchParams.has("includePreCompaction");

  try {
    const resolved = await resolveSessionHostOr404(id);
    if ("response" in resolved) {
      // omp does not create the session file until the first assistant message
      // commits, so a live web-owned session (its first turn still running) can
      // have no file yet. A live wrapper proves the session exists — answer with
      // an empty context instead of a 404 so the client can attach its event
      // stream and show the running state (mirrors GET /api/sessions/[id]).
      const live = getRpcSession(id);
      if (live?.isAlive()) {
        const context = buildSessionContext([], null, { deferThinking, deferToolResultImages, includePreCompaction });
        return NextResponse.json({ context, leafId: null });
      }
      return resolved.response;
    }

    // Another host owns the file: the host facade reads it there and answers
    // with the same `{ context }` shape (its 413/malformed mapping included).
    // That machine's file tail is unknown here, so only the requested leaf is
    // echoed back.
    if (resolved.host !== localHost) {
      const result = await resolved.host.sessionOps.readContext(id, leafId, {
        deferThinking,
        deferMedia: deferToolResultImages,
        includePreCompaction,
      });
      if (!result.ok) return opErrorResponse(result);
      return NextResponse.json({ context: (result.value as { context?: unknown }).context, leafId: leafId ?? null });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found", code: "session_not_found" }, { status: 404 });
    }

    const { header, entries, error: loadError } = loadSessionFile(filePath, {
      resolveBlobs: true,
      skipToolResultImages: deferToolResultImages,
    });
    if (loadError === "too_large") {
      return NextResponse.json(
        { error: "Session file is too large to open in omp-web", code: "session_file_too_large" },
        { status: 413 },
      );
    }
    if (!header) {
      return NextResponse.json({ error: "Session file is missing or malformed", code: "session_file_malformed" }, { status: 404 });
    }
    const context = buildSessionContext(entries, leafId, {
      deferThinking,
      deferToolResultImages,
      includePreCompaction,
    });
    // Report the leaf the context actually resolved to. buildSessionContext
    // falls back to the file's persisted tail when the requested leaf is
    // missing (a stale branch pointer after external edits); the client
    // re-attaches its active leaf to this so external writes that extend the
    // transcript past a pinned leaf are not silently hidden.
    const resolvedLeafId =
      leafId && entries.some((e) => e.id === leafId) ? leafId : getLeafEntryId(entries);

    return NextResponse.json({ context, leafId: resolvedLeafId });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
