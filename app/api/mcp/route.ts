import { NextResponse } from "next/server";
import { basename } from "path";
import { allowFileRoot, getAllowedFileRoots, isExistingFilePathAllowed, isPathWithinRoots } from "@/lib/file-access";
import { deleteMcpServer, deleteUserMcpServer, getBuiltinMcpPresets, parseMcpListOutput, readDiscoveredMcpServers, readMcpConfig, readUserMcpConfig, type McpServer, type McpLiveServer, validateMcpServer, writeMcpServer, writeUserMcpServer } from "@/lib/omp/mcp-config";
import { listAllSessions, readSessionHeader, resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession, resolveSpawnCwdResult, startRpcSession } from "@/lib/rpc-manager";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { redactMcpServer } from "@/lib/omp/mcp-config";
import { comparableProjectPath } from "@/lib/comparable-path";
import { existingDiscoveredProjectPaths, loadProjectRegistry, mergeProjects } from "@/lib/project-registry";

export const dynamic = "force-dynamic";
const MAX_MCP_REQUEST_BYTES = 1024 * 1024;

function mcpErrorResponse(error: unknown) {
  const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
  return NextResponse.json({ error: error instanceof RequestBodyTooLargeError ? "MCP request is too large" : error instanceof Error ? error.message : String(error) }, { status });
}

function mergeMcpServers(primary: McpLiveServer[], secondary: McpLiveServer[]): McpLiveServer[] {
  const result = [...primary];
  const seen = new Set(primary.map((server) => `${server.source}:${server.name}`));
  for (const server of secondary) {
    const key = `${server.source}:${server.name}`;
    if (!seen.has(key)) result.push(server);
  }
  return result;
}

async function allowedCwd(cwd: unknown): Promise<string> {
  if (typeof cwd !== "string" || !cwd.trim()) throw new Error("cwd is required");
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) throw new Error("Workspace is not allowed");
  return cwd;
}

type WorkspaceEntry = { cwd: string; name: string; path: string | null; exists: boolean; servers: Array<{ name: string; config: McpServer }>; live: McpLiveServer[] };

/** Every known workspace: registered projects plus session-discovered ones,
 *  with the requested cwd included. Warms the read allow-list for workspaces
 *  that have no active session (mirrors /api/projects) so the MCP read path
 *  does not depend on a live session. */
async function workspaceList(requestedCwd: string | null): Promise<Array<{ cwd: string; name: string }>> {
  const registry = loadProjectRegistry();
  const sessions = await listAllSessions();
  const discovered = existingDiscoveredProjectPaths(
    sessions.map((s) => s.projectRoot ?? s.cwd).filter((path): path is string => Boolean(path)),
  );
  const projects = mergeProjects(registry, discovered);
  for (const project of projects) allowFileRoot(project.path);
  const byPath = new Map<string, { cwd: string; name: string }>();
  const add = (cwd: string) => {
    if (!cwd || byPath.has(comparableProjectPath(cwd))) return;
    byPath.set(comparableProjectPath(cwd), { cwd, name: basename(cwd) || cwd });
  };
  if (requestedCwd) add(requestedCwd);
  for (const project of projects) add(project.path);
  return [...byPath.values()];
}

function mcpType(config: McpServer): string {
  return typeof config.type === "string" && config.type !== "stdio" ? config.type : typeof config.url === "string" ? "http" : "stdio";
}

function readWorkspaceMcp(cwd: string): { path: string | null; exists: boolean; servers: Array<{ name: string; config: McpServer }> } {
  try {
    const file = readMcpConfig(cwd);
    return {
      path: file.path,
      exists: file.exists,
      servers: Object.entries(file.config.mcpServers ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, config]) => ({ name, config: redactMcpServer(config) })),
    };
  } catch {
    // One unreadable workspace (missing dir, oversized or invalid JSON) must not
    // take down the whole page; it simply shows no editable project servers.
    return { path: null, exists: false, servers: [] };
  }
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const requestedCwd = params.get("cwd");
    const allWorkspaces = await workspaceList(requestedCwd);
    const allowedRoots = await getAllowedFileRoots();
    // Only read a workspace's MCP config when its path is within the allow-list
    // (the same gate the write path enforces). A workspace with no active session
    // that was never registered is skipped — the page still lists every other
    // allowed workspace and the user-level config, so it never 400s.
    const workspaces = allWorkspaces.filter((w) => isPathWithinRoots(w.cwd, allowedRoots));
    const cwd = requestedCwd
      ? (workspaces.some((w) => comparableProjectPath(w.cwd) === comparableProjectPath(requestedCwd)) ? requestedCwd : null)
      : null;
    const user = readUserMcpConfig();
    const builtinPresets = getBuiltinMcpPresets(cwd ?? undefined);

    // Global auto-discovered provider configs (homedir) appear once; per-workspace
    // groups then list only that workspace's own provider configs.
    const globalDiscovered = readDiscoveredMcpServers(undefined, user.disabledServers);
    const globalDiscoveredKeys = new Set(globalDiscovered.map((s) => `${s.source}:${s.name}`));

    const workspaceEntries: WorkspaceEntry[] = workspaces.map((workspace) => {
      const { path, exists, servers } = readWorkspaceMcp(workspace.cwd);
      const source = workspace.name;
      const live: McpLiveServer[] = [
        ...servers.map(({ name, config }) => ({ name, source, status: config.enabled === false ? ("disabled" as const) : ("configured" as const), type: mcpType(config), cwd: workspace.cwd })),
        ...readDiscoveredMcpServers(workspace.cwd, user.disabledServers)
          .filter((s) => !globalDiscoveredKeys.has(`${s.source}:${s.name}`))
          .map((s) => ({ ...s, cwd: workspace.cwd })),
      ];
      return { ...workspace, path, exists, servers, live };
    });

    const inventory: McpLiveServer[] = [
      ...user.servers.map(({ name, config }) => ({ name, source: "User level", status: config.enabled === false ? ("disabled" as const) : ("configured" as const), type: mcpType(config) })),
      ...user.disabledServers.map((name) => ({ name, source: "Disabled", status: "disabled" as const })),
      ...globalDiscovered,
      ...workspaceEntries.flatMap((w) => w.live),
    ];
    // The user-level config may carry bearer tokens/API keys in `headers` and
    // credentials in `env`. The UI only renders name/status/type/enabled plus the
    // redacted config (command/args/url/enabled) — never the raw env/headers.
    const safeUser = {
      path: user.path,
      disabledServers: user.disabledServers,
      error: user.error,
      servers: user.servers.map(({ name, config }) => {
        const type = mcpType(config);
        const command = typeof config.command === "string" ? config.command.trim() : "";
        const url = typeof config.url === "string" ? config.url.trim() : "";
        const hasCommand = command.length > 0;
        const hasUrl = url.length > 0;
        const valid = (hasCommand || hasUrl) && !(hasCommand && hasUrl) && (type === "http" || type === "sse" ? hasUrl : hasCommand);
        return {
          name,
          status: config.enabled === false ? ("disabled" as const) : ("configured" as const),
          type,
          enabled: config.enabled !== false,
          valid,
        };
      }),
    };
    // Redacted user-level server configs so the "User level" editor scope can
    // list and load them into the editor (env/headers stripped by redactMcpServer).
    const userServers = user.servers.map(({ name, config }) => ({ name, config: redactMcpServer(config) }));
    const sessionId = params.get("sessionId");
    // `live=0` skips the live status fetch (which can spawn/wait on an OMP
    // child); the UI then fetches live status separately so the static
    // inventory paints first.
    const includeLive = params.get("live") !== "0";
    let liveServers: McpLiveServer[] | undefined;
    let liveError: string | undefined;
    if (includeLive && sessionId) {
      try {
        let session = getRpcSession(sessionId);
        if (!session?.isAlive()) {
          const sessionFile = await resolveSessionPath(sessionId);
          if (!sessionFile) throw new Error("Session not found");
          const header = readSessionHeader(sessionFile);
          const { cwd: sessionCwd } = resolveSpawnCwdResult(header?.cwd);
          // No advisor opinion: this spawn is a side effect of listing MCP
          // servers and must not replace a child spawned with --advisor.
          ({ session } = await startRpcSession(sessionId, sessionFile, sessionCwd, undefined, undefined, header?.cwd));
        }
        liveServers = mergeMcpServers(parseMcpListOutput(await session.getMcpList()), inventory);
      } catch (error) {
        liveError = error instanceof Error ? error.message : String(error);
      }
    }
    return NextResponse.json({
      user: safeUser,
      userServers,
      workspaces: workspaceEntries.map(({ cwd: wCwd, name, path, exists, servers }) => ({ cwd: wCwd, name, path, exists, servers })),
      builtinPresets,
      inventory,
      liveServers,
      liveError,
    });
  } catch (error) {
    return mcpErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await parseJsonWithinLimit<{ cwd?: unknown; scope?: unknown; name?: unknown; previousName?: unknown; server?: unknown }>(request, MAX_MCP_REQUEST_BYTES);
    validateMcpServer(body.name, body.server);
    if (body.previousName !== undefined && typeof body.previousName !== "string") throw new Error("previousName must be a string");
    if (body.scope === "user" || !body.cwd) {
      return NextResponse.json({ success: true, ...writeUserMcpServer(body.name as string, body.server, body.previousName) });
    }
    const cwd = await allowedCwd(body.cwd);
    return NextResponse.json({ success: true, ...writeMcpServer(cwd, body.name as string, body.server, body.previousName) });
  } catch (error) {
    return mcpErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const body = await parseJsonWithinLimit<{ name?: unknown; server?: unknown }>(request, MAX_MCP_REQUEST_BYTES);
    validateMcpServer(body.name, body.server);
    return NextResponse.json({ success: true, message: "MCP server configuration is valid" });
  } catch (error) {
    return mcpErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await parseJsonWithinLimit<{ cwd?: unknown; scope?: unknown; name?: unknown }>(request, MAX_MCP_REQUEST_BYTES);
    if (typeof body.name !== "string") throw new Error("name is required");
    if (body.scope === "user" || !body.cwd) {
      return NextResponse.json({ success: true, ...deleteUserMcpServer(body.name as string) });
    }
    const cwd = await allowedCwd(body.cwd);
    return NextResponse.json({ success: true, ...deleteMcpServer(cwd, body.name as string) });
  } catch (error) {
    return mcpErrorResponse(error);
  }
}
