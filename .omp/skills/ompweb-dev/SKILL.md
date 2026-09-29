---
name: ompweb-dev
description: Build, start, debug, kill, and restart the ompweb dev server without getting stuck on auth (401 password gate), the omp binary, or the Rust host daemon.
---

# ompweb Dev Server — Run / Debug / Kill / Restart

ompweb is a Next.js app (`@Splinterjke/ompweb`) that wraps a local `omp` (oh-my-pi) child process. Two things make it different from a plain `next dev`: a **password-gate middleware** on all `/api/*` and a **lazy Rust host daemon** (`ompweb-host`). This skill covers both.

## Port map (do not mix these up)

| Command | Port | Notes |
|---|---|---|
| `npm run dev` | **30178** | dev server; separate `distDir` `.next-dev/` so it can run alongside a build |
| `npm run start` | **30177** | production (`next start`) after `npm run build` |
| docker-compose (prod) | **6767** | primary mapped port of the deployed instance |
| `SIBLING_PORTS` | 30177/30178/30179 | launcher probes these to adopt an already-running server |

Typecheck: `node_modules/.bin/tsc --noEmit`. Lint: `npm run lint`.

## Start

```bash
npm install            # node >= 22.19
npm run dev            # http://127.0.0.1:30178
```

**Prerequisites**

- The `omp` binary must be installed (on `PATH` or set `OMP_WEB_OMP_BIN`). All live-agent features spawn it as `omp --mode rpc-ui`; session browsing works without it.
- No `OMP_WEB_PASSWORD` in the environment → the auth gate is **off** → plain `curl http://127.0.0.1:30178/api/...` works.
- Rust host (diagnostics panel KPI, worktrees, refresh): set `OMPWEB_HOST_BIN=/work/ompweb/crates/target/debug/ompweb-host` (build first with `npm run host:build` if cargo is available). The host boots **lazily** on the first `hostClient.*` call (`POST /api/ui/refresh` or a session start); without the binary the card shows "Unavailable" (binary missing, not a dead process).
### LAN binding (`npm run dev:lan` / `--hostname 0.0.0.0`)

`npm run dev` binds to `127.0.0.1` only. To reach the dev server from another interface (WSL2 → Windows host, Docker host, LAN), use `npm run dev:lan` (`next dev -H 0.0.0.0 -p 30178`) or add `--hostname 0.0.0.0` to a manual `next dev` invocation. Production equivalent: `npm run start:lan` (`next start -H 0.0.0.0 -p 30177`).

Caveats when binding beyond loopback:

- The password gate still applies — remote clients have **no** loopback exemption, so set `OMP_WEB_PASSWORD` and use the login flow above. The loopback test flow (reading `/proc/<pid>/environ`, the `/api/ui/refresh` exemption) only works from the server's own machine.
- Non-loopback Host headers must be listed in `OMP_WEB_ALLOWED_HOSTS` (comma-separated) or they are rejected at the HTTP boundary.

## Auth: clearing the 401 gate

`proxy.ts` gates **all** `/api/*` when `OMP_WEB_PASSWORD` is set: unauthenticated API requests get `401 {"error":"Password required","code":"password_required"}`; non-API paths get 302 → `/login`.

Loopback test flow (from the machine running the server):

```bash
# 1. log in — sets the HttpOnly omp_web_session cookie
curl -s -c /tmp/jar -X POST -H 'Content-Type: application/json' \
  -d '{"password":"<PW>"}' http://127.0.0.1:30178/api/web-auth/session   # 200 {"ok":true}

# 2. call the API with the cookie
curl -s -b /tmp/jar http://127.0.0.1:30178/api/diagnostics
```

- Login is `POST /api/web-auth/session` with `{"password":"…"}`. There is **no** `/api/web-auth/login`.
- A **wrong password returns 401 too** — indistinguishable from "no password set". Read the real value:
  `tr '\0' '\n' < /proc/<next-server-pid>/environ | grep ^OMP_WEB_PASSWORD=`
  (the value lives in the **next-server** child's env, not the launcher wrapper's, if you launched manually; for the compose instance it's in the entrypoint env).
- Loopback exemption (e.g. `/api/ui/refresh`) only works **from the server's own machine**: `--require ./bin/request-peer-preload.js` stamps `x-ompweb-socket-peer` + an HMAC proof from the real socket peer IP at the HTTP boundary, so a remote client cannot forge "loopback". A bare `next dev` without the `--require` fails loopback detection closed — always use `npm run dev`.

## Debug

1. **Read the running env first** — most "it's broken" reports are env-shaped:
   ```bash
   ps -ef | grep "next dev"          # find launcher + next-server pids
   tr '\0' '\n' < /proc/<next-server-pid>/environ | grep -E 'OMP_WEB_PASSWORD|OMPWEB_HOST_BIN|OMP_WEB_OMP_BIN'
   ```
2. **Auth** — 401 with `password_required` means the gate is on; do the login flow above. Non-loopback hosts need `OMP_WEB_ALLOWED_HOSTS` (comma-separated); loopback is always allowed.
3. **Diagnostics KPI** — `GET /api/diagnostics` drives the "Rust Host Daemon" card and backend-error alerts; if it 500s the whole panel shows a fallback even when the host is fine. Host check is **binary existence** at the resolved path, not process liveness (see resolution order in AGENTS.md: `OMPWEB_HOST_BIN` → packaged → `vendor/ompweb-host/` → `crates/target/debug/ompweb-host`).
4. **Stale build** — dev writes to `.next-dev/`, `next build` to `.next/`; they can run concurrently. `scripts/clean-dev-types.mjs` sweeps dev type dirs before builds (TS1128 trap: a live dev server rewriting `.next/dev/types/` mid-build). After a rebuild the UI shows an in-app "OMP update available / Refresh" notification.
5. **Live agent** — one `omp --mode rpc-ui` child per active session (NDJSON over stdio). Find them: `ps -ef | grep "omp --mode rpc-ui"`. Each is a child of the `ompweb-host --ipc` process. Killing one drops that session's live state; the session file is untouched.

## Stale `.next-dev` build — HTML 404 on live routes

If `/api/*` or a page returns Next's **HTML** "Not Found" 404 (server log: HTML body,
`application-code: 32m`) even though the route exists in source, it is NOT a missing route —
the dev server is serving a **stale compiled route table** from `.next-dev/`. (Contrast: a JSON
`{"error":…}` 404 means the route is live and the ID just wasn't found.)

Triggers: files edited while the dev server was down (the watcher never sees them), a crash or
kill mid-rebuild leaving `.next-dev/` half-written, or an interrupted hot-reload.

Fix, in order:
1. Restart the dev server (`hub restart ompweb-dev`, or `pkill -f "next dev" && npm run dev`).
2. If the HTML 404 persists, the route cache is corrupt: kill the server, `rm -rf .next-dev`,
   restart. The first request triggers a full Turbopack rebuild — it is slow; poll until it
   responds instead of concluding the route is dead.
3. Verify with `curl` before blaming the browser — a browser can't fix a stale server build.
   After a clean rebuild, re-navigate the test browser with a fresh `goto` (not a soft reload).

## Git index.lock collisions (dev server's own pollers)

While a dev instance is serving this repo, its 5 s git health pollers spawn
`git diff/status` children that refresh the index stat-cache and briefly hold
`.git/index.lock`. Index-writing commands (`git commit`, `reset`, `add`,
`read-tree`) can fail with "index.lock: File exists" for that reason — it is
transient, not a stale lock from a crashed process.

- **Retry**; a short sequence rarely collides twice.
- **Never delete `.git/index.lock` while a live git child is running.**
  `ps -ef | grep git`: the app's pollers appear as
  `git -c safe.directory=* -C <repo> diff HEAD --shortstat` under the
  next-server pid — those are the running dev instance and must not be
  killed. Only remove the lock when no process holds it (and no stuck
  editor/`git commit` is left behind).
- **Multi-step sequences stop mid-way** (a `set -e` reword/rebase script
  aborts on the collision with the next step's tree already staged in the
  index). After a failure, verify where the sequence actually stopped —
  `git log`, `git status`, `git write-tree` — and commit only the remaining
  steps. Re-running the whole script double-commits.

## Kill / restart

```bash
# graceful dev server stop (kills launcher + next-server + children)
pkill -f "next dev"        # or kill the launcher pid; the next-server child follows

# verify the port is free before restarting
ss -ltnp | grep 30178      # (or lsof -i :30178)

npm run dev
```

- **Restarting an active session** (after a CLI `omp` update): `POST /api/omp-update {"action":"restart"}` restarts active OMP sessions; `{"action":"check"}` runs `omp update --check`.
- **Docker/compose rebuild** (bound repo): run the `ompweb-rebuild-restart.sh` scheduler (Settings → Script schedulers, manual launch) — it rebuilds and redeploys, then a page refresh picks up the new build.
- After any restart, `instrumentation.ts` restores active RPC sessions from disk, so open sessions re-attach automatically.

## E2E / restart testing

### Do not kill the server that hosts your agent session

The most expensive mistake in a long dev session: an E2E test that `kill -9`s
the dev server your own agent session is connected to. The turn is interrupted
mid-flight, the next turn opens with "the omp-web server restarted while your
previous turn was active — continue, do not repeat completed side effects",
and the agent re-establishes state (server up? login? git state? which edits
are applied?) and re-verifies everything. In one 17-hour session this cycle
repeated 10+ times (122 dev-server starts, 13 `pkill`s, 72 re-logins, 35
restart-test script runs) and was the single largest time sink.

**Identifying the host instance:** your own session (title = the current task)
appears in the sidebar of the ompweb instance you are connected to. If a
throwaway test instance shows your own *running* session in its sidebar, it is
the host — treat it as untouchable and pick a different test port.

**Instead:**

1. **Run restart tests against a throwaway instance** on a port **outside**
   `SIBLING_PORTS` (30177/30178/30179) — the launcher probes those and will
   adopt or compete with a test instance sitting on them. Reuse the hosting
   server's env (read it with `tr '\0' '\n' < /proc/<next-server-pid>/environ |
   grep -E 'OMP_|OMPWEB_'`), then:
   ```bash
   env <the above vars> node --require ./bin/request-peer-preload.js \
     ./node_modules/next/dist/bin/next dev -H 127.0.0.1 -p 30180 \
     > /tmp/dev-e2e.log 2>&1 &
   E2E_PID=$!
   ```
   Kill **only** `$E2E_PID` (or its process tree, by PID). NEVER
   `pkill -f "next dev"` — it hits every dev server on the machine, including
   the one hosting your session.
2. **Batch the whole E2E into one script, run once, in the background.**
   Write the full flow (start turn → wait until it streams → kill → restart →
   poll until up → verify state) as a single shell script and launch it as a
   background job; wait for its result instead of iterating the kill-restart
   cycle interactively. Each interactive round costs a full turn plus
   re-establishment.
3. **Use a dedicated `chrome-agent` browser profile** for the E2E
   (e.g. `--browser e2e`) so the script and your manual checks don't fight
   over one page.
4. **Wait for hydration before interacting.** On WSL2 + Turbopack the page
   can take 1–2 minutes to hydrate. Poll for the expected element (Send/Stop
   button) with a generous timeout before declaring "page never hydrated".
5. **Parse `chrome-agent --json` output as JSON** — it is double-escaped;
   `grep` for unescaped strings will never match. Pipe through
   `python3 -c "import json,sys; …"` or `jq`. Long inline `python3 -c`
   filters tend to get mangled — write the snapshot to a file and filter it
   with a small script file instead.
6. **After a server restart the browser session cookie is stale** — re-login
   in the browser profile; a `curl` cookie jar does not carry over.
7. **A throwaway instance can die silently.** A server backgrounded with a
   plain `&` subshell can be reaped mid-session leaving no log and a
   connection-refused port. Relaunch it as a managed background service with
   a `Ready in` readiness gate (bash tool `name` + `ready`). It inherits
   `OMP_WEB_PASSWORD` from your environment, so after any (re)start treat the
   gate as ON: re-login before navigating.
8. **Modal overlays swallow clicks.** If a `click` verdict is `intercepted`,
   read `intercepted_by` — in this app it is almost always an open dialog
   (e.g. the "Add a chat event action" modal) covering the target. Close it
   (Escape or Cancel), re-inspect for fresh uids, then retry. No selector
   trick gets through while the dialog is on top.
9. **Tooltips (base-ui) need a warm-up hover.** The popup has a 400 ms open
   delay and renders in a portal; a direct hover right after another action
   can miss the `pointerenter`. Hover a neutral element first, then the
   target, then `wait` for the tooltip's text before `inspect`/`screenshot`.
   The screenshot argument is `filename` (not `out`).
10. **"(no output)" in <0.2 s means the command died early**, not "no match"
   (a real `inspect` takes ~0.1–0.5 s and prints a tree even when empty).
   Two consecutive empty results → check the browser is alive
   (`ps -ef | grep <profile>`); a fresh `goto` relaunches a dead browser.

### Edge-bundle rebuild loop (minutes-long hydration, huge logs)

If the dev server log grows rapidly (100+ MB in minutes) and pages take
minutes to hydrate, suspect a **Node-only static import in
`instrumentation.ts`** (see AGENTS.md, "instrumentation.ts — edge-runtime
import trap"): Turbopack fails the edge bundle on every request and rebuilds
forever. This produces false "page never hydrated" E2E failures that look
like an app bug but are an environment bug — check the import before
concluding the app is broken.

## Quick pre-flight checklist

1. Port: dev = **30178**, `npm run start` = **30177**, compose = **6767**.
2. Is `OMP_WEB_PASSWORD` set? If yes → login via `/api/web-auth/session` + cookie jar; read the real value from `/proc/<pid>/environ`.
3. Rust-host features → `OMPWEB_HOST_BIN` points at an existing binary (or `crates/target/debug/ompweb-host` exists).
4. Loopback exemptions only work from the server's own machine, and only with the `request-peer-preload` in place.
5. `GET /api/diagnostics` is the single source of the host KPI + backend alerts.
