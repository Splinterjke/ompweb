#!/usr/bin/env bash
#
# ompweb-rebuild-restart.sh — rebuild ompweb from source, deploy, restart the main instance.
#
# WHY SPLIT INTO LAUNCHER (foreground) + REAPER (detached)
# --------------------------------------------------------
# This script is normally run from the main instance's own scheduler, and the
# scheduler engine lives INSIDE the very ompweb process that the restart stage
# kills. If a single script did the build, deploy, AND the kill, the process-
# tree teardown would SIGKILL (1) its own parent — the only process that records
# the run as "ok", so the run never reaches Success — and (2) the script itself,
# so wait/verify/refresh never ran (the log would end mid-"stop").
#
# So the work is split by DUTY:
#
#   LAUNCHER (foreground, run under the scheduler engine; stdout is captured):
#     preflight → lock → BUILD → HOST → DEPLOY → compute BUILD_ID →
#     spawn the detached reaper → exit 0.
#     Because build/host/deploy run in the foreground, their output streams to
#     stdout and the scheduler CAPTURES it in the run record — the user sees the
#     FULL build/deploy log there (and a copy in $LOG). A build or deploy failure
#     exits 1 → the run records "error" WITH the full log, and the running
#     instance is left UNTOUCHED (nothing destructive happened yet).
#
#   REAPER (fully detached: setsid + nohup, its own session — unreachable by the
#   stop stage's tree kill of the instance):
#     sleep 2 (let the engine persist the run) → STOP the instance's process
#     tree → wait for the supervisor to relaunch → VERIFY it serves the fresh
#     BUILD_ID → POST /api/ui/refresh. It has no stdout to the engine (detached,
#     engine already gone), so its restart log goes to $REAPER_LOG.
#
# The entrypoint's `while true` loop relaunches `ompweb` ~3s after the stop.
# Because DEPLOY already wrote the fresh build to $DST, that relaunch serves the
# NEW code — there is nothing to start manually.
#
# Run record: "ok" is recorded when the launcher exits (build+deploy done, reaper
# launched), carrying the full build/deploy log. The reaper's restart outcome
# (stop/verify/refresh) is in $REAPER_LOG (final line: "OK: ..." or "FAILED: ...").
#
# Idempotent; safe to re-run. Scheduling is intentionally NOT configured here —
# wire this script into your scheduler of choice.
#
# Env overrides:
#   REPO     source repo path (default: auto-detected — /work/ompweb, then
#            /workspace/ompweb; override by exporting REPO)
#   DST      install dir to deploy into    (default: /opt/ompweb)
#   PORT     main instance port            (default: 6767)
#   WAIT_S   max seconds to wait for the supervisor to restart (default: 45)
#
set -uo pipefail

REPO="${REPO:-}"
DST="${DST:-/opt/ompweb}"
PORT="${PORT:-6767}"
WAIT_S="${WAIT_S:-45}"
STATE_HOME="${STATE_HOME:-$HOME/.omp/agent/ompweb-rebuild}"
LOG="$STATE_HOME/rebuild.log"
REAPER_LOG="$STATE_HOME/reaper.log"
LOCK="$STATE_HOME/.lock"

mkdir -p "$STATE_HOME"
# log() streams to stdout (captured by the scheduler engine into the run record)
# AND appends a durable copy to $LOG. This is exactly why the build/deploy log
# shows up in the scheduler's run record: the launcher's stdout is the record.
log() { echo "[$(date -Is)] $*" | tee -a "$LOG"; }

# ══════════════════════════ REAPER mode (detached) ══════════════════════════
# The destructive restart. Invoked as:
#   bash <this script> --reaper <repo> <dst> <port> <wait_s> <build_id>
# Runs in its own session (setsid) so the stop stage's tree kill of the instance
# cannot reach it. Its log goes to $REAPER_LOG (no stdout to the engine).
if [ "${1:-}" = "--reaper" ]; then
  REPO="${2:?--reaper needs <repo>}"
  DST="${3:?--reaper needs <dst>}"
  PORT="${4:?--reaper needs <port>}"
  WAIT_S="${5:?--reaper needs <wait_s>}"
  NEW_BUILD_ID="${6:-}"
  rlog() { echo "[$(date -Is)] $*" >>"$REAPER_LOG"; }

  # The reaper inherits the scheduler child's env, which includes NODE_OPTIONS
  # carrying --require=./bin/request-peer-preload.js (the dev server's own).
  # Any node command the reaper spawns would load that preload; nothing in the
  # restart pipeline needs it, so clear it.
  export NODE_OPTIONS=""

  rlog "reaper: start (port $PORT, wait ${WAIT_S}s, build ${NEW_BUILD_ID:-?})"
  # Give the scheduler parent (the main instance, about to be killed) a moment to
  # finalizeRun -> persistRun("ok") to disk. The launcher already exited; margin.
  sleep 2
  T_START=$(date +%s)

  # --- helper: belt-and-suspenders port sweep ---
  release_port() {
    # SIGTERM then SIGKILL whatever is bound to the port. pkill/fuser may be
    # missing; every step is best-effort — the BUILD_ID verify decides success.
    local pids=""
    if command -v fuser >/dev/null 2>&1; then
      pids="$(fuser -n tcp "$PORT" 2>/dev/null | tr -s ' ' '\n' | sed 's/^//;s/ .*//;s/^[0-9]*//g' || true)"
    fi
    if command -v pkill >/dev/null 2>&1; then
      pkill -TERM -f "ompweb.*--port $PORT" 2>/dev/null || true
      pkill -TERM -f "next start -p $PORT" 2>/dev/null || true
    fi
    [ -n "$pids" ] && kill -TERM $pids 2>/dev/null || true
    sleep 1
    if command -v pkill >/dev/null 2>&1; then
      pkill -KILL -f "ompweb.*--port $PORT" 2>/dev/null || true
      pkill -KILL -f "next start -p $PORT" 2>/dev/null || true
    fi
    [ -n "$pids" ] && kill -KILL $pids 2>/dev/null || true
    return 0
  }

  # --- Stop the current instance (the entrypoint loop relaunches it) ---
  # Killing the ompweb wrapper's process tree (wrapper -> next start -> host)
  # makes the entrypoint's `while true` loop detect the death and relaunch
  # `ompweb` in ~3s. Because the launcher already deployed the fresh build to
  # $DST, that relaunch serves the NEW code. release_port is a belt-and-
  # suspenders sweep for a `next start` the tree walk might miss. We do NOT gate
  # on the port being free: the supervisor re-occupies it within seconds and a
  # port-free wait would race that restart.
  rlog "stop: tearing down the current instance on port $PORT (supervisor will relaunch)"
  python3 - "$PORT" >>"$REAPER_LOG" 2>&1 <<'PY'
import os, signal, sys, time
port = sys.argv[1]
needle = f'--port {port}'

def snap():
    out = {}
    for e in os.listdir('/proc'):
        if not e.isdigit():
            continue
        try:
            cmd = open(f'/proc/{e}/cmdline','rb').read().replace(b'\0', b' ').decode()
            stat = open(f'/proc/{e}/stat').read().rsplit(')',1)[1].split()
            out[int(e)] = (cmd, int(stat[1]), stat[0])
        except OSError:
            pass
    return out

def tree(roots, s):
    seen, stack = set(), list(roots)
    kids = {}
    for pid, (_, ppid, _) in s.items():
        kids.setdefault(ppid, []).append(pid)
    while stack:
        p = stack.pop()
        if p not in seen:
            seen.add(p)
            stack.extend(kids.get(p, []))
    return seen

try:
    s = snap()
    # Non-zombie ompweb wrapper processes (the tree root).
    roots = sorted(p for p, (cmd, _, st) in s.items()
                   if 'ompweb' in cmd and needle in cmd and st != 'Z')
    pids = sorted(tree(roots, s)) if roots else []
    if pids:
        print("stopping tree:", pids, flush=True)
        for attempt in (1, 2, 3):
            for p in sorted(pids, reverse=True):
                try:
                    os.kill(p, signal.SIGTERM)
                except (ProcessLookupError, PermissionError):
                    pass
            deadline = time.time() + 8
            while time.time() < deadline:
                s = snap()
                if all(p not in s or s[p][2] == 'Z' for p in pids):
                    break
                time.sleep(0.3)
            alive = [p for p in pids if p in snap() and snap()[p][2] != 'Z']
            if not alive:
                print("tree stopped", flush=True)
                break
            print(f"attempt {attempt}: SIGKILL survivors {alive}", flush=True)
            for p in alive:
                try:
                    os.kill(p, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
            time.sleep(0.5)
except Exception as ex:
    print(f"WARNING: tree walk/kill failed ({type(ex).__name__}: {ex})", flush=True)
PY
  # belt-and-suspenders: sweep the port in case a `next start` the tree walk
  # missed is still holding it (orphaned from the wrapper).
  release_port
  rlog "stop: tree torn down; the supervisor loop will relaunch ompweb with the new build"

  # --- Wait for the entrypoint supervisor to relaunch (the loop guarantees it) ---
  probe() { curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:$PORT/" 2>/dev/null; }

  up=0
  for _ in $(seq 1 "$WAIT_S"); do
    code="$(probe)"
    case "$code" in 2*|3*) up=1; break ;; esac
    sleep 1
  done
  if [ "$up" -ne 1 ]; then
    rlog "FAILED: supervisor did not relaunch the instance on port $PORT within ${WAIT_S}s"
    rlog "       the entrypoint while-loop should restart ompweb automatically; if this"
    rlog "       persists the supervisor itself may be dead — restart the container."
    exit 1
  fi

  # A successful deploy must serve the FRESHLY DEPLOYED build. Next.js embeds the
  # build id in the RSC payload of every rendered page ("b":"<BUILD_ID>"), so the
  # deployed build id must appear in the served HTML. If a stale instance (old
  # build id) is still bound to the port, its payload carries the old id and this
  # fails — leftover processes cannot fake it.
  if [ -n "$NEW_BUILD_ID" ]; then
    served_html="$(curl -s -m 5 "http://127.0.0.1:$PORT/login" 2>/dev/null)"
    case "$served_html" in
      *"$NEW_BUILD_ID"*)
        rlog "verify: served page contains deployed build id $NEW_BUILD_ID"
        ;;
      *)
        rlog "FAILED: port $PORT is not serving build '$NEW_BUILD_ID' — the old instance is still running"
        exit 1
        ;;
    esac
  fi

  # --- Fan out a UI refresh to connected browser pages ---
  # The new instance just took over the port. Any browser tab that survived the
  # restart (its EventSource auto-reconnected) receives a { type: "refresh" }
  # frame and the "OmpWeb started" notice surfaces, so the user can refresh to
  # pick up the new bundle. Non-fatal: if the endpoint 404s (old binary without
  # ui.refresh) or no tab is connected, the run still succeeds — the pages load
  # fresh on their next navigation and the notice confirms the restart.
  if refresh_out="$(curl -s -m 5 -X POST -H 'Content-Type: application/json' -d '{"updated":true}' "http://127.0.0.1:$PORT/api/ui/refresh" 2>/dev/null)"; then
    rlog "refresh: ${refresh_out:-ok}"
  else
    rlog "refresh: endpoint not reachable (old build or no server) — continuing"
  fi

  pid="$(pgrep -f "ompweb.*--port $PORT" | head -1 || true)"
  rlog "OK: port $PORT serving (pid ${pid:-?}), deployed BUILD_ID ${NEW_BUILD_ID:-?}"
  rlog "reaper total: $(( $(date +%s) - T_START ))s"
  exit 0
fi

# ═══════════════════════ LAUNCHER mode (foreground) ═══════════════════════
# Runs under the scheduler engine; its stdout is captured into the run record.
# Does all NON-destructive work (preflight, build, host, deploy). It does NOT
# touch the running instance. Only after build+deploy succeed does it launch the
# reaper (which does the destructive restart) and exit 0.


# --- Resolve the source repo (env override wins; otherwise known layouts) ---
# The bind layout has moved over time (repo at the container root vs nested
# under omp-docker). Validate each candidate with the same marker file the
# preflight uses, so a stale/empty path fails loudly instead of building
# nothing.
if [[ -z "$REPO" ]]; then
  for _candidate in /work/ompweb /workspace/ompweb; do
    if [[ -f "$_candidate/bin/request-peer-preload.js" ]]; then
      REPO="$_candidate"
      log "repo: auto-detected $REPO"
      break
    fi
  done
fi
# --- preflight (cheap, non-destructive) ---
command -v npm >/dev/null || { log "FATAL: npm not on PATH"; exit 1; }
[ -n "$REPO" ] && [ -d "$REPO" ] || { log "FATAL: repo not found (auto-detection failed; set REPO=/path/to/ompweb)"; exit 1; }
[ -f "$REPO/bin/request-peer-preload.js" ] || { log "FATAL: $REPO/bin/request-peer-preload.js not found"; exit 1; }
command -v python3 >/dev/null || { log "FATAL: python3 not on PATH (deploy + reaper tree-kill need it)"; exit 1; }
# fuser/pkill (psmisc/procps) are NOT required: the reaper kills via a /proc tree
# walk (python3) and uses fuser/pkill only as a best-effort port sweep that skips
# them when absent (node:26-slim ships neither).

# --- single-instance lock (mkdir is a portable flock) ---
# The reaper runs the SAME script with --reaper and never touches $LOCK, so
# releasing it here is safe.
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "another rebuild/restart is already running (lock: $LOCK)" >&2
  exit 1
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

T_START=$(date +%s)

# --- 1. BUILD (foreground; output streams to stdout → the run record) ---
# The running instance keeps serving the OLD build throughout the build and
# deploy, so there is no downtime until the reaper stops it.
T_BUILD=$(date +%s)
# node_modules may be absent (fresh clone / host bind without deps) — install once.
if [ ! -f "$REPO/node_modules/.bin/next" ]; then
  log "build: node_modules missing in $REPO — running npm ci"
  ( cd "$REPO" && npm ci ) 2>&1 | tee -a "$LOG"
  if [ "${PIPESTATUS[0]}" -ne 0 ]; then
    log "FAILED: npm ci (exit ${PIPESTATUS[0]}) — running instance left untouched"
    exit 1
  fi
fi
log "build: npm run build in $REPO"
  ( cd "$REPO" && npm run build ) 2>&1 | tee -a "$LOG"
if [ "${PIPESTATUS[0]}" -ne 0 ]; then
  log "FAILED: build (exit ${PIPESTATUS[0]}) — running instance left untouched"
  exit 1
fi
log "build: done in $(( $(date +%s) - T_BUILD ))s"

# --- 2b. HOST (rebuild + deploy the Rust host binary; non-fatal) ---
# The entrypoint pins OMPWEB_HOST_BIN to $DST/vendor/ompweb-host/linux-<arch>/ompweb-host
# (the image's canonical vendor layout, the path the launcher probes). The deploy
# mirror preserves `vendor/ompweb-host`, so a change to the host (crates/ompweb-host)
# — e.g. a new IPC method — is deployed here and survives the mirror's prune.
# Non-fatal: if cargo is missing/failed, the run proceeds with the existing binary.
T_HOST=$(date +%s)
case "$(uname -m)" in aarch64|arm64) HOST_ARCH=arm64 ;; *) HOST_ARCH=x64 ;; esac
HOST_DST="$DST/vendor/ompweb-host/linux-${HOST_ARCH}/ompweb-host"
if command -v cargo >/dev/null 2>&1; then
  log "host: cargo build --locked --bin ompweb-host in $REPO/crates"
  ( cd "$REPO" && cargo build --locked --manifest-path crates/Cargo.toml --bin ompweb-host ) 2>&1 | tee -a "$LOG"
  HOST_RC=${PIPESTATUS[0]}
  if [ "$HOST_RC" -eq 0 ]; then
    mkdir -p "$(dirname "$HOST_DST")"
    cp -f "$REPO/crates/target/debug/ompweb-host" "$HOST_DST"
    chmod +x "$HOST_DST"
    log "host: deployed $HOST_DST"
  else
    log "host: cargo build FAILED (exit $HOST_RC) — keeping the existing binary (run proceeds)"
  fi
else
  log "host: cargo not on PATH — skipping host rebuild (using existing binary)"
fi
# The source repo's vendor/ompweb-host is a gitignored build artifact (a stale
# host left by a prior `host:stage`/bind). Step 2b already deployed the fresh
# binary to $DST/vendor/ompweb-host; if we left the stale one in $REPO, the
# deploy mirror's copy would overwrite it. Drop it so the mirror never carries
# a stale host into the deploy target (the mirror's preserve is a prune-safety net).
rm -rf "$REPO/vendor/ompweb-host" 2>/dev/null || true
log "host: dropped stale source $REPO/vendor/ompweb-host (prevents the mirror clobbering the fresh $DST vendor host)"
log "host: done in $(( $(date +%s) - T_HOST ))s"

# --- 2. DEPLOY (incremental mirror; rsync is not installed in this container) ---
# Mirrors build artifacts into $DST with rsync --delete quick-check semantics: a
# file is re-copied only when its (size, mtime@1s) differs, and destination
# entries absent from the source (or in the ignore set) are pruned. The .next
# mirror excludes `cache` (build cache, not needed at runtime) and `dev` (the
# active dev server keeps rewriting .next/dev, and `next start` never reads it).
# This is what makes the steady-state deploy near-instant.
T_DEPLOY=$(date +%s)
log "deploy: incrementally mirroring build artifacts into $DST"
python3 - "$REPO" "$DST" 2>&1 <<'PY' | tee -a "$LOG"
import os, shutil, stat, sys
src, dst = sys.argv[1], sys.argv[2]

def _mirror_dir(s, d, ignore, preserve, depth=0):
    # Ignore names apply ONLY at the root of the mirrored tree. They name
    # build-time top-level dirs (cache, dev, types, standalone, trace,
    # trace-build) that next start never reads. Applying them recursively would
    # also delete nested source dirs that share a name — e.g. the compiled
    # routes .next/server/app/api/diagnostics/ and .../api/pair/diagnostics/ —
    # which the manifest still references, turning them into 500s at runtime.
    top_ignore = ignore if depth == 0 else ()
    src_names = {e.name for e in os.scandir(s) if e.name not in top_ignore}
    # Prune destination entries that are stale or ignored (exact mirror of
    # source-minus-ignore). Never touches ignored source names.
    for entry in os.scandir(d):
        if entry.name in preserve:
            continue
        if entry.name in top_ignore:
            continue
        if entry.name not in src_names:
            p = entry.path
            if os.path.islink(p) or os.path.isfile(p):
                os.remove(p)
            else:
                shutil.rmtree(p)
    # Copy/update from the source (quick-check: size + mtime truncated to 1s,
    # the same heuristic rsync's default quick-check uses).
    for entry in os.scandir(s):
        if entry.name in top_ignore:
            continue
        sd, dd = entry.path, os.path.join(d, entry.name)
        if entry.is_symlink():
            target = os.readlink(sd)
            if os.path.islink(dd) and os.readlink(dd) == target:
                continue
            if os.path.lexists(dd):
                os.remove(dd)
            os.symlink(target, dd)
            continue
        if entry.is_dir(follow_symlinks=False):
            os.makedirs(dd, exist_ok=True)
            _mirror_dir(sd, dd, ignore, preserve, depth + 1)
            continue
        ss = os.lstat(sd)
        if os.path.lexists(dd):
            ds = os.lstat(dd)
            if stat.S_ISREG(ds.st_mode) and ds.st_size == ss.st_size and int(ds.st_mtime) == int(ss.st_mtime):
                continue
            os.remove(dd)
        shutil.copy2(sd, dd)
        print(f"  + {entry.name}", flush=True)

def mirror(root_name, ignore, preserve=()):
    s = os.path.join(src, root_name)
    d = os.path.join(dst, root_name)
    if not os.path.isdir(s):
        print(f"skip {root_name}: not present in source", flush=True)
        return
    if os.path.lexists(d) and not os.path.isdir(d):
        os.remove(d)
    os.makedirs(d, exist_ok=True)
    _mirror_dir(s, d, ignore, preserve)
    print(f"deployed {root_name}", flush=True)

for name, ignore, preserve in (
    ('.next', ('cache', 'dev', 'types', 'standalone', 'diagnostics', 'trace', 'trace-build'), ()),
    ('bin', (), ()),
    ('public', (), ()),
    ('vendor', (), ('ompweb-host',)),
):
    mirror(name, ignore, preserve)

for f in ('next.config.ts', 'package.json', 'instrumentation.ts', 'proxy.ts', 'tsconfig.json'):
    sp, dp = os.path.join(src, f), os.path.join(dst, f)
    if not os.path.exists(sp):
        continue
    ss = os.lstat(sp)
    if os.path.lexists(dp):
        ds = os.lstat(dp)
        if ds.st_size == ss.st_size and int(ds.st_mtime) == int(ss.st_mtime):
            continue
    shutil.copy2(sp, dp)
    print(f"copied {f}", flush=True)
PY
if [ "${PIPESTATUS[0]}" -ne 0 ]; then
  log "FAILED: deploy — running instance left untouched"
  exit 1
fi
# The launcher shebangs require the exec bit. The mirror copies from the source
# tree (git stores them as 755, but a checkout without core.fileMode can drop
# the bit on disk), so re-assert it here — entrypoint execs them directly.
chmod +x "$DST/bin/omp-web.js" "$DST/bin/omp-web-desktop.js"
log "deploy: done in $(( $(date +%s) - T_DEPLOY ))s"

# The build id the reaper must confirm is served after the restart.
NEW_BUILD_ID="$(cat "$DST/.next/BUILD_ID" 2>/dev/null || true)"
log "deploy: BUILD_ID ${NEW_BUILD_ID:-<none>}"
# Guard: the build just wrote a fresh id into $REPO and the mirror copied
# $REPO/.next into $DST, so the two build ids must now MATCH. If $DST still
# carries a different (previous) id, the mirror produced nothing (a silent
# failure) — restarting now would keep serving the old code while the run
# records "ok". Bail out; the running instance is left untouched.
REPO_BUILD_ID="$(cat "$REPO/.next/BUILD_ID" 2>/dev/null || true)"
if [ -n "$REPO_BUILD_ID" ] && [ "$NEW_BUILD_ID" != "$REPO_BUILD_ID" ]; then
  log "FAILED: deploy did not update $DST (dst=$NEW_BUILD_ID but fresh build is $REPO_BUILD_ID) — running instance left untouched"
  exit 1
fi

# --- Launch the detached reaper (does the destructive restart) and exit 0 ---
# Everything non-destructive is done. The reaper, in its own session (setsid),
# stops the instance, waits for the supervisor to relaunch with the fresh build,
# verifies the BUILD_ID, and fans out a UI refresh. It is unreachable by the stop
# stage's tree kill. We pass the fresh BUILD_ID so the reaper can verify.
SELF="$(cd "$(dirname "$0")" 2>/dev/null && pwd)/$(basename "$0")"
log "rebuild: build+host+deploy done in $(( $(date +%s) - T_START ))s; launching detached reaper (port $PORT, build ${NEW_BUILD_ID:-?})"
setsid nohup bash "$SELF" --reaper "$REPO" "$DST" "$PORT" "$WAIT_S" "$NEW_BUILD_ID" \
  >/dev/null 2>&1 </dev/null &
REAPER_PID=$!
log "rebuild: reaper launched (pid $REAPER_PID); its restart log: $REAPER_LOG"
# Exit NOW: the scheduler parent records this run "ok" (carrying the full
# build/host/deploy log above) from this exit. The reaper is in its own session,
# so the stop stage's tree kill of the instance cannot reach it. The restart
# outcome (stop/verify/refresh) is in $REAPER_LOG.
exit 0
