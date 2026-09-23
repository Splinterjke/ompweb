import { statSync, watch, type FSWatcher } from "fs";
import { join } from "path";
import {
  getAgentDir,
  invalidateSessionListCache,
  listAllSessions,
  resolveSessionIdByPath,
  resolveSessionPath,
} from "./session-reader";

// omp owns the writes to a session's JSONL. ompweb streams RPC events only for
// the sessions it spawned itself, so a session started outside the web UI — by
// `omp` in a terminal, or by a harness that launches omp — never updated while
// it was open: the file grew and nothing told the browser. This watches the
// session tree and reports which session ids changed, which the running-events
// stream forwards to the client.

type Listener = (sessionIds: string[]) => void;

const DEBOUNCE_MS = 250;

const listeners = new Set<Listener>();
let watcher: FSWatcher | null = null;
let pendingPaths = new Set<string>();
let pendingUnknown = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const RETRY_MS = 5000;

/**
 * Last-observed file size per session file path. A rename rewrites the
 * fixed 256-byte title slot IN PLACE — the mtime changes but the size does
 * not — so the size is the discriminator between "the file was written"
 * (external activity) and "the file was only re-titled" (no activity).
 */
const lastSizeByPath = new Map<string, number>();

type SizeChange = "new" | "title" | "activity" | "gone";

/**
 * Observe a session file's size and classify the change since the last
 * observation:
 *  - "new"      — first observation of this path (no baseline yet; stored).
 *                 Cannot be told apart from a rename or a fresh file, so it
 *                 is not reported as external activity (a live external run
 *                 keeps writing, so the next event is "activity").
 *  - "title"    — size unchanged: in-place title-slot rewrite (a rename) or
 *                 a duplicate/coalesced event. Not external activity.
 *  - "activity" — size changed (entries appended, or a full rewrite such as
 *                 compaction). External activity.
 *  - "gone"     — file no longer exists (deleted).
 */
function classifySizeChange(path: string): SizeChange {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    lastSizeByPath.delete(path);
    return "gone";
  }
  const prev = lastSizeByPath.get(path);
  lastSizeByPath.set(path, size);
  if (prev === undefined) return "new";
  return prev === size ? "title" : "activity";
}
function flush(): void {
  flushTimer = null;
  const paths = [...pendingPaths];
  pendingPaths = new Set();
  const hadUnknown = pendingUnknown;
  pendingUnknown = false;
  if (paths.length === 0 && !hadUnknown) return;

  // A changed file means the cached list's mtimes and message counts are stale.
  invalidateSessionListCache();

  if (hadUnknown) {
    // filename was null — fs.watch coalesced the event or overflowed. We
    // don't know which file changed, so rescan the whole tree.
    void listAllSessions()
      .then(async (sessions) => {
        const changed: string[] = [];
        const active: string[] = [];
        for (const s of sessions) {
          const path = await resolveSessionPath(s.id);
          if (!path) continue;
          const change = classifySizeChange(path);
          if (change === "title" || change === "gone") continue;
          if (!changed.includes(s.id)) changed.push(s.id);
          if (change === "activity" && !active.includes(s.id)) active.push(s.id);
        }
        if (changed.length === 0) return;
        if (active.length > 0) recordExternalActivity(active);
        for (const listener of listeners) {
          try {
            listener(changed);
          } catch {
            // a failing subscriber must not stop the others
          }
        }
      })
      .catch(() => {
        // resolution failures are not worth tearing the watcher down for
      });
    return;
  }

  void Promise.all(paths.map((path) => resolveSessionIdByPath(path).catch(() => undefined)))
    .then((ids) => {
      const changed: string[] = [];
      const active: string[] = [];
      paths.forEach((path, i) => {
        const id = ids[i];
        if (!id) return;
        const change = classifySizeChange(path);
        if (change === "gone") return;
        if (!changed.includes(id)) changed.push(id);
        if (change === "activity" && !active.includes(id)) active.push(id);
      });
      if (changed.length === 0) return;
      // Only real file growth is external activity; same-size rewrites
      // (title-slot renames) just need a list refresh so the new title shows.
      if (active.length > 0) recordExternalActivity(active);
      for (const listener of listeners) {
        try {
          listener(changed);
        } catch {
          // a failing subscriber must not stop the others
        }
      }
    })
    .catch(() => {
      // resolution failures are not worth tearing the watcher down for
    });
}

function scheduleRetry(): void {
  if (retryTimer || listeners.size === 0) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    ensureWatcher();
  }, RETRY_MS);
}

function ensureWatcher(): void {
  if (watcher || retryTimer) return;
  const sessionsDir = join(getAgentDir(), "sessions");
  try {
    watcher = watch(sessionsDir, { recursive: true, persistent: false }, (_event, filename) => {
      if (!filename) {
        pendingUnknown = true;
        if (!flushTimer) flushTimer = setTimeout(flush, DEBOUNCE_MS);
        return;
      }
      const name = filename.toString();
      if (!name.endsWith(".jsonl")) return;
      pendingPaths.add(join(sessionsDir, name));
      if (!flushTimer) flushTimer = setTimeout(flush, DEBOUNCE_MS);
    });
    watcher.on("error", () => {
      watcher?.close();
      watcher = null;
      scheduleRetry();
    });
  } catch {
    // No sessions directory yet, or the platform refused a recursive watch.
    // Schedule a retry while subscribers remain; otherwise degrade silently.
    watcher = null;
    scheduleRetry();
  }
}

export function subscribeSessionFileChanges(listener: Listener): () => void {
  listeners.add(listener);
  ensureWatcher();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    pendingPaths = new Set();
    pendingUnknown = false;
    watcher?.close();
    watcher = null;
  };
}

// ── External-activity tracking ──────────────────────────────────────────────
// A session file that changes while its owning RPC process is idle means
// something else — a terminal `omp`, a harness — is writing it. The web UI
// must then treat the session as externally running: read-only file mode,
// no RPC attach, and a "running" badge driven by file activity.

const externalActivity = new Map<string, number>();

/** Record that these sessions' files were observed to change. */
export function recordExternalActivity(sessionIds: string[]): void {
  const now = Date.now();
  for (const id of sessionIds) {
    externalActivity.set(id, now);
  }
}

/**
 * True when the session file was written by something other than the web
 * UI's own RPC process. While the watcher is running (a browser is
 * connected) its activity map is authoritative: only real size changes
 * (appends, compaction rewrites) are recorded there. The direct stat below
 * also works with no SSE subscribers — the state route needs it to decide
 * whether to attach an RPC process.
 *
 * A rename rewrites the fixed 256-byte title slot in place: mtime refreshes
 * but the size does not. With a size baseline in place, only a real size
 * change counts as activity — otherwise a renamed session would look
 * externally running for the whole mtime window.
 */
export async function isExternallyActive(sessionId: string, withinMs = 5000): Promise<boolean> {
  const now = Date.now();
  const lastActivity = externalActivity.get(sessionId);
  if (lastActivity !== undefined && now - lastActivity <= withinMs) return true;
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) return false;
  try {
    const st = statSync(filePath);
    if (now - st.mtimeMs > withinMs) return false;
    const lastSize = lastSizeByPath.get(filePath);
    if (lastSize !== undefined && lastSize === st.size) return false;
    return true;
  } catch {
    return false;
  }
}

/** Stop treating a session as externally active (e.g. after a user action). */
export function clearExternalActivity(sessionId: string): void {
  externalActivity.delete(sessionId);
}

/** Snapshot of externally-active session ids (for badges and cleanup). */
export function getExternallyActiveIds(withinMs = 5000): string[] {
  const now = Date.now();
  const ids: string[] = [];
  for (const [id, last] of externalActivity) {
    if (now - last <= withinMs) ids.push(id);
  }
  return ids;
}
