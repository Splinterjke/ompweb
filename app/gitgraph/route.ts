import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { defaultGitGraphViewConfig, DEFAULT_LIGHT_PALETTE } from "@/lib/git-graph/default-config";
import type * as GG from "@/vendor/vscode-git-graph/types";

// Serves the embedded Git Graph webview document (iframe src of the Git graph
// overlay). Front-end assets are built from vendor/vscode-git-graph by
// scripts/build-git-graph.mjs into public/gitgraph/; this route only injects
// the boot globals the vendored front-end expects (the same
// GitGraphViewInitialState the upstream extension embeds in its webview HTML)
// plus the light-theme palette — the embedding page pushes the live theme
// right after the iframe reports ready.
//
// The document is framed only by this same-origin app, so it needs its own
// CSP/XFO headers; next.config.ts excludes this exact path from the global
// rules (config headers would overwrite the route's and block the frame).

const DEFAULT_GLOBAL_VIEW_STATE: Pick<GG.GitGraphViewGlobalState, "alwaysAcceptCheckoutCommit" | "issueLinkingConfig" | "pushTagSkipRemoteCheck"> = {
  alwaysAcceptCheckoutCommit: false,
  issueLinkingConfig: null,
  pushTagSkipRemoteCheck: false,
};

const DEFAULT_WORKSPACE_VIEW_STATE = {
  findIsCaseSensitive: false,
  findIsRegex: false,
  findOpenCommitDetailsView: false,
};

// Upstream DEFAULT_REPO_STATE (extensionState.ts); the webview reads these
// per-repo rendering options from the boot state. Const-enum wire values are
// inlined as literals (type-only import of the vendored types).
const DEFAULT_REPO_STATE: GG.GitRepoState = {
  cdvDivider: 0.5,
  cdvHeight: 250,
  columnWidths: null,
  commitOrdering: "default" as GG.RepoCommitOrdering,
  fileViewType: 0 as GG.FileViewType,
  hideRemotes: [],
  includeCommitsMentionedByReflogs: 0 as GG.BooleanOverride,
  issueLinkingConfig: null,
  lastImportAt: 0,
  name: null,
  onlyFollowFirstParent: 0 as GG.BooleanOverride,
  onRepoLoadShowCheckedOutBranch: 0 as GG.BooleanOverride,
  onRepoLoadShowSpecificBranches: null,
  pullRequestConfig: null,
  showRemoteBranches: true,
  showRemoteBranchesV2: 0 as GG.BooleanOverride,
  simplifyByDecoration: 0 as GG.BooleanOverride,
  showStashes: 0 as GG.BooleanOverride,
  showTags: 0 as GG.BooleanOverride,
  pathFilter: null,
  workspaceFolderIndex: null,
  isCdvSummaryHidden: false,
};

function errorPage(message: string): Response {
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Git Graph</title>` +
    `<style>body{font-family:system-ui,sans-serif;background:#f7f4ef;color:#3d3a34;display:grid;place-items:center;height:100vh;margin:0}</style>` +
    `</head><body><div><h2>Unable to load Git Graph</h2><p>${message}</p></div></body></html>`;
  return new Response(html, { status: 400, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function GET(request: NextRequest) {
  const repo = request.nextUrl.searchParams.get("repo")?.trim() ?? "";
  if (!repo || (!repo.startsWith("/") && !isWindowsAbsolutePath(repo))) {
    return errorPage("A valid <code>repo</code> query parameter (absolute path) is required.");
  }

  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(repo, allowedRoots) || !isExistingFilePathAllowed(repo, allowedRoots)) {
    return errorPage("This path is not an allowed workspace.");
  }

  const config = defaultGitGraphViewConfig();
  const initialState = {
    config,
    lastActiveRepo: repo,
    loadViewTo: null,
    repos: { [repo]: DEFAULT_REPO_STATE },
    loadRepoInfoRefreshId: 0,
    loadCommitsRefreshId: 0,
    workspaceFolderPaths: {},
  } satisfies GG.GitGraphViewInitialState;

  let colorVars = "";
  let colorParams = "";
  const palette = config.graph.colours.length > 0 ? config.graph.colours : DEFAULT_LIGHT_PALETTE;
  for (let i = 0; i < palette.length; i++) {
    colorVars += `--git-graph-color${i}:${palette[i]}; `;
    colorParams += `[data-color="${i}"]{--git-graph-color:var(--git-graph-color${i});} `;
  }

  const stickyClassAttr = config.stickyHeader ? ' class="sticky"' : "";
  const body = `<body>
<div id="view" tabindex="-1">
	<div id="controls"${stickyClassAttr}>
		<div id="filterControls" style="display: flex; flex-wrap: wrap; justify-content: center">
			<span id="repoControl" style="flex: 1; "><span class="unselectable">Repo: </span><div id="repoDropdown" class="dropdown"></div></span>
			<span id="branchControl" style="flex: 2; max-width: ${50 - 6 * 2}vw;"><span class="unselectable">Branches: </span><div id="branchDropdown" class="dropdown"></div></span>
			<span id="pathFilterControl" style="display: none" title="Select path by context menu in file explorer"><span class="unselectable">Paths: </span><div id="pathFilterDropdown" class="dropdown"></div></span>
			<span id="authorControl" style="flex: 1; max-width: ${30 - 3 * 2}vw;"><span class="unselectable">Authors: </span><div id="authorDropdown" class="dropdown"></div></span>
			<label id="showRemoteBranchesControl"  title="Show Remote Branches"><input type="checkbox" id="showRemoteBranchesCheckbox" tabindex="-1"><span class="customCheckbox"></span>Remotes</label>
			<label id="simplifyByDecorationControl" style="display: none" title="Simplify By Decoration"><input type="checkbox" id="simplifyByDecorationCheckbox" tabindex="-1"><span class="customCheckbox"></span>Simplify</label>
			<div id="currentBtn" title="Current"></div>
			<div id="findBtn" title="Find"></div>
			<div id="terminalBtn" title="Open a Terminal for this Repository"></div>
			<div id="settingsBtn" title="Repository Settings"></div>
			<div id="fetchBtn"></div>
			<div id="refreshBtn"></div>
			</div>
	</div>
	<div id="content">
		<div id="commitGraph"></div>
		<div id="commitTable"></div>
	</div>
	<div id="footer"></div>
</div>`;

  // JSON payloads embedded in an inline script: escape `<` so repo names or
  // palette values can never break out of the script element.
  const embed = (value: object) => JSON.stringify(value).replace(/</g, "\\u003c");
  const boot = `var initialState=${embed(initialState)}, globalState=${embed(DEFAULT_GLOBAL_VIEW_STATE)}, workspaceState=${embed(DEFAULT_WORKSPACE_VIEW_STATE)}, ompwebGgBoot=${embed({ apiBase: "/api/git-graph", repo })};`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Git Graph</title>
<link rel="stylesheet" type="text/css" href="/gitgraph/gitgraph.css">
<style>
html{--vscode-font-family:var(--font-sans, ui-sans-serif, system-ui, sans-serif);--vscode-editor-font-family:var(--font-mono, ui-monospace, monospace);}
:root{${colorVars}}
${colorParams}
body{margin:0;padding:0;overflow:auto;background:#F2F0EA;color:#3d3a34;font-family:var(--vscode-font-family);font-size:13px;}
html[data-omp-dark="1"] body{background:#231F1B;color:#dcd5cb;}
</style>
</head>
${body}
<script>${boot}</script>
<script src="/gitgraph/gitgraph.js" defer></script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "SAMEORIGIN",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'; font-src 'self'",
    },
  });
}
