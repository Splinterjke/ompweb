// The API route table: one entry per app/api/**/route.ts (server/routes.test.ts fails when they differ).
// Static imports, not a runtime glob, so a future `bun build --compile` can bundle every handler.

import * as agentId from "@/app/api/agent/[id]/route";
import * as agentIdAdvisor from "@/app/api/agent/[id]/advisor/route";
import * as agentIdBashOutput from "@/app/api/agent/[id]/bash-output/route";
import * as agentNew from "@/app/api/agent/new/route";
import * as agents from "@/app/api/agents/route";
import * as appUpdate from "@/app/api/app-update/route";
import * as authAllProviders from "@/app/api/auth/all-providers/route";
import * as authApiKeyProvider from "@/app/api/auth/api-key/[provider]/route";
import * as authLoginProvider from "@/app/api/auth/login/[provider]/route";
import * as authLogoutProvider from "@/app/api/auth/logout/[provider]/route";
import * as authProviders from "@/app/api/auth/providers/route";
import * as browserProxy from "@/app/api/browser-proxy/route";
import * as chatEventActions from "@/app/api/chat-event-actions/route";
import * as chatEventActionsId from "@/app/api/chat-event-actions/[id]/route";
import * as chatEventActionsTest from "@/app/api/chat-event-actions/test/route";
import * as cwdBrowse from "@/app/api/cwd/browse/route";
import * as cwdValidate from "@/app/api/cwd/validate/route";
import * as defaultCwd from "@/app/api/default-cwd/route";
import * as diagnostics from "@/app/api/diagnostics/route";
import * as events from "@/app/api/events/route";
import * as eventsLink from "@/app/api/events/link/route";
import * as fileIndex from "@/app/api/file-index/route";
import * as filesPath from "@/app/api/files/[...path]/route";
import * as gitGraph from "@/app/api/git-graph/route";
import * as gitBranches from "@/app/api/git/branches/route";
import * as gitCheckout from "@/app/api/git/checkout/route";
import * as gitCommit from "@/app/api/git/commit/route";
import * as gitDiff from "@/app/api/git/diff/route";
import * as gitPush from "@/app/api/git/push/route";
import * as gitStatus from "@/app/api/git/status/route";
import * as githubRepo from "@/app/api/github-repo/route";
import * as githubStatus from "@/app/api/github/status/route";
import * as health from "@/app/api/health/route";
import * as home from "@/app/api/home/route";
import * as hosts from "@/app/api/hosts/route";
import * as hostsLink from "@/app/api/hosts/link/route";
import * as hostsIdUpdates from "@/app/api/hosts/[id]/updates/route";
import * as manifest from "@/app/api/manifest/route";
import * as mcp from "@/app/api/mcp/route";
import * as mediaHash from "@/app/api/media/[hash]/route";
import * as memoryBanks from "@/app/api/memory/banks/route";
import * as memoryBanksBank from "@/app/api/memory/banks/[bank]/route";
import * as modelRoles from "@/app/api/model-roles/route";
import * as models from "@/app/api/models/route";
import * as modelsConfig from "@/app/api/models-config/route";
import * as modelsConfigCatalog from "@/app/api/models-config/catalog/route";
import * as modelsConfigTest from "@/app/api/models-config/test/route";
import * as modelsFetch from "@/app/api/models/fetch/route";
import * as nativeSettings from "@/app/api/native-settings/route";
import * as notificationsDevices from "@/app/api/notifications/devices/route";
import * as notificationsHistory from "@/app/api/notifications/history/route";
import * as notificationsPresence from "@/app/api/notifications/presence/route";
import * as notificationsTest from "@/app/api/notifications/test/route";
import * as ompSettings from "@/app/api/omp-settings/route";
import * as ompUpdate from "@/app/api/omp-update/route";
import * as ompVersion from "@/app/api/omp-version/route";
import * as pairAccept from "@/app/api/pair/accept/route";
import * as pairConfig from "@/app/api/pair/config/route";
import * as pairDevices from "@/app/api/pair/devices/route";
import * as pairDevicesId from "@/app/api/pair/devices/[id]/route";
import * as pairDiagnostics from "@/app/api/pair/diagnostics/route";
import * as pairHeartbeat from "@/app/api/pair/heartbeat/route";
import * as pairRevokeAll from "@/app/api/pair/revoke-all/route";
import * as pairToken from "@/app/api/pair/token/route";
import * as pairTunnel from "@/app/api/pair/tunnel/route";
import * as plugins from "@/app/api/plugins/route";
import * as projects from "@/app/api/projects/route";
import * as projectsArchiveOlderThan from "@/app/api/projects/archive-older-than/route";
import * as projectsClone from "@/app/api/projects/clone/route";
import * as providerUsage from "@/app/api/provider-usage/route";
import * as providersEnable from "@/app/api/providers/enable/route";
import * as proxy from "@/app/api/proxy/route";
import * as reveal from "@/app/api/reveal/route";
import * as schedulers from "@/app/api/schedulers/route";
import * as schedulersId from "@/app/api/schedulers/[id]/route";
import * as schedulersIdClearRuns from "@/app/api/schedulers/[id]/clear-runs/route";
import * as schedulersIdRun from "@/app/api/schedulers/[id]/run/route";
import * as schedulersPreview from "@/app/api/schedulers/preview/route";
import * as schedulersValidate from "@/app/api/schedulers/validate/route";
import * as sessions from "@/app/api/sessions/route";
import * as sessionsId from "@/app/api/sessions/[id]/route";
import * as sessionsIdArchive from "@/app/api/sessions/[id]/archive/route";
import * as sessionsIdAutoName from "@/app/api/sessions/[id]/auto-name/route";
import * as sessionsIdContext from "@/app/api/sessions/[id]/context/route";
import * as sessionsIdEntriesEntryIdThinking from "@/app/api/sessions/[id]/entries/[entryId]/thinking/route";
import * as sessionsIdExport from "@/app/api/sessions/[id]/export/route";
import * as sessionsIdLocalFile from "@/app/api/sessions/[id]/local-file/route";
import * as sessionsIdPlan from "@/app/api/sessions/[id]/plan/route";
import * as sessionsIdMatches from "@/app/api/sessions/[id]/matches/route";
import * as sessionsIdState from "@/app/api/sessions/[id]/state/route";
import * as sessionsIdSubagents from "@/app/api/sessions/[id]/subagents/route";
import * as sessionsIdSubagentsSubagentId from "@/app/api/sessions/[id]/subagents/[subagentId]/route";
import * as sessionsArchive from "@/app/api/sessions/archive/route";
import * as sessionsImport from "@/app/api/sessions/import/route";
import * as sessionsSearch from "@/app/api/sessions/search/route";
import * as skillHubSlug from "@/app/api/skill-hub/[[...slug]]/route";
import * as skills from "@/app/api/skills/route";
import * as skillsCheck from "@/app/api/skills/check/route";
import * as skillsInstall from "@/app/api/skills/install/route";
import * as skillsSearch from "@/app/api/skills/search/route";
import * as skillsUpdate from "@/app/api/skills/update/route";
import * as stt from "@/app/api/stt/route";
import * as sttJobId from "@/app/api/stt/[jobId]/route";
import * as sttJobIdAudio from "@/app/api/stt/[jobId]/audio/route";
import * as terminalInput from "@/app/api/terminal/input/route";
import * as terminalOpen from "@/app/api/terminal/open/route";
import * as terminalResize from "@/app/api/terminal/resize/route";
import * as terminalSession from "@/app/api/terminal/session/route";
import * as terminalStream from "@/app/api/terminal/stream/route";
import * as transportMetrics from "@/app/api/transport-metrics/route";
import * as uploadsId from "@/app/api/uploads/[id]/route";
import * as uploads from "@/app/api/uploads/route";
import * as uiLocale from "@/app/api/ui/locale/route";
import * as uiRefresh from "@/app/api/ui/refresh/route";
import * as usageReset from "@/app/api/usage-reset/route";
import * as usageSummary from "@/app/api/usage-summary/route";
import * as usageLogs from "@/app/api/usage/logs/route";
import * as usageStats from "@/app/api/usage/stats/route";
import * as webAuthSession from "@/app/api/web-auth/session/route";
import * as webSettings from "@/app/api/web-settings/route";
import * as worktrees from "@/app/api/worktrees/route";
import * as gitGraphPage from "@/app/gitgraph/route";
import type { BrowserLinkData } from "@/lib/browser-link";
import type { LinkSocketData } from "@/lib/hosts/hub";

/** What Bun keeps on an upgraded socket (`ws.data`): a host link's or a browser link's. */
export type ServerSocketData = LinkSocketData | BrowserLinkData;

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
// never: each handler narrows its own params; the router passes Record<string, string | string[]>.
// disableIdleTimeout: a handler whose response stays open without traffic (a stream) keeps Bun's idle timeout off for
// its socket; see handle() in server/app.ts.
// upgrade: makes the request a WebSocket (server.upgrade), a host link or a browser link; a handler that upgraded
// returns undefined.
export type RouteHandler = (
  request: Request,
  context: { params: Promise<never>; disableIdleTimeout: () => void; upgrade: (data: ServerSocketData) => boolean },
) => Response | undefined | Promise<Response | undefined>;
export type RouteModule = Partial<Record<Method, RouteHandler>>;

// Key: the route's directory under app/api.
export const ROUTE_MODULES: Record<string, RouteModule> = {
  "agent/[id]": agentId,
  "agent/[id]/advisor": agentIdAdvisor,
  "agent/[id]/bash-output": agentIdBashOutput,
  "agent/new": agentNew,
  "agents": agents,
  "app-update": appUpdate,
  "auth/all-providers": authAllProviders,
  "auth/api-key/[provider]": authApiKeyProvider,
  "auth/login/[provider]": authLoginProvider,
  "auth/logout/[provider]": authLogoutProvider,
  "auth/providers": authProviders,
  "browser-proxy": browserProxy,
  "chat-event-actions": chatEventActions,
  "chat-event-actions/[id]": chatEventActionsId,
  "chat-event-actions/test": chatEventActionsTest,
  "cwd/browse": cwdBrowse,
  "cwd/validate": cwdValidate,
  "default-cwd": defaultCwd,
  "diagnostics": diagnostics,
  "events": events,
  "events/link": eventsLink,
  "file-index": fileIndex,
  "files/[...path]": filesPath,
  "git-graph": gitGraph,
  "git/branches": gitBranches,
  "git/checkout": gitCheckout,
  "git/commit": gitCommit,
  "git/diff": gitDiff,
  "git/push": gitPush,
  "git/status": gitStatus,
  "github-repo": githubRepo,
  "github/status": githubStatus,
  "health": health,
  "home": home,
  "hosts": hosts,
  "hosts/link": hostsLink,
  "hosts/[id]/updates": hostsIdUpdates,
  "manifest": manifest,
  "mcp": mcp,
  "media/[hash]": mediaHash,
  "memory/banks": memoryBanks,
  "memory/banks/[bank]": memoryBanksBank,
  "model-roles": modelRoles,
  "models": models,
  "models-config": modelsConfig,
  "models-config/catalog": modelsConfigCatalog,
  "models-config/test": modelsConfigTest,
  "models/fetch": modelsFetch,
  "native-settings": nativeSettings,
  "notifications/devices": notificationsDevices,
  "notifications/history": notificationsHistory,
  "notifications/presence": notificationsPresence,
  "notifications/test": notificationsTest,
  "omp-settings": ompSettings,
  "omp-update": ompUpdate,
  "omp-version": ompVersion,
  "pair/accept": pairAccept,
  "pair/config": pairConfig,
  "pair/devices": pairDevices,
  "pair/devices/[id]": pairDevicesId,
  "pair/diagnostics": pairDiagnostics,
  "pair/heartbeat": pairHeartbeat,
  "pair/revoke-all": pairRevokeAll,
  "pair/token": pairToken,
  "pair/tunnel": pairTunnel,
  "plugins": plugins,
  "projects": projects,
  "projects/archive-older-than": projectsArchiveOlderThan,
  "projects/clone": projectsClone,
  "provider-usage": providerUsage,
  "providers/enable": providersEnable,
  "proxy": proxy,
  "reveal": reveal,
  "schedulers": schedulers,
  "schedulers/[id]": schedulersId,
  "schedulers/[id]/clear-runs": schedulersIdClearRuns,
  "schedulers/[id]/run": schedulersIdRun,
  "schedulers/preview": schedulersPreview,
  "schedulers/validate": schedulersValidate,
  "sessions": sessions,
  "sessions/[id]": sessionsId,
  "sessions/[id]/archive": sessionsIdArchive,
  "sessions/[id]/auto-name": sessionsIdAutoName,
  "sessions/[id]/context": sessionsIdContext,
  "sessions/[id]/entries/[entryId]/thinking": sessionsIdEntriesEntryIdThinking,
  "sessions/[id]/export": sessionsIdExport,
  "sessions/[id]/local-file": sessionsIdLocalFile,
  "sessions/[id]/plan": sessionsIdPlan,
  "sessions/[id]/matches": sessionsIdMatches,
  "sessions/[id]/state": sessionsIdState,
  "sessions/[id]/subagents": sessionsIdSubagents,
  "sessions/[id]/subagents/[subagentId]": sessionsIdSubagentsSubagentId,
  "sessions/archive": sessionsArchive,
  "sessions/import": sessionsImport,
  "sessions/search": sessionsSearch,
  "skill-hub/[[...slug]]": skillHubSlug,
  "skills": skills,
  "skills/check": skillsCheck,
  "skills/install": skillsInstall,
  "skills/search": skillsSearch,
  "skills/update": skillsUpdate,
  "stt": stt,
  "stt/[jobId]": sttJobId,
  "stt/[jobId]/audio": sttJobIdAudio,
  "terminal/input": terminalInput,
  "terminal/open": terminalOpen,
  "terminal/resize": terminalResize,
  "terminal/session": terminalSession,
  "terminal/stream": terminalStream,
  "transport-metrics": transportMetrics,
  "uploads/[id]": uploadsId,
  "uploads": uploads,
  "ui/locale": uiLocale,
  "ui/refresh": uiRefresh,
  "usage-reset": usageReset,
  "usage-summary": usageSummary,
  "usage/logs": usageLogs,
  "usage/stats": usageStats,
  "web-auth/session": webAuthSession,
  "web-settings": webSettings,
  "worktrees": worktrees,
};

const METHODS: Method[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

// Server-rendered pages outside the SPA and outside app/api: the key is the
// URL pathname, the handler answers with a complete document (the embedded
// Git Graph webview). Registered beside ROUTE_MODULES in startServer.
export const PAGE_MODULES: Record<string, RouteModule> = {
  "/gitgraph": gitGraphPage,
};

/** Bun.serve pattern for a table key: `[x]` → `:x`, `[...x]` → `*` (its segments start at pathname index `rest.index`). */
export function routePattern(key: string): { pattern: string; rest: { name: string; index: number } | null } {
  const segments = key.split("/");
  // Catch-alls, including Next's optional form `[[...x]]`: Bun's router has
  // no optional wildcard, so both map to `*` (the bare prefix without a
  // trailing segment reaches `*` only as `/…/` — no client in this app calls
  // it that way; every skill-hub call carries a subpath).
  const wildcard = (segment: string) => segment.match(/^\[+\.\.\.(\w+)\]+$/) ?? null;
  const restAt = segments.findIndex((segment) => wildcard(segment) !== null);
  const pattern = `/api/${segments.map((segment) => (wildcard(segment) ? "*" : segment.replace(/^\[(\w+)\]$/, ":$1"))).join("/")}`;
  // pathname.split("/") is ["", "api", ...segments].
  return { pattern, rest: restAt < 0 ? null : { name: wildcard(segments[restAt])![1], index: restAt + 2 } };
}

/** Runs the module's handler for the request method, answering HEAD, OPTIONS and missing methods as Next did. */
export async function dispatch(
  mod: RouteModule,
  request: Request,
  params: Record<string, string | string[]>,
  disableIdleTimeout: () => void = () => {},
  upgrade: (data: ServerSocketData) => boolean = () => false,
): Promise<Response | undefined> {
  const handler = mod[request.method as Method] ?? (request.method === "HEAD" ? mod.GET : undefined);
  if (!handler) {
    const methods = METHODS.filter((method) => mod[method]);
    if (request.method !== "OPTIONS") return new Response(null, { status: 405, headers: { allow: methods.join(", ") } });
    const allow = [...methods, ...(mod.GET ? ["HEAD"] : []), "OPTIONS"].sort().join(", ");
    return new Response(null, { status: 204, headers: { allow } });
  }
  try {
    return await handler(request, { params: Promise.resolve(params) as Promise<never>, disableIdleTimeout, upgrade });
  } catch (error) {
    console.error(error);
    return Response.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
