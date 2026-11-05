import { apiErrorResponse, opErrorResponse, resolveWorkspaceHost } from "@/lib/api-utils";

// GET /api/cwd/browse?path=…&hostId=…: lists readable subdirectories on the owning host.
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const resolved = await resolveWorkspaceHost(params.get("hostId") ?? undefined, null);
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.browseDirectories(params.get("path"));
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) { return apiErrorResponse(error); }
}
