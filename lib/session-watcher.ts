import { closeSync, openSync, readSync, readdirSync, readFileSync, readlinkSync, statSync, watch, type FSWatcher } from "fs";
import { basename, isAbsolute, join, resolve } from "path";
import { getWebOwnedHostPids } from "./omp/rust-rpc-process";
import { isOmpSessionFileName } from "./omp/session-files";
import {
  getAgentDir,
  invalidateSessionListCache,
  listAllSessions,
  resolveSessionIdByPath,
  resolveSessionPath,
  resolveSessionPathSync,
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
// One non-recursive inotify watch per directory, instead of a single
// recursive fs.watch. Node's internal recursive-watch implementation
// (node:internal/fs/recursive_watch) lstats every directory entry on folder
// events; a WSL2 dentry race on a transient file (omp's per-write
// .jsonl.lock) surfaces there as an UNCAUGHT EIO that kills the whole
// process. Non-recursive directory watches only receive file names — no
// per-entry lstat — so the race cannot occur.
let rootWatcher: FSWatcher | null = null;
const dirWatchers = new Map<string, FSWatcher>();
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

function handleDirEvent(dir: string, filename: string | Buffer | null): void {
  if (!filename) {
    // Coalesced or overflowed event — we don't know which file changed.
    pendingUnknown = true;
    if (!flushTimer) flushTimer = setTimeout(flush, DEBOUNCE_MS);
    return;
  }
  const name = filename.toString();
  if (name.endsWith(".jsonl")) {
    pendingPaths.add(join(dir, name));
    if (!flushTimer) flushTimer = setTimeout(flush, DEBOUNCE_MS);
    return;
  }
  // Transient lock files (omp's `<session>.jsonl.lock`) and other entries
  // need no watch. A (nested) subdirectory gets its own watch so events
  // inside it reach us — the recursion the old recursive watch provided.
  if (!name.endsWith(".lock")) addDirWatch(join(dir, name), true);
}

function addDirWatch(dir: string, resync = false): void {
  if (dirWatchers.has(dir)) return;
  // Artifact dirs are named after the session file they belong to
  // (`<timestamp>_<uuid>`) and hold only subagent transcripts — never a
  // session file — so watching them could not resolve to a session.
  // Skipping them bounds the inotify instance count.
  if (isOmpSessionFileName(basename(dir) + ".jsonl")) return;
  let w: FSWatcher;
  try {
    w = watch(dir, { persistent: false }, (_event, filename) => handleDirEvent(dir, filename));
  } catch {
    return; // vanished between discovery and watch
  }
  w.on("error", () => {
    w.close();
    dirWatchers.delete(dir);
  });
  dirWatchers.set(dir, w);
  if (!resync) return;
  // The directory appeared after the root watch went live, so its initial
  // contents raced the watch setup: inotify only reports events for watches
  // that already existed when the event happened. Rescan once for .jsonl
  // files created in that window. They report as "new" (no size baseline),
  // which refreshes the list without lighting the external-activity flag.
  try {
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".jsonl")) {
        pendingPaths.add(join(dir, name));
        if (!flushTimer) flushTimer = setTimeout(flush, DEBOUNCE_MS);
      }
    }
  } catch {
    // Directory vanished between watch and rescan.
  }
}

function stopWatchers(): void {
  if (rootWatcher) {
    rootWatcher.close();
    rootWatcher = null;
  }
  for (const w of dirWatchers.values()) w.close();
  dirWatchers.clear();
}

function ensureWatcher(): void {
  if (rootWatcher || retryTimer) return;
  const sessionsDir = join(getAgentDir(), "sessions");
  try {
    rootWatcher = watch(sessionsDir, { persistent: false }, (_event, filename) =>
      handleDirEvent(sessionsDir, filename),
    );
  } catch {
    // No sessions directory yet, or the platform refused the watch.
    // Schedule a retry while subscribers remain; otherwise degrade silently.
    scheduleRetry();
    return;
  }
  rootWatcher.on("error", () => {
    // The sessions dir itself vanished — drop every watch and rebuild.
    stopWatchers();
    scheduleRetry();
  });
  // The root watch only reports events on the sessions dir itself, so seed
  // per-directory watches for everything already present. Names only —
  // withFileTypes would lstat every entry (the very call that crashes under
  // the WSL2 dentry race); watch() on a regular file just errors and
  // addDirWatch drops it.
  try {
    for (const name of readdirSync(sessionsDir)) addDirWatch(join(sessionsDir, name));
  } catch {
    // Unreadable sessions dir — the root watcher will report it.
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
    stopWatchers();
  };
}

// ── External-activity tracking ──────────────────────────────────────────────
// A session file that changes while its owning RPC process is idle means
// something else — a terminal `omp`, a harness — is writing it. The web UI
// must then treat the session as externally running: read-only file mode,
// no RPC attach, and a "running" badge driven by file activity.

const externalActivity = new Map<string, number>();

/**
 * How long a session file's last write keeps the session "externally
 * active". An external omp goes quiet while the model is thinking or a long
 * tool runs (no session-file writes), so the window must outlast typical
 * thinking gaps — the client's reclaim poller re-checks on this window and
 * drops the running state when it lapses.
 */
export const EXTERNAL_ACTIVITY_WINDOW_MS = 90_000;

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
  if (lastActivity !== undefined && now - lastActivity <= withinMs) {
    // A recent external write: the turn is over only once the committed tail
    // is a final assistant message.
    const filePath = await resolveSessionPath(sessionId);
    return filePath ? heldTurnInFlight(filePath) : false;
  }
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) return false;
  try {
    const st = statSync(filePath);
    if (now - st.mtimeMs <= withinMs) {
      const lastSize = lastSizeByPath.get(filePath);
      if (lastSize === undefined || lastSize !== st.size) return heldTurnInFlight(filePath);
    }
  } catch {
    return false;
  }
  // The file has been quiet past the window — a long model-thinking gap or a
  // long-running tool produces no session-file writes. A live omp process
  // that resumed this session (a terminal run, or a child that outlived an
  // ompweb restart) keeps it running while the committed tail shows a turn in
  // flight; an idle holder — a terminal waiting for input, or a leftover
  // child after its turn finished — ends on a final assistant message and
  // must not keep the session "running" forever.
  return heldSessionsWithPendingTurn().includes(sessionId);
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

// ── External holder (process) detection ────────────────────────────────────
// An `omp` process that resumed a session file keeps `--resume <file>` in its
// command line for the whole session lifetime, so /proc is the reliable
// signal that a session is owned by a process outside this server (a terminal
// run, a harness, or a child that outlived an ompweb restart). File locks are
// not created for idle sessions, and the file is only held open while
// writing, so neither catches a quiet in-progress run.

const HOLDER_CACHE_MS = 5_000;
let heldCache: { at: number; byId: Map<string, string> } | null = null;

/**
 * Read the tail of a session file (bounded) and report whether its committed
 * tail shows a turn in flight. omp commits each assistant message as a whole
 * entry (no partial writes), so the last `message` entry is the authority:
 *  - user / toolResult tails  → the model is generating the next step
 *  - assistant with toolCall  → a tool result is still pending
 *  - assistant, no toolCall   → final answer: the turn is over
 * Non-message entries (session_exit, compaction, title slot) are skipped.
 */
export function heldTurnInFlight(filePath: string): boolean {
  const TAIL_BYTES = 128 * 1024;
  let size: number;
  let fd: number;
  try {
    size = statSync(filePath).size;
    fd = openSync(filePath, "r");
  } catch {
    return false;
  }
  const start = Math.max(0, size - TAIL_BYTES);
  let chunk: Buffer;
  try {
    const buf = Buffer.alloc(Math.min(TAIL_BYTES, size));
    const n = size > 0 ? readSync(fd, buf, 0, buf.length, start) : 0;
    chunk = buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
  // If the chunk starts mid-file, its first line is a truncated fragment.
  const lines = chunk.toString("utf8").split("\n");
  if (start > 0) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: { type?: string; message?: { role?: string; content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // truncated fragment or corrupt line
    }
    if (entry.type !== "message" || typeof entry.message?.role !== "string") continue;
    if (entry.message.role !== "assistant") return true; // user or toolResult
    const content = entry.message.content;
    const hasToolCall =
      Array.isArray(content) &&
      content.some((b) => typeof b === "object" && b !== null && "type" in b && b.type === "toolCall");
    return hasToolCall;
  }
  return false;
}

/**
 * Resolve the session (id + file) an `omp --resume …` command line points at,
 * or null when the process is not resuming an omp session file.
 *
 * `--resume` takes two forms:
 *  - a session file path (absolute, or relative to the process's cwd) — the
 *    form omp-web's own spawns use;
 *  - a bare session id (the form a terminal user types, `omp --resume <id>`).
 *
 * Ids contain no slashes or dots; anything with either is treated as a path.
 * `cwd` (the process's working directory) is only needed for relative paths.
 * A deleted session resolves to null — nothing is held.
 */
export function parseHeldSession(
  argv: string[],
  cwd: string | null,
): { id: string; file: string } | null {
  if (argv.length < 2) return null;
  // Only the omp binary resumes sessions.
  if ((argv[0].split("/").pop() ?? "") !== "omp") return null;
  const idx = argv.indexOf("--resume");
  if (idx < 0 || idx + 1 >= argv.length) return null;
  const value = argv[idx + 1];
  const prefix = `${join(getAgentDir(), "sessions")}/`;
  if (value.includes("/") || value.includes(".")) {
    // Path form: must resolve inside the sessions tree and look like a
    // session file (subagent transcripts and sidecars are excluded).
    let file = value;
    if (!isAbsolute(file)) {
      if (!cwd) return null;
      file = join(cwd, file);
    }
    file = resolve(file);
    if (!file.startsWith(prefix)) return null;
    const base = file.slice(file.lastIndexOf("/") + 1);
    if (!isOmpSessionFileName(base)) return null;
    const id = base.slice(0, -".jsonl".length).split("_").pop();
    return id ? { id, file } : null;
  }
  // Id form: resolve through the session path cache (fast) or a bounded
  // sessions-tree scan; the file must exist on disk.
  const file = resolveSessionPathSync(value);
  return file ? { id: value, file } : null;
}

/**
 * Session ids currently held by a live `omp` process outside this server
 * (terminal runs, harnesses, children of a previous server instance), mapped
 * to the session file each holder resumed. The web's own children are
 * excluded by process-tree check, NOT by the RPC registry: after a restart a
 * session can hold a freshly restored (idle) RPC while a stale child of the
 * previous server still owns the file, and a registry check would exclude
 * exactly the case that must be detected.
 * Linux only: on other platforms the write-window check alone still applies.
 */
function scanExternallyHeldSessions(): Map<string, string> {
  if (process.platform !== "linux") return new Map();
  const now = Date.now();
  if (heldCache && now - heldCache.at < HOLDER_CACHE_MS) return heldCache.byId;
  const byId = new Map<string, string>();
  const sessionsDir = join(getAgentDir(), "sessions");
  let pids: string[];
  try {
    pids = readdirSync("/proc");
  } catch {
    return heldCache?.byId ?? new Map();
  }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let cmdline = "";
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue; // exited or unreadable between readdir and read
    }
    const args = cmdline.split("\0").filter(Boolean);
    // Cheap pre-filter: only omp processes need the slower per-process walk.
    if (args.length < 2 || (args[0].split("/").pop() ?? "") !== "omp") continue;
    if (isWebOwnedOmp(pid)) continue;
    // Mechanism 1: the resume session is on the command line (terminal runs,
    // harnesses, resumed children of a previous server instance) — either a
    // file path or a bare session id.
    if (args.includes("--resume")) {
      let cwd: string | null = null;
      try {
        cwd = readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        cwd = null;
      }
      const held = parseHeldSession(args, cwd);
      if (held) byId.set(held.id, held.file);
      continue;
    }
    // Mechanism 2: host-spawned children resume via IPC, so the file never
    // appears on their command line — but omp keeps the session file open
    // (write fd) for the whole session lifetime, so the open fd identifies
    // the holder. This is what keeps a turn visible across a web-server
    // crash/restart even for a session that was brand-new to the old server.
    try {
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        let target = "";
        try {
          target = readlinkSync(`/proc/${pid}/fd/${fd}`);
        } catch {
          continue;
        }
        if (!target.startsWith(sessionsDir + "/")) continue;
        const base = target.slice(target.lastIndexOf("/") + 1);
        if (!isOmpSessionFileName(base)) continue;
        const id = base.slice(0, -".jsonl".length).split("_").pop();
        if (id) byId.set(id, target);
      }
    } catch {
      // Process exited between the readdir and the fd walk.
    }
  }
  heldCache = { at: now, byId };
  return heldCache.byId;
}

export function findExternallyHeldSessionIds(): string[] {
  return [...scanExternallyHeldSessions().keys()];
}

/**
 * Externally-held sessions whose committed tail still shows a turn in flight.
 * An idle holder — a terminal waiting for input, or a leftover child of a
 * restarted server after its turn finished — ends on a final assistant
 * message and must not keep the session "running" forever.
 */
export function heldSessionsWithPendingTurn(): string[] {
  const ids: string[] = [];
  for (const [id, file] of scanExternallyHeldSessions()) {
    if (heldTurnInFlight(file)) ids.push(id);
  }
  return ids;
}

/**
 * True when the omp process with this pid was spawned by this server: a
 * direct child of this Node process (node backend) or of the Rust host
 * daemon (default backend). A terminal run or a child orphaned by a server
 * restart has a different parent.
 */
function isWebOwnedOmp(pid: string): boolean {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /(^|\n)PPid:\s*(\d+)/.exec(status);
    if (!match) return false;
    const ppid = Number(match[2]);
    if (ppid === process.pid) return true;
    return getWebOwnedHostPids().has(ppid);
  } catch {
    return false;
  }
}
