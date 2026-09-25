export type GitFileStatusKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflict";

export interface GitFileStatus {
  filePath: string;
  status: GitFileStatusKind;
  code: "M" | "A" | "D" | "R" | "U" | "C";
  indexStatus: string;
  worktreeStatus: string;
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
}
