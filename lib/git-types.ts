export type GitFileStatusKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflict";

/** Why `.gitattributes` moves a changed file out of the main review list. */
export type GitCollapseReason = "generated" | "vendored" | "documentation" | "no-diff";
export interface GitFileStatus {
  filePath: string;
  status: GitFileStatusKind;
  code: "M" | "A" | "D" | "R" | "U" | "C";
  indexStatus: string;
  worktreeStatus: string;
  collapseReason?: GitCollapseReason;
  /** Lines added vs HEAD for this file (`git diff HEAD --numstat`); an
   *  untracked file counts its own lines. Undefined when stats are
   *  unavailable (non-repo, no HEAD, numstat failure) — never a status failure. */
  added?: number;
  /** Lines removed vs HEAD for this file. */
  deleted?: number;
}

export interface GitStatusResponse {
  isGitRepository: boolean;
  repositoryRoot: string | null;
  files: GitFileStatus[];
  /** Lines added across tracked changes vs HEAD (`git diff HEAD --shortstat`);
   *  untracked files are not counted. */
  diffAdded?: number;
  /** Lines removed across tracked changes vs HEAD. */
  diffDeleted?: number;
  branch?: string | null;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
}

export interface GitFileDiffResponse {
  supported: boolean;
  status?: GitFileStatusKind;
  patch?: string;
  /** Working-mode fields of `contents=1` (see GitCommitFileDiff): both file
   *  versions for hidden-context expansion; omitted by default. */
  oldText?: string | null;
  newText?: string | null;
  contentsTruncated?: boolean;
}
