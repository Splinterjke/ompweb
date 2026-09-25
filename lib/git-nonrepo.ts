// A git operation against a directory that is not a git repository is a
// normal situation (plain folders are common workspaces), not a backend
// failure. The Rust host signals it with the structured `not_a_git_repository`
// error code; the Node fallback throws a plain Error("Not a Git repository").
// Neither may be recorded in the backend error ring — doing so degrades the
// whole app ("Degraded" banner + Recovery queue) for every file open in a
// non-git workspace.
export function isNonRepositoryError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === "not_a_git_repository" ||
    (typeof message === "string" && message === "Not a Git repository");
}

// Git route kinds that can carry a non-repo entry. Only used to scope the
// benign-entry check below (a non-repo message from any other domain is
// treated as a real failure).
const GIT_ERROR_KINDS = [
  "git_status_failed",
  "git_branches_failed",
  "git_checkout_failed",
  "git_commit_failed",
  "git_push_failed",
  "git_diff_failed",
];

// The exact ring `detail` produced when a git op hits a non-repo. The Rust
// host maps NotARepository to this message; the route layer now skips
// recording it, so this only matters for entries that landed in the ring
// before that fix (within the retention window) or from an unfixed path.
// Real failures — timeouts, `git_failed: …` — carry different details and
// are left to degrade health as intended.
const NON_REPO_DETAIL = "not a git repository";

/**
 * True for a backend-error-ring entry that is a benign non-repo git failure,
 * safe to exclude from health. Used as defense-in-depth: even a stale
 * non-repo entry (recorded before the routes learned to skip it) must not
 * flip the banner to Degraded.
 */
export function isBenignNonRepoEntry(entry: { kind?: unknown; detail?: unknown }): boolean {
  return (
    typeof entry.kind === "string" &&
    GIT_ERROR_KINDS.includes(entry.kind) &&
    entry.detail === NON_REPO_DETAIL
  );
}

// Read-only git operations (status polling, branch listing, file diffs) are
// fired automatically by the background — the composer bar and the Git tab
// poll every 5 s, the sidebar probes projects, the file viewer previews
// diffs — and their failure is always visible at the point of use (an empty
// bar, an inline panel error). Counting them in the health math would turn a
// slow or transiently locked repository into an app-wide "Degraded" banner,
// so they are excluded from health just like the non-repo entries above.
// Write operations (checkout / commit / push) remain explicit user actions
// and still degrade health on failure.
const READ_ONLY_GIT_ERROR_KINDS = [
  "git_status_failed",
  "git_branches_failed",
  "git_diff_failed",
];

/**
 * True for a backend-error-ring entry from a read-only (automatically
 * fired) git operation — safe to exclude from health.
 */
export function isBenignGitReadEntry(entry: { kind?: unknown }): boolean {
  return typeof entry.kind === "string" && READ_ONLY_GIT_ERROR_KINDS.includes(entry.kind);
}

/**
 * Ring entries to hide from the health math AND the visible UI: benign
 * non-repo entries plus read-only git failures. Used by both healthOf and
 * the diagnostics display so the badge and the error list can never
 * disagree. The raw ring stays intact for the diagnostics report, where
 * git noise is informative rather than alarming.
 * Generic so the caller's concrete entry shape (e.g. `at: number`,
 * `detail: string`) is preserved through the filter.
 */
export function filterBenignGitEntries<T extends { kind?: unknown; detail?: unknown }>(entries: T[]): T[] {
  return entries.filter((e) => !isBenignNonRepoEntry(e) && !isBenignGitReadEntry(e));
}
