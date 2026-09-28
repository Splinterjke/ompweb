import { NextResponse } from "next/server";
import { loadSessionFile } from "@/lib/omp/session-files";
import { buildSessionContext } from "@/lib/session-reader";
import { getLeafEntryId } from "@/lib/omp/session-files";
import { apiErrorResponse, resolveSessionPathOr404 } from "@/lib/api-utils";

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
    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return resolved.response;
    const filePath = resolved.filePath;

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
