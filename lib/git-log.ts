import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 15_000;
const GIT_LOG_MAX_BUFFER = 16 * 1024 * 1024;
const DIFF_DISPLAY_MAX_BYTES = 1024 * 1024;

// Well-known empty tree hash (git hash-object -t tree /dev/null) — the base
// for diffing a root commit.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const SEP = "\x1f";
const REC_END = "\x1e";
const NUMSTAT_RE = /^(\d+|-)\t(\d+|-)\t(.+)$/;
const NUMSTAT_LINE_RE = /^[|/.\\o ]*(\d+|-)\t(\d+|-)\t(.+)$/;

async function git(cwd: string, args: string[], maxBuffer = GIT_LOG_MAX_BUFFER): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
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

export interface GitCommitRefs {
  head: string | null;
  branches: string[];
  remote: string[];
  tags: string[];
}

export interface GitCommitFile {
  path: string;
  additions: number | null;
  deletions: number | null;
}

export interface GitCommitInfo {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
  refs: GitCommitRefs;
  isMerge: boolean;
  files: GitCommitFile[];
}

/**
 * One row of the rendered graph. `graph` is the per-lane character state of
 * this visual row (from `git log --graph`):
 *   L  vertical line ("|")
 *   C  commit node ("*")
 *   o  merge point ("o")
 *   .  side-branch commit marker (".")
 *   /  right-going diagonal
 *   \  left-going diagonal
 *   -  horizontal connector
 */
export type GitGraphRow =
  | { kind: "commit"; commit: GitCommitInfo; graph: string[] }
  | { kind: "gap"; graph: string[] };

function parseLaneChar(ch: string): string {
  switch (ch) {
    case "|": return "L";
    case "*": return "C";
    case "o": return "o";
    case ".": return ".";
    case "/": return "/";
    case "\\": return "\\";
    case "-": return "-";
    default: return " ";
  }
}

function parseGraphLanes(line: string, throughIndex: number): string[] {
  const lanes: string[] = [];
  for (let i = 0; i <= throughIndex; i++) lanes.push(parseLaneChar(line[i]));
  return lanes;
}

function parseRefs(decoration: string): GitCommitRefs {
  const refs: GitCommitRefs = { head: null, branches: [], remote: [], tags: [] };
  if (!decoration) return refs;
  const start = decoration.indexOf("(");
  const end = decoration.lastIndexOf(")");
  if (start === -1 || end <= start) return refs;
  for (const raw of decoration.slice(start + 1, end).split(",")) {
    const item = raw.trim();
    if (!item) continue;
    const headMatch = item.match(/^HEAD -> (\S+)$/);
    if (headMatch) {
      refs.head = headMatch[1];
      continue;
    }
    if (item === "HEAD") {
      refs.head = "(detached)";
      continue;
    }
    if (item === "origin/HEAD" || item.startsWith("origin/HEAD ->")) continue;
    const tagMatch = item.match(/^tag: (.+)$/);
    if (tagMatch) {
      refs.tags.push(tagMatch[1]);
      continue;
    }
    if (item.includes("/")) {
      refs.remote.push(item);
      continue;
    }
    refs.branches.push(item);
  }
  return refs;
}

function parseRecord(rec: string): GitCommitInfo {
  const payload = rec.endsWith(REC_END) ? rec.slice(0, -1) : rec;
  const fields = payload.split(SEP);
  const [hashRaw = "", _short = "", parents = "", author = "", email = "", date = "", subject = "", body = "", decoration = ""] = fields;
  // The first field is %H, but on multi-lane commit rows the graph padding to
  // the right of the star bleeds into it ("| | | | <hash>"), so anchor on the
  // 40-hex hash itself rather than the raw field.
  const hash = (hashRaw.match(/[0-9a-f]{40}/) ?? [""])[0];
  const parentList = parents.split(" ").filter(Boolean);
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents: parentList,
    author,
    email,
    date,
    subject,
    body: body.replace(/\n+$/, ""),
    refs: parseRefs(decoration),
    isMerge: parentList.length > 1,
    files: [],
  };
}

/**
 * Commit history with graph geometry, parsed from `git log --all --graph
 * --numstat`. Rows keep git's own topological order (newest first); gap rows
 * carry the connectors between commits.
 */
export async function getGitCommitLog(cwd: string, limit = 400): Promise<{ rows: GitGraphRow[]; maxLane: number }> {
  const root = await findRepositoryRoot(cwd);
  if (!root) throw new Error("Not a Git repository");
  const format = `%H${SEP}%h${SEP}%P${SEP}%an${SEP}%ae${SEP}%aD${SEP}%s${SEP}%b${SEP}%d${REC_END}`;
  const clampedLimit = Math.min(2000, Math.max(1, limit));
  const output = await git(root, [
    "log", "--all", "--graph", "--numstat", "--date=iso", `--format=${format}`, `-${clampedLimit}`,
  ]);

  const lines = output.split(/\r?\n/);
  const rows: GitGraphRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Commit rows: only graph characters may precede the star (a numstat
    // file path may itself contain "*").
    const star = /^[|/.\\ ]*\*/.test(line) ? line.indexOf("*") : -1;
    if (star !== -1) {
      const lanes = parseGraphLanes(line, star);
      // The format record may span several physical lines (%b carries raw
      // newlines) — it ends at the line carrying the record-end marker. The
      // star is followed by one space plus the graph-width padding.
      let rec = line.slice(star + 1).replace(/^ +/, "");
      let j = i;
      while (!rec.endsWith(REC_END) && j + 1 < lines.length) {
        j++;
        rec += `\n${lines[j]}`;
      }
      const commit = parseRecord(rec);
      i = j + 1;
      // The zone up to the next commit row holds this commit's numstat lines
      // (carrying the graph-lane prefix) plus the pure connector rows between
      // this commit and the next one.
      const zoneGaps: string[] = [];
      while (i < lines.length && !/^[|/.\\ ]*\*/.test(lines[i])) {
        const m = NUMSTAT_LINE_RE.exec(lines[i]);
        if (m) {
          commit.files.push({
            path: m[3],
            additions: m[1] === "-" ? null : Number(m[1]),
            deletions: m[2] === "-" ? null : Number(m[2]),
          });
        } else if (lines[i].length > 0 && /^[ |o./\\-]*$/.test(lines[i])) {
          zoneGaps.push(lines[i]);
        }
        i++;
      }
      rows.push({ kind: "commit", commit, graph: lanes });
      for (const zg of zoneGaps) {
        rows.push({ kind: "gap", graph: parseGraphLanes(zg, zg.length - 1) });
      }
      continue;
    }
    // Pure graph row (connectors) — skip blank / non-graph lines.
    if (line.length > 0 && /^[ |*o./\\-]*$/.test(line)) {
      const last = line.length - 1;
      rows.push({ kind: "gap", graph: parseGraphLanes(line, last) });
    }
    i++;
  }

  let maxLane = 1;
  for (const row of rows) maxLane = Math.max(maxLane, row.graph.length);
  // Trim trailing all-empty gap rows.
  while (rows.length > 0 && rows[rows.length - 1].kind === "gap" && rows[rows.length - 1].graph.every((c) => c === " ")) {
    rows.pop();
  }
  return { rows, maxLane };
}

export interface GitCommitFileDiff {
  diff: string;
  binary: boolean;
  truncated: boolean;
}

/**
 * Per-file unified diff for one commit (against its first parent; root
 * commits diff against the empty tree).
 */
export async function getCommitFileDiff(cwd: string, hash: string, filePath: string): Promise<GitCommitFileDiff> {
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
  return {
    diff: truncated ? `${output.slice(0, DIFF_DISPLAY_MAX_BYTES)}\n\n... (diff truncated) ...` : output,
    binary,
    truncated,
  };
}
