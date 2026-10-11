// Contents readers for the Copilot-style diff view: the two file versions
// behind a diff let the client materialize hidden context lines instantly
// (`N hidden lines` expansion) without re-diffing per click.
//
// Local git only. The Rust host daemon exposes just the working-tree diff
// (doc 16 route 10, parity frozen by lib/git-parity.test.mjs); every
// contents-enabled request answers from the local git binary, exactly like
// the commit-file and ref-compare diff modes already do.
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const SIZE_TIMEOUT_MS = 10_000;
const READ_TIMEOUT_MS = 30_000;

/** One file side's byte cap; beyond it no contents are served and the UI
 *  keeps the hidden-lines bars static. */
export const DIFF_CONTENTS_MAX_BYTES = 2 * 1024 * 1024;

export interface DiffSideContents {
  /** File text; null when the side does not exist (added/deleted file), is
   *  binary, or could not be read. */
  text: string | null;
  /** True only when the side was excluded for exceeding the size cap. */
  oversize: boolean;
}

const MISSING: DiffSideContents = { text: null, oversize: false };

// Text-mode stdout everywhere: `execFile` delivers a string here, and the
// binary sniff must be a "\0" SUBSTRING check — `String.includes(0)` would
// coerce to the character "0" and misbrand every file containing a digit.
async function gitText(cwd: string, args: string[], timeout: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-c", "safe.directory=*", "-C", cwd, ...args], {
      timeout,
      maxBuffer: DIFF_CONTENTS_MAX_BYTES + 4096,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    });
    return stdout;
  } catch {
    return null;
  }
}

/** Blob `rev:path` as text. `rev` arrives only from validated refs/hashes. */
export async function readRefFile(repositoryRoot: string, rev: string, relPath: string): Promise<DiffSideContents> {
  const sizeOut = await gitText(repositoryRoot, ["cat-file", "-s", `${rev}:${relPath}`], SIZE_TIMEOUT_MS);
  if (sizeOut === null) return MISSING;
  const size = Number(sizeOut.trim());
  if (!Number.isFinite(size) || size < 0) return MISSING;
  if (size > DIFF_CONTENTS_MAX_BYTES) return { text: null, oversize: true };
  const blob = await gitText(repositoryRoot, ["cat-file", "blob", `${rev}:${relPath}`], READ_TIMEOUT_MS);
  if (blob === null || blob.includes("\0")) return MISSING;
  return { text: blob, oversize: false };
}

/** The on-disk working file. */
export function readWorkingFile(repositoryRoot: string, relPath: string): DiffSideContents {
  const filePath = path.join(repositoryRoot, ...relPath.split("/"));
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return MISSING;
  }
  if (!stat.isFile()) return MISSING;
  if (stat.size > DIFF_CONTENTS_MAX_BYTES) return { text: null, oversize: true };
  try {
    const text = fs.readFileSync(filePath, "utf8");
    if (text.includes("\0")) return MISSING;
    return { text, oversize: false };
  } catch {
    return MISSING;
  }
}

/**
 * Contents fields for a diff response. Gap materialization needs BOTH file
 * sides, so one oversize side omits the whole set with the truncation flag
 * instead of shipping a half-model.
 */
export function mergeDiffContents(
  oldSide: DiffSideContents,
  newSide: DiffSideContents,
): { oldText?: string | null; newText?: string | null; contentsTruncated?: boolean } {
  if (oldSide.oversize || newSide.oversize) return { contentsTruncated: true };
  return { oldText: oldSide.text, newText: newSide.text };
}
