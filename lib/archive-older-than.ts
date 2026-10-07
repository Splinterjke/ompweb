import { comparableProjectPath } from "./comparable-path";

/** Age buckets offered by the workspace "Archive older than" menu. */
export type ArchiveOlderThanBucket = "1w" | "2w" | "1m" | "3m";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Fixed-length approximations (weeks are 7 days, months 30 days) so a bucket
 *  means the same duration regardless of where in the calendar it is clicked. */
export const ARCHIVE_OLDER_THAN_BUCKET_MS: Record<ArchiveOlderThanBucket, number> = {
  "1w": 7 * DAY_MS,
  "2w": 14 * DAY_MS,
  "1m": 30 * DAY_MS,
  "3m": 90 * DAY_MS,
};

export function isArchiveOlderThanBucket(value: unknown): value is ArchiveOlderThanBucket {
  return typeof value === "string" && Object.hasOwn(ARCHIVE_OLDER_THAN_BUCKET_MS, value);
}

/** The subset of `SessionInfo` the selection needs (kept structural so tests
 *  and callers can pass plain fixtures). */
export interface ArchiveCandidateSession {
  id: string;
  cwd: string;
  /** ISO timestamp of last file activity — the age the buckets compare against. */
  modified: string;
  parentSessionId?: string;
  projectRoot?: string;
}

/** `external` and `children` come from the pure selection; the archive route
 *  appends `error` when an individual file move fails mid-batch. */
export type BulkArchiveSkipReason = "external" | "children" | "error";

export interface BulkArchiveSkip {
  id: string;
  reason: BulkArchiveSkipReason;
  /** Failure message for `reason: "error"` entries. */
  detail?: string;
}

export interface BulkArchiveSelection<T> {
  /** Sessions to archive, children ordered before their parents so a parent
   *  file is never moved while a child of the same run still points at it. */
  targets: T[];
  skipped: BulkArchiveSkip[];
}

/**
 * Pure selection for the workspace "Archive older than" action.
 *
 * Rules:
 * - only sessions of the given project (`projectKey`, comparable form, matched
 *   against `projectRoot ?? cwd`) whose last activity predates `cutoffMs`;
 * - sessions held by a live external `omp` process are skipped — the web
 *   server has no channel to stop that process, and moving the file out from
 *   under it would resurrect it on the holder's next write;
 * - a session is skipped (with its ancestors, transitively) when it has at
 *   least one child that will NOT be archived alongside it (a newer child, an
 *   externally held child, …): archiving such a parent would leave the child's
 *   branch metadata pointing at a path that no longer exists.
 */
export function selectSessionsForBulkArchive<T extends ArchiveCandidateSession>(
  sessions: readonly T[],
  options: { projectKey: string; cutoffMs: number; externallyHeld: ReadonlySet<string> },
): BulkArchiveSelection<T> {
  const aged: T[] = [];
  for (const session of sessions) {
    const root = session.projectRoot ?? session.cwd;
    if (comparableProjectPath(root) !== options.projectKey) continue;
    const modifiedAt = Date.parse(session.modified);
    // An unparseable timestamp must never make a session look "old".
    if (!Number.isFinite(modifiedAt) || modifiedAt >= options.cutoffMs) continue;
    aged.push(session);
  }

  const skipped: BulkArchiveSkip[] = [];
  const selected = new Set<string>();
  for (const session of aged) {
    if (options.externallyHeld.has(session.id)) {
      skipped.push({ id: session.id, reason: "external" });
    } else {
      selected.add(session.id);
    }
  }

  // Fixpoint: a selected parent whose child will survive (the child is not in
  // `selected` — newer, external-skipped, or itself just dropped here) must be
  // dropped too; dropping a parent can orphan ITS parent, so re-scan until
  // stable.
  for (;;) {
    let dropped = false;
    for (const session of sessions) {
      const parentId = session.parentSessionId;
      if (!parentId || !selected.has(parentId)) continue;
      if (selected.has(session.id)) continue; // child archives with the parent
      selected.delete(parentId);
      skipped.push({ id: parentId, reason: "children" });
      dropped = true;
    }
    if (!dropped) break;
  }

  // Children-before-parents topological order (parents whose remaining
  // children are all selected form the first wave, and so on inward).
  const targets: T[] = [];
  let remaining = aged.filter((session) => selected.has(session.id));
  while (remaining.length > 0) {
    const wave = remaining.filter(
      (parent) => !remaining.some((child) => child.parentSessionId === parent.id),
    );
    if (wave.length === 0) {
      // Defensive: a parentSessionId cycle cannot come from omp's tree format;
      // archive what is left rather than loop forever.
      targets.push(...remaining);
      break;
    }
    targets.push(...wave);
    const done = new Set(wave.map((session) => session.id));
    remaining = remaining.filter((session) => !done.has(session.id));
  }

  return { targets, skipped };
}
