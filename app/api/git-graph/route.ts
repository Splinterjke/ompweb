// The vendored webview bridge forwards every non-intercepted webview command
// here as a GG.RequestMessage JSON body; this route answers with the same
// ResponseMessage JSON that upstream BaseGitGraphView.respondToMessage posts
// back to its webview. Git failures are always reported through the `error`
// / `errors` fields (HTTP 200), exactly like upstream — only access-control
// failures use HTTP status codes (same allow-list as app/api/git/status).
//
// Deviations from upstream (documented per case below):
// - The webview bridge handles clipboard / URL / file / diff / terminal /
//   view-state commands client-side; if any of them still arrive here they
//   get a defensive `{ error: "not available" }` ack.
// - Commands that drove VS Code services without a webview equivalent get
//   benign acks ("not supported") instead of throwing.
// - The per-request `repoManager` / `extensionState` / `repoFileWatcher`
//   statefulness (last-active-repo, refresh-id echo for view persistence,
//   file-watcher muting) has no meaning for a request-scoped dispatcher and
//   is omitted; the read-cache invalidator plays the watcher's role for the
//   rest of the app.
import fs from "fs";
import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { invalidateGitReadCache } from "@/lib/git-cache";
import { getDataSource } from "@/lib/git-graph/engine";
import { GitConfigKey } from "@/lib/git-graph/dataSource";
import type { DataSource } from "@/lib/git-graph/dataSource";
import { UNABLE_TO_FIND_GIT_MSG, UNCOMMITTED } from "@/lib/git-graph/shims";
import { BooleanOverride, FileViewType, GitConfigLocation, RepoCommitOrdering } from "@/vendor/vscode-git-graph/types";
import type { ErrorInfo, GitRepoState, RequestMessage } from "@/vendor/vscode-git-graph/types";

export const dynamic = "force-dynamic";

/** Default per-command budget; network-touching commands get NETWORK_TIMEOUT_MS. */
const DEFAULT_TIMEOUT_MS = 30_000;
const NETWORK_TIMEOUT_MS = 120_000;

/**
 * Default per-repository state (port of upstream DEFAULT_REPO_STATE from
 * src/extensionState.ts). There is no persistent repo manager here, so the
 * single served repo is always described by these defaults.
 */
const DEFAULT_REPO_STATE: GitRepoState = {
  cdvDivider: 0.5,
  cdvHeight: 250,
  columnWidths: null,
  commitOrdering: RepoCommitOrdering.Default,
  fileViewType: FileViewType.Default,
  hideRemotes: [],
  includeCommitsMentionedByReflogs: BooleanOverride.Default,
  issueLinkingConfig: null,
  lastImportAt: 0,
  name: null,
  onlyFollowFirstParent: BooleanOverride.Default,
  onRepoLoadShowCheckedOutBranch: BooleanOverride.Default,
  onRepoLoadShowSpecificBranches: null,
  pullRequestConfig: null,
  showRemoteBranches: true,
  showRemoteBranchesV2: BooleanOverride.Default,
  simplifyByDecoration: BooleanOverride.Default,
  showStashes: BooleanOverride.Default,
  showTags: BooleanOverride.Default,
  pathFilter: null,
  workspaceFolderIndex: null,
  isCdvSummaryHidden: false
};

/**
 * Commands whose success changes repository state; a successful response
 * invalidates the shared git read cache (same invalidator the commit/push
 * routes use) so the rest of the app stops serving stale status/log data.
 */
const MUTATING_COMMANDS: Record<string, true> = {
  addRemote: true, addTag: true, applyStash: true, branchFromStash: true, checkoutBranch: true, checkoutCommit: true,
  cherrypickCommit: true, cleanUntrackedFiles: true, createBranch: true, deleteBranch: true, deleteRemote: true,
  deleteRemoteBranch: true, deleteTag: true, deleteUserDetails: true, dropCommit: true, dropCommits: true, dropStash: true,
  squashCommits: true, editRemote: true, editUserDetails: true, fetch: true, fetchIntoLocalBranch: true, merge: true,
  popStash: true, pruneRemote: true, pullBranch: true, pushBranch: true, pushStash: true, pushTag: true, rebase: true,
  rebaseInteractive: true, renameBranch: true, resetFileToRevision: true, resetToCommit: true, revertCommit: true,
  undoLastCommit: true, editCommitMessage: true
};

function succeededResponse(response: Record<string, unknown>): boolean {
  if (Array.isArray(response.errors)) return (response.errors as ErrorInfo[]).every((error) => error === null);
  if ("error" in response) return response.error === null;
  return false;
}

/**
 * The 46 upstream switch cases this dispatcher backs with the DataSource
 * engine (45 DataSource call sites + the `loadRepos` handshake). Membership
 * is checked first in POST; everything outside this table gets an ack
 * without the repository check or the git probe.
 */
const ENGINE_COMMANDS: Record<string, true> = {
  addRemote: true, addTag: true, applyStash: true, branchFromStash: true, checkoutBranch: true, checkoutCommit: true,
  cherrypickCommit: true, cleanUntrackedFiles: true, commitDetails: true, compareCommits: true, createBranch: true,
  deleteBranch: true, deleteRemote: true, deleteRemoteBranch: true, deleteTag: true, deleteUserDetails: true,
  dropCommit: true, dropCommits: true, dropStash: true, squashCommits: true, editRemote: true, editUserDetails: true,
  fetch: true, fetchIntoLocalBranch: true, loadCommits: true, loadConfig: true, loadRepoInfo: true, loadRepos: true,
  merge: true, openExternalDirDiff: true, popStash: true, pruneRemote: true, pullBranch: true, pushBranch: true,
  pushStash: true, pushTag: true, rebase: true, getRebaseTodoList: true, rebaseInteractive: true, renameBranch: true,
  resetFileToRevision: true, resetToCommit: true, revertCommit: true, undoLastCommit: true, editCommitMessage: true,
  tagDetails: true
};

/**
 * Commands the webview bridge answers client-side (clipboard, external URLs,
 * file/diff/terminal opening, view-state persistence, workspace rescans) or
 * that drove VS Code-only services upstream, plus unknown commands. None of
 * them need the engine, so they are answered before the repository check and
 * the git probe. Every response shape matches the upstream Response* message
 * for the command so the webview handler never has to special-case the port.
 */
function nonEngineResponse(msg: RequestMessage): Record<string, unknown> {
  switch (msg.command) {
    // --- Handled by the webview bridge (ompweb-bridge.ts) -------------------
    case "copyFilePath":
    case "copyToClipboard":
    case "openExternalUrl":
    case "openFile":
    case "viewFileAtRevision":
    case "viewDiff":
    case "viewDiffWithWorkingFile":
    case "openTerminal":
    case "openExtensionSettings":
    case "setGlobalViewState":
    case "setWorkspaceViewState":
    case "rescanForRepos":
      return { command: msg.command, error: "not available" };

    // --- VS Code-only services without an engine equivalent -----------------
    case "createArchive":
      return { command: "createArchive", error: "not supported" };
    case "createPullRequest":
      // Upstream returns {push, errors}; a single ErrorInfo keeps the
      // webview's "Unable to Create Pull Request" dialog intact.
      return { command: "createPullRequest", push: msg.push, errors: ["not supported"] };
    case "startCodeReview":
      // The webview shows msg.error when error !== null and ignores the rest.
      return { command: "startCodeReview", commitHash: msg.commitHash, compareWithHash: msg.compareWithHash, codeReview: null, error: "not supported" };
    case "endCodeReview":
      return { command: "endCodeReview", error: "not supported" };
    case "updateCodeReview":
      return { command: "updateCodeReview", error: "not supported" };
    case "fetchAvatar":
      // No network avatar fetching in the port (fetchAvatars stays false);
      // `image: ""` is the webview's "no image" path.
      return { command: "fetchAvatar", email: msg.email, image: "" };
    case "showErrorMessage":
      // Upstream surfaced the message in a VS Code notification; the webview
      // already rendered its own error UI, so just log server-side.
      console.error(`[git-graph] webview error: ${typeof msg.message === "string" ? msg.message : ""}`);
      return { command: "showErrorMessage" };
    case "exportRepoConfig":
      // Upstream saved .git/graph.gitgraph via the VS Code file API.
      return { command: "exportRepoConfig", error: "not supported" };
    case "viewScm":
      return { command: "viewScm", error: "not supported" };
    case "setRepoState":
      // Upstream persisted per-repo state through RepoManager; the webview
      // keeps the state in-memory and the bridge persists view state in
      // localStorage. Nothing to do, but ack so the dispatcher is total.
      return { command: "setRepoState" };

  }

  // Unknown command (including bridge-only names that do not exist, e.g. openScm / openOutputPanel / logError):
  // defensive ack so the webview never waits on a request.
  return { command: msg.command, error: "not available" };
}

/** Copy of the status-route allow-list gate, applied to the repo path. */
async function validateRepoAccess(repo: string): Promise<NextResponse | null> {
  if (!repo || (!repo.startsWith("/") && !isWindowsAbsolutePath(repo))) {
    return NextResponse.json({ error: "repo must be an absolute path", code: "repo_must_be_absolute" }, { status: 400 });
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(repo, allowedRoots)) {
    return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(repo);
  } catch {
    return NextResponse.json({ error: "Directory not found", code: "directory_not_found" }, { status: 404 });
  }
  if (!stat.isDirectory()) {
    return NextResponse.json({ error: "Not a directory", code: "not_a_directory" }, { status: 400 });
  }
  if (!isExistingFilePathAllowed(repo, allowedRoots)) {
    return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
  }
  return null;
}

/** Per-command timeout: remote-touching commands get the longer budget. */
function timeoutForMessage(msg: RequestMessage): number {
  switch (msg.command) {
    case "addTag":
      return msg.pushToRemote !== null ? NETWORK_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
    case "checkoutBranch":
      return msg.pullAfterwards !== null ? NETWORK_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
    case "deleteBranch":
      return msg.deleteOnRemotes.length > 0 ? NETWORK_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
    case "deleteRemoteBranch":
    case "fetch":
    case "fetchIntoLocalBranch":
    case "pruneRemote":
    case "pullBranch":
    case "pushBranch":
    case "pushStash":
    case "pushTag":
      return NETWORK_TIMEOUT_MS;
    default:
      return DEFAULT_TIMEOUT_MS;
  }
}

/**
 * The engine-backed half of upstream respondToMessage: one case per upstream
 * case, calling the same DataSource methods with the same request fields.
 * `msg` is the message the webview sent (trusted shape upstream; the
 * dispatcher validates the command name, repo path and allow-list first).
 */
async function respondToMessage(msg: RequestMessage, ds: DataSource): Promise<Record<string, unknown>> {
  let errorInfos: ErrorInfo[];

  switch (msg.command) {
    case "addRemote":
      return { command: "addRemote", error: await ds.addRemote(msg.repo, msg.name, msg.url, msg.pushUrl, msg.fetch) };
    case "addTag": {
      errorInfos = [await ds.addTag(msg.repo, msg.tagName, msg.commitHash, msg.type, msg.message, msg.force)];
      if (errorInfos[0] === null && msg.pushToRemote !== null) {
        errorInfos.push(...await ds.pushTag(msg.repo, msg.tagName, [msg.pushToRemote], msg.commitHash, msg.pushSkipRemoteCheck));
      }
      return { command: "addTag", repo: msg.repo, tagName: msg.tagName, pushToRemote: msg.pushToRemote, commitHash: msg.commitHash, errors: errorInfos };
    }
    case "applyStash":
      return { command: "applyStash", error: await ds.applyStash(msg.repo, msg.selector, msg.reinstateIndex) };
    case "branchFromStash":
      return { command: "branchFromStash", error: await ds.branchFromStash(msg.repo, msg.selector, msg.branchName) };
    case "checkoutBranch": {
      errorInfos = [await ds.checkoutBranch(msg.repo, msg.branchName, msg.remoteBranch)];
      if (errorInfos[0] === null && msg.pullAfterwards !== null) {
        errorInfos.push(await ds.pullBranch(msg.repo, msg.pullAfterwards.branchName, msg.pullAfterwards.remote, msg.pullAfterwards.createNewCommit, msg.pullAfterwards.squash, msg.pullAfterwards.noVerify));
      }
      return { command: "checkoutBranch", pullAfterwards: msg.pullAfterwards, errors: errorInfos };
    }
    case "checkoutCommit":
      return { command: "checkoutCommit", error: await ds.checkoutCommit(msg.repo, msg.commitHash) };
    case "cherrypickCommit": {
      errorInfos = [await ds.cherrypickCommit(msg.repo, msg.commitHash, msg.parentIndex, msg.recordOrigin, msg.noCommit)];
      if (errorInfos[0] === null && msg.noCommit) {
        // Upstream appended the viewScm() result (VS Code SCM view); there is
        // no SCM view here, so the slot stays a null (success) placeholder.
        errorInfos.push(null);
      }
      return { command: "cherrypickCommit", errors: errorInfos };
    }
    case "cleanUntrackedFiles":
      return { command: "cleanUntrackedFiles", error: await ds.cleanUntrackedFiles(msg.repo, msg.directories) };
    case "commitDetails": {
      // Upstream also fetched the avatar in parallel (avatarManager); the
      // port performs no avatar I/O, so avatar is always null. Code reviews
      // are not persisted, so codeReview is null as well.
      const details = msg.commitHash === UNCOMMITTED
        ? await ds.getUncommittedDetails(msg.repo)
        : msg.stash === null
          ? await ds.getCommitDetails(msg.repo, msg.commitHash, msg.hasParents)
          : await ds.getStashDetails(msg.repo, msg.commitHash, msg.stash);
      return { command: "commitDetails", ...details, avatar: null, codeReview: null, refresh: msg.refresh };
    }
    case "compareCommits":
      return { command: "compareCommits", commitHash: msg.commitHash, compareWithHash: msg.compareWithHash, ...await ds.getCommitComparison(msg.repo, msg.fromHash, msg.toHash), codeReview: null, refresh: msg.refresh };
    case "createBranch":
      return { command: "createBranch", errors: await ds.createBranch(msg.repo, msg.branchName, msg.commitHash, msg.checkout, msg.force) };
    case "deleteBranch": {
      errorInfos = [await ds.deleteBranch(msg.repo, msg.branchName, msg.forceDelete)];
      if (errorInfos[0] === null) {
        for (let i = 0; i < msg.deleteOnRemotes.length; i++) {
          errorInfos.push(await ds.deleteRemoteBranch(msg.repo, msg.branchName, msg.deleteOnRemotes[i]));
        }
      }
      return { command: "deleteBranch", repo: msg.repo, branchName: msg.branchName, deleteOnRemotes: msg.deleteOnRemotes, errors: errorInfos };
    }
    case "deleteRemote":
      return { command: "deleteRemote", error: await ds.deleteRemote(msg.repo, msg.name) };
    case "deleteRemoteBranch":
      return { command: "deleteRemoteBranch", error: await ds.deleteRemoteBranch(msg.repo, msg.branchName, msg.remote) };
    case "deleteTag":
      return { command: "deleteTag", error: await ds.deleteTag(msg.repo, msg.tagName, msg.deleteOnRemote) };
    case "deleteUserDetails": {
      errorInfos = [];
      if (msg.name) {
        errorInfos.push(await ds.unsetConfigValue(msg.repo, GitConfigKey.UserName, msg.location));
      }
      if (msg.email) {
        errorInfos.push(await ds.unsetConfigValue(msg.repo, GitConfigKey.UserEmail, msg.location));
      }
      return { command: "deleteUserDetails", errors: errorInfos };
    }
    case "dropCommit":
      return { command: "dropCommit", error: await ds.dropCommit(msg.repo, msg.commitHash) };
    case "dropCommits":
      return { command: "dropCommits", error: await ds.dropCommits(msg.repo, msg.commits) };
    case "dropStash":
      return { command: "dropStash", error: await ds.dropStash(msg.repo, msg.selector) };
    case "squashCommits":
      return { command: "squashCommits", error: await ds.squashCommits(msg.repo, msg.commits, msg.commitMessage, msg.noVerify) };
    case "editRemote":
      return { command: "editRemote", error: await ds.editRemote(msg.repo, msg.nameOld, msg.nameNew, msg.urlOld, msg.urlNew, msg.pushUrlOld, msg.pushUrlNew) };
    case "editUserDetails": {
      errorInfos = [
        await ds.setConfigValue(msg.repo, GitConfigKey.UserName, msg.name, msg.location),
        await ds.setConfigValue(msg.repo, GitConfigKey.UserEmail, msg.email, msg.location)
      ];
      if (errorInfos[0] === null && errorInfos[1] === null) {
        if (msg.deleteLocalName) {
          errorInfos.push(await ds.unsetConfigValue(msg.repo, GitConfigKey.UserName, GitConfigLocation.Local));
        }
        if (msg.deleteLocalEmail) {
          errorInfos.push(await ds.unsetConfigValue(msg.repo, GitConfigKey.UserEmail, GitConfigLocation.Local));
        }
      }
      return { command: "editUserDetails", errors: errorInfos };
    }
    case "fetch":
      return { command: "fetch", error: await ds.fetch(msg.repo, msg.name, msg.prune, msg.pruneTags) };
    case "fetchIntoLocalBranch":
      return { command: "fetchIntoLocalBranch", error: await ds.fetchIntoLocalBranch(msg.repo, msg.remote, msg.remoteBranch, msg.localBranch, msg.force) };
    case "loadCommits":
      return {
        command: "loadCommits",
        refreshId: msg.refreshId,
        onlyFollowFirstParent: msg.onlyFollowFirstParent,
        ...await ds.getCommits(msg.repo, msg.branches, msg.authors, msg.maxCommits, msg.showTags, msg.showRemoteBranches, msg.includeCommitsMentionedByReflogs, msg.onlyFollowFirstParent, msg.commitOrdering, msg.remotes, msg.hideRemotes, msg.stashes, msg.simplifyByDecoration, msg.pathFilter)
      };
    case "loadConfig":
      return { command: "loadConfig", repo: msg.repo, ...await ds.getConfig(msg.repo, msg.remotes) };
    case "loadRepoInfo": {
      // Upstream additionally tracked currentRepo / lastActiveRepo and
      // (re)started the RepoFileWatcher; both are extension-lifecycle state
      // with no request-scoped counterpart.
      const repoInfo = await ds.getRepoInfo(msg.repo, msg.showRemoteBranches, msg.showStashes, msg.hideRemotes);
      let isRepo = true;
      if (repoInfo.error) {
        // If an error occurred, check to make sure the repo still exists; an
        // error caused by the repo going away is not an error to report.
        isRepo = (await ds.repoRoot(msg.repo)) !== null;
        if (!isRepo) repoInfo.error = null;
      }
      return { command: "loadRepoInfo", refreshId: msg.refreshId, ...repoInfo, isRepo };
    }
    case "merge":
      return { command: "merge", actionOn: msg.actionOn, error: await ds.merge(msg.repo, msg.obj, msg.actionOn, msg.createNewCommit, msg.allowUnrelatedHistories, msg.squash, msg.noVerify, msg.noCommit) };
    case "openExternalDirDiff":
      // Faithful mirror: the DataSource resolves the configured difftool and
      // spawns it; on a headless host it returns its usual ErrorInfo.
      return { command: "openExternalDirDiff", error: await ds.openExternalDirDiff(msg.repo, msg.fromHash, msg.toHash, msg.isGui) };
    case "popStash":
      return { command: "popStash", error: await ds.popStash(msg.repo, msg.selector, msg.reinstateIndex) };
    case "pruneRemote":
      return { command: "pruneRemote", error: await ds.pruneRemote(msg.repo, msg.name) };
    case "pullBranch":
      return { command: "pullBranch", error: await ds.pullBranch(msg.repo, msg.branchName, msg.remote, msg.createNewCommit, msg.squash, msg.noVerify) };
    case "pushBranch":
      return { command: "pushBranch", willUpdateBranchConfig: msg.willUpdateBranchConfig, errors: await ds.pushBranchToMultipleRemotes(msg.repo, msg.branchName, msg.remotes, msg.setUpstream, msg.mode, msg.noVerify) };
    case "pushStash":
      return { command: "pushStash", error: await ds.pushStash(msg.repo, msg.message, msg.includeUntracked) };
    case "pushTag":
      return { command: "pushTag", repo: msg.repo, tagName: msg.tagName, remotes: msg.remotes, commitHash: msg.commitHash, errors: await ds.pushTag(msg.repo, msg.tagName, msg.remotes, msg.commitHash, msg.skipRemoteCheck) };
    case "rebase":
      return { command: "rebase", actionOn: msg.actionOn, interactive: msg.interactive, error: await ds.rebase(msg.repo, msg.obj, msg.actionOn, msg.ignoreDate, msg.interactive, msg.signoff) };
    case "getRebaseTodoList": {
      const todoResult = await ds.getRebaseTodoList(msg.repo, msg.obj, msg.actionOn);
      return { command: "getRebaseTodoList", items: todoResult.items, error: todoResult.error };
    }
    case "rebaseInteractive":
      return { command: "rebaseInteractive", error: await ds.rebaseInteractiveWithTodo(msg.repo, msg.obj, msg.actionOn, msg.entries, msg.signoff) };
    case "renameBranch":
      return { command: "renameBranch", error: await ds.renameBranch(msg.repo, msg.oldName, msg.newName) };
    case "resetFileToRevision":
      return { command: "resetFileToRevision", error: await ds.resetFileToRevision(msg.repo, msg.commitHash, msg.filePath) };
    case "resetToCommit":
      return { command: "resetToCommit", error: await ds.resetToCommit(msg.repo, msg.commit, msg.resetMode) };
    case "revertCommit":
      return { command: "revertCommit", error: await ds.revertCommit(msg.repo, msg.commitHash, msg.parentIndex) };
    case "undoLastCommit":
      return { command: "undoLastCommit", error: await ds.undoLastCommit(msg.repo) };
    case "editCommitMessage":
      return { command: "editCommitMessage", error: await ds.editCommitMessage(msg.repo, msg.commitHash, msg.message, msg.noVerify) };
    case "tagDetails":
      return { command: "tagDetails", tagName: msg.tagName, commitHash: msg.commitHash, ...await ds.getTagDetails(msg.repo, msg.tagName) };

    // loadRepos is answered by the handshake in POST (it needs the engine
    // probe but no DataSource call); every other command was covered above.
    default:
      return { command: msg.command, error: "not available" };
  }
}

export async function POST(request: NextRequest) {
  let msg: RequestMessage;
  try {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null || !("command" in body) || typeof body.command !== "string") {
      return NextResponse.json({ error: "command is required", code: "command_required" }, { status: 400 });
    }
    msg = body as RequestMessage;
  } catch {
    return NextResponse.json({ error: "invalid JSON body", code: "invalid_body" }, { status: 400 });
  }

  // Bridge-handled, VS Code-only and unknown commands: answer without the
  // engine. These perform no repository I/O, so no allow-list check needed.
  if (!ENGINE_COMMANDS[msg.command]) {
    return NextResponse.json(nonEngineResponse(msg));
  }

  // Repository gate (mirrors app/api/git/status/route.ts) for every
  // engine-backed command. loadRepos may arrive without a repo (upstream
  // message shape); the bridge injects the boot repo into the body.
  const bootRepo = "repo" in msg && typeof msg.repo === "string" ? msg.repo : null;
  if (msg.command === "loadRepos") {
    if (bootRepo !== null) {
      const denied = await validateRepoAccess(bootRepo);
      if (denied) return denied;
    }
  } else {
    const denied = await validateRepoAccess(bootRepo ?? "");
    if (denied) return denied;
  }

  const ds = await getDataSource();

  // Boot handshake / repo set. There is no persistent RepoManager here: the
  // dispatcher serves exactly the one repository the modal was opened on, so
  // the upstream check/no-change branches collapse into a direct respond.
  if (msg.command === "loadRepos") {
    const repos = ds !== null && bootRepo !== null ? { [bootRepo]: { ...DEFAULT_REPO_STATE } } : {};
    return NextResponse.json({
      command: "loadRepos",
      repos,
      lastActiveRepo: ds !== null && bootRepo !== null ? bootRepo : null,
      loadViewTo: null,
      workspaceFolderPaths: ds !== null && bootRepo !== null ? { [bootRepo]: [] } : {}
    });
  }

  if (ds === null) {
    return NextResponse.json({ command: msg.command, error: UNABLE_TO_FIND_GIT_MSG });
  }

  // Run the dispatcher, racing the per-command timeout. On a timeout the
  // underlying call keeps running to completion in the background (the
  // DataSource enforces its own spawn timeout), and its eventual success
  // still invalidates the read cache — only the client answer is the
  // timeout error, matching the message shape of every other response.
  const run = respondToMessage(msg, ds)
    .then((response) => {
      if (MUTATING_COMMANDS[msg.command] && succeededResponse(response)) invalidateGitReadCache();
      return response;
    })
    .catch((error: unknown) => {
      return { command: msg.command, error: error instanceof Error ? error.message : String(error) };
    });

  let timer: NodeJS.Timeout | undefined = undefined;
  const raced = await Promise.race([
    run,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutForMessage(msg));
    })
  ]);
  clearTimeout(timer);

  if (raced === null) {
    return NextResponse.json({ command: msg.command, error: "Git command timed out" });
  }
  return NextResponse.json(raced);
}
