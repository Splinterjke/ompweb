// Reads every value through vscode.workspace.getConfiguration with the
// literal fallbacks below; this module freezes exactly those fallbacks so the
// webview boots with upstream's stock behaviour. Every literal was lifted from
// the corresponding `Config` getter.
import {
  CommitDetailsViewLocation,
  CommitOrdering,
  DateFormatType,
  FileViewType,
  GitResetMode,
  GraphStyle,
  GraphUncommittedChangesStyle,
  RepoDropdownOrder,
  TagType
} from "@/vendor/vscode-git-graph/types";
import type { GitGraphViewConfig } from "@/vendor/vscode-git-graph/types";

/**
 * The graph lane palette: upstream's built-in default colour set (the
 * fallback in the `Config.graph` getter of src/config.ts, used when the
 * `git-graph.graph.colours` setting is empty). Note: this set supersedes the
 * candidate list sketched during port planning because the contract required
 * upstream's actual default palette, and upstream's is this one. The webview
 * boot maps these onto the --git-graph-color0..N CSS variables.
 */
export const DEFAULT_LIGHT_PALETTE: ReadonlyArray<string> = [
  "#0085d9", "#d9008f", "#00d90a", "#d98500", "#a300d9", "#ff0000",
  "#00d9cc", "#e138e8", "#85d900", "#dc5b23", "#6f24d6", "#ffcc00"
];

/**
 * The full Git Graph View configuration with upstream's out-of-the-box
 * defaults (what a fresh VS Code install would hand the webview through
 * `initialState.config` in BaseGitGraphView.getHtmlForView).
 */
export function defaultGitGraphViewConfig(): GitGraphViewConfig {
  return {
    // Config.commitDetailsView
    commitDetailsView: {
      autoCenter: true,
      autoScroll: true,
      fileTreeCompactFolders: true,
      fileViewType: FileViewType.Tree,
      location: CommitDetailsViewLocation.Inline
    },
    // Config.commitOrder ('date')
    commitOrdering: CommitOrdering.Date,
    // Config.contextMenuActionsVisibility (all actions on)
    contextMenuActionsVisibility: {
      branch: { checkout: true, rename: true, delete: true, merge: true, rebase: true, push: true, pull: true, createBranch: true, viewIssue: true, createPullRequest: true, createArchive: true, selectInBranchesDropdown: true, unselectInBranchesDropdown: true, copyName: true },
      commit: { addTag: true, createBranch: true, checkout: true, cherrypick: true, revert: true, drop: true, merge: true, rebase: true, reset: true, undo: true, editMessage: true, copyHash: true, copySubject: true },
      commitDetailsViewFile: { viewDiff: true, viewFileAtThisRevision: true, viewDiffWithWorkingFile: true, openFile: true, markAsReviewed: true, markAsNotReviewed: true, resetFileToThisRevision: true, copyAbsoluteFilePath: true, copyRelativeFilePath: true },
      remoteBranch: { checkout: true, delete: true, fetch: true, merge: true, pull: true, createBranch: true, viewIssue: true, createPullRequest: true, createArchive: true, selectInBranchesDropdown: true, unselectInBranchesDropdown: true, copyName: true },
      stash: { apply: true, createBranch: true, pop: true, drop: true, copyName: true, copyHash: true },
      tag: { viewDetails: true, delete: true, push: true, createArchive: true, copyName: true },
      uncommittedChanges: { stash: true, reset: true, clean: true, openSourceControlView: true }
    },
    customBranchGlobPatterns: [],
    customEmojiShortcodeMappings: [],
    customPullRequestProviders: [],
    // Config.dateFormat ('Date & Time')
    dateFormat: { type: DateFormatType.DateAndTime, iso: false },
    // Config.defaultColumnVisibility
    defaultColumnVisibility: { author: true, commit: true, date: true },
    // Config.dialogDefaults (every per-dialog fallback)
    dialogDefaults: {
      addTag: {
        pushToRemote: false,
        type: TagType.Annotated
      },
      applyStash: {
        reinstateIndex: false
      },
      cherryPick: {
        noCommit: false,
        recordOrigin: false
      },
      createBranch: {
        checkout: false
      },
      deleteBranch: {
        forceDelete: false
      },
      fetchIntoLocalBranch: {
        forceFetch: false
      },
      fetchRemote: {
        prune: false,
        pruneTags: false
      },
      general: {
        referenceInputSpaceSubstitution: null
      },
      merge: {
        noCommit: false,
        noFastForward: true,
        allowUnrelatedHistories: false,
        squash: false
      },
      popStash: {
        reinstateIndex: false
      },
      pullBranch: {
        noFastForward: false,
        squash: false
      },
      rebase: {
        ignoreDate: true,
        interactive: false
      },
      resetCommit: {
        mode: GitResetMode.Mixed
      },
      resetUncommitted: {
        mode: GitResetMode.Mixed
      },
      stashUncommittedChanges: {
        includeUntracked: true
      }
    },
    // Config.enhancedAccessibility
    enhancedAccessibility: false,
    // Config.fetchAndPrune
    fetchAndPrune: false,
    // Config.fetchAndPruneTags
    fetchAndPruneTags: false,
    // Config.fetchAvatars (avatar fetching stays off; the port performs no
    // network I/O, so fetchAvatars must never enable outbound requests).
    fetchAvatars: false,
    // Config.graph
    graph: {
      colours: DEFAULT_LIGHT_PALETTE,
      style: GraphStyle.Rounded,
      grid: { x: 16, y: 24, offsetX: 16, offsetY: 12, expandY: 250 },
      uncommittedChanges: GraphUncommittedChangesStyle.OpenCircleAtTheUncommittedChanges
    },
    // Config.includeCommitsMentionedByReflogs
    includeCommitsMentionedByReflogs: false,
    // Config.initialLoadCommits
    initialLoadCommits: 300,
    // Config.keybindings (getKeybinding default keys)
    keybindings: {
      find: "f",
      refresh: "r",
      scrollToHead: "h",
      scrollToStash: "s"
    },
    // Config.loadMoreCommits
    loadMoreCommits: 100,
    // Config.loadMoreCommitsAutomatically
    loadMoreCommitsAutomatically: true,
    // Config.markdown
    markdown: true,
    // Config.muteCommits
    mute: {
      commitsNotAncestorsOfHead: false,
      mergeCommits: true
    },
    // Config.onlyFollowFirstParent
    onlyFollowFirstParent: false,
    // Config.onRepoLoad
    onRepoLoad: {
      scrollToHead: false,
      showCheckedOutBranch: false,
      showSpecificBranches: []
    },
    // Config.referenceLabels ('Normal' alignment)
    referenceLabels: {
      branchLabelsAlignedToGraph: false,
      combineLocalAndRemoteBranchLabels: true,
      tagLabelsOnRight: false
    },
    // Config.repoDropdownOrder ('Workspace Full Path')
    repoDropdownOrder: RepoDropdownOrder.WorkspaceFullPath,
    // Config.singleAuthorSelect
    singleAuthorSelect: true,
    // Config.singleBranchSelect
    singleBranchSelect: true,
    // Config.showRemoteBranches
    showRemoteBranches: true,
    // Config.simplifyByDecoration
    simplifyByDecoration: false,
    // Config.showStashes
    showStashes: true,
    // Config.showTags
    showTags: true,
    // Config.stickyHeader
    stickyHeader: true,
    // Config.toolbarButtonVisibility
    toolbarButtonVisibility: {
      remotes: true,
      simplify: true,
      pathFilter: true
    }
  };
}
