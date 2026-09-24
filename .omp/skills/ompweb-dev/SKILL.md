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

## Quick pre-flight checklist

1. Port: dev = **30178**, `npm run start` = **30177**, compose = **6767**.
2. Is `OMP_WEB_PASSWORD` set? If yes → login via `/api/web-auth/session` + cookie jar; read the real value from `/proc/<pid>/environ`.
3. Rust-host features → `OMPWEB_HOST_BIN` points at an existing binary (or `crates/target/debug/ompweb-host` exists).
4. Loopback exemptions only work from the server's own machine, and only with the `request-peer-preload` in place.
5. `GET /api/diagnostics` is the single source of the host KPI + backend alerts.
