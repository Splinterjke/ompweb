// Per-file +/- line stats for the Git tab's file list (Copilot-style row
// chips). Computed in the status ROUTE — the Node implementation and the
// Rust host status JSON are deep-equal-pinned by lib/git-parity.test.mjs,
// so neither may grow these fields; the route augments whichever shape it
// got with the same post-processing. Stats are additive: any failure just
// leaves the fields undefined, never fails a status poll.
import fs from "fs";
import { execFile } from "child_process";
import path from "path";
import { promisify } from "util";
import type { GitStatusResponse } from "./git-types.ts";

const execFileAsync = promisify(execFile);
const NUMSTAT_TIMEOUT_MS = 20_000;
// Line counting of untracked files is bounded: huge files and very large
// change sets skip the count instead of turning the 5 s poll into a scan.
const UNTRACKED_LINE_SCAN_MAX_BYTES = 1024 * 1024;
const MAX_COUNTED_UNTRACKED_FILES = 200;

interface FileStats {
  added: number;
  deleted: number;
}

/**
 * Parse `git diff HEAD --numstat -z`: `added\tdeleted\tpath\0`, with renames
 * as `added\tdeleted\t\0old\0new\0`; `-` counts (binary) read as 0.
 */
function parseNumstatZ(output: string): Map<string, FileStats> {
  const stats = new Map<string, FileStats>();
  const parts = output.split("\0");
  let i = 0;
  while (i < parts.length) {
    const header = parts[i];
    i++;
    if (!header) continue;
    const match = header.match(/^(-|\d+)\t(-|\d+)\t(.*)$/);
    if (!match) continue;
    const value = {
      added: match[1] === "-" ? 0 : Number(match[1]),
      deleted: match[2] === "-" ? 0 : Number(match[2]),
    };
    if (match[3] === "") {
      // Rename/copy: the two NUL-separated paths follow; key on the new path.
      const newPath = parts[i + 1];
      i += 2;
      if (newPath) stats.set(newPath, value);
      continue;
    }
    stats.set(match[3], value);
  }
  return stats;
}

function countFileLines(filePath: string): number | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > UNTRACKED_LINE_SCAN_MAX_BYTES) return null;
    const content = fs.readFileSync(filePath, "utf8");
    if (content === "") return 0;
    const lines = content.split("\n").length;
    return content.endsWith("\n") ? lines - 1 : lines;
  } catch {
    return null;
  }
}

/** Attach `added`/`deleted` to every status file the stats cover. */
export async function applyPerFileStats(status: GitStatusResponse): Promise<GitStatusResponse> {
  if (!status.isGitRepository || !status.repositoryRoot || status.files.length === 0) return status;
  let byAbsolutePath: Map<string, FileStats>;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-c", "safe.directory=*", "-C", status.repositoryRoot, "diff", "HEAD", "--numstat", "-z"],
      { timeout: NUMSTAT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } },
    );
    byAbsolutePath = new Map(
      [...parseNumstatZ(String(stdout)).entries()].map(([rel, value]) => [path.resolve(status.repositoryRoot!, rel), value]),
    );
  } catch {
    return status;
  }
  let countedUntracked = 0;
  for (const file of status.files) {
    const tracked = byAbsolutePath.get(file.filePath);
    if (tracked) {
      file.added = tracked.added;
      file.deleted = tracked.deleted;
      continue;
    }
    if (file.status === "untracked" && countedUntracked < MAX_COUNTED_UNTRACKED_FILES) {
      countedUntracked++;
      const lines = countFileLines(file.filePath);
      if (lines !== null) file.added = lines;
    }
  }
  return status;
}
