import { execFile } from "child_process";
import { promisify } from "util";
import { mergeDiffContents, readRefFile, readWorkingFile } from "./git-blob.ts";
const execFileAsync = promisify(execFile);

// `git diff` on large files is the heaviest call here; diff output is capped
// by DIFF_DISPLAY_MAX_BYTES regardless.
const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const DIFF_DISPLAY_MAX_BYTES = 1024 * 1024;

// Well-known empty tree hash (git hash-object -t tree /dev/null) — the base
// for diffing a root commit.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

async function git(cwd: string, args: string[], maxBuffer = GIT_MAX_BUFFER): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-c", "safe.directory=*", "-C", cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout;
}

async function findRepositoryRoot(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ["rev-parse", "--show-toplevel"], 1024 * 1024)).trim() || null;
  } catch {
    return null;
  }
}

export interface GitCommitFileDiff {
  diff: string;
  binary: boolean;
  truncated: boolean;
  /** Both file versions with `withContents`; null: side missing (added /
   *  deleted file), binary or unreadable. Omitted together when either
   *  side exceeds the contents size cap (`contentsTruncated`). */
  oldText?: string | null;
  newText?: string | null;
  contentsTruncated?: boolean;
}

/**
 * Per-file unified diff for one commit (against its first parent; root
 * commits diff against the empty tree).
 */
export async function getCommitFileDiff(cwd: string, hash: string, filePath: string, withContents = false): Promise<GitCommitFileDiff> {
  const root = await findRepositoryRoot(cwd);
  if (!root) throw new Error("Not a Git repository");
  if (!/^[0-9a-f]{7,40}$/.test(hash)) throw new Error("Invalid commit hash");
  if (!filePath || filePath.includes("\0") || filePath.startsWith("/") || filePath.split("/").includes("..")) {
    throw new Error("Invalid file path");
  }
  const parentCheck = await git(root, ["rev-parse", "--verify", "--quiet", `${hash}^`], 1024 * 1024).catch(() => "");
  const base = parentCheck.trim() ? `${hash}^` : EMPTY_TREE;
  const output = await git(root, ["diff", "--no-color", base, hash, "--", filePath]);
  const binary = /^Binary files /m.test(output);
  const truncated = output.length > DIFF_DISPLAY_MAX_BYTES;
  const result: GitCommitFileDiff = {
    diff: truncated ? `${output.slice(0, DIFF_DISPLAY_MAX_BYTES)}\n\n... (diff truncated) ...` : output,
    binary,
    truncated,
  };
  if (withContents) {
    const [oldSide, newSide] = await Promise.all([
      readRefFile(root, base, filePath),
      readRefFile(root, hash, filePath),
    ]);
    Object.assign(result, mergeDiffContents(oldSide, newSide));
  }
  return result;
}

/**
 * Git Graph view-diff ref: a branch name, tag, commit hash, `HEAD` (with
 * optional `~N` / `^N` ancestry), or `stash@{N}`. Deliberately strict — refs
 * arrive from the webview, are only ever passed as spawn arguments (never
 * through a shell), and are additionally verified by `git rev-parse`.
 */
function isSafeGitRef(ref: string): boolean {
  if (ref.length === 0 || ref.length > 255) return false;
  if (/^[\\.@/-]/.test(ref) || /[\s\0:?*[\\]/.test(ref)) return false;
  if (ref.includes("..") || ref.includes("//") || ref.includes("@{")) {
    return /^stash@\{\d+\}$/.test(ref);
  }
  return !ref.endsWith("/") && !ref.endsWith(".") && !ref.endsWith(".lock");
}

/**
 * Per-file unified diff between two refs; `to = "*"` diffs against the working
 * tree. Powers the embedded Git Graph view-diff actions (commit vs commit,
 * commit vs working tree, HEAD vs branch).
 */
export async function getGitRefDiff(cwd: string, from: string, to: string, filePath: string, withContents = false): Promise<GitCommitFileDiff> {
  const root = await findRepositoryRoot(cwd);
  if (!root) throw new Error("Not a Git repository");
  if (!isSafeGitRef(from)) throw new Error("Invalid source ref");
  if (to !== "*" && !isSafeGitRef(to)) throw new Error("Invalid target ref");
  if (!filePath || filePath.includes("\0") || filePath.startsWith("/") || filePath.split("/").includes("..")) {
    throw new Error("Invalid file path");
  }
  await git(root, ["rev-parse", "--verify", "--quiet", `${from}^{object}`], 1024 * 1024).catch(() => {
    throw new Error(`Unknown ref: ${from}`);
  });
  if (to !== "*") {
    await git(root, ["rev-parse", "--verify", "--quiet", `${to}^{object}`], 1024 * 1024).catch(() => {
      throw new Error(`Unknown ref: ${to}`);
    });
  }
  const args = to === "*" ? ["diff", "--no-color", from, "--", filePath] : ["diff", "--no-color", from, to, "--", filePath];
  const output = await git(root, args);
  const binary = /^Binary files /m.test(output);
  const truncated = output.length > DIFF_DISPLAY_MAX_BYTES;
  const result: GitCommitFileDiff = {
    diff: truncated ? `${output.slice(0, DIFF_DISPLAY_MAX_BYTES)}\n\n... (diff truncated) ...` : output,
    binary,
    truncated,
  };
  if (withContents) {
    const [oldSide, newSide] = await Promise.all([
      readRefFile(root, from, filePath),
      to === "*" ? Promise.resolve(readWorkingFile(root, filePath)) : readRefFile(root, to, filePath),
    ]);
    Object.assign(result, mergeDiffContents(oldSide, newSide));
  }
  return result;
}
