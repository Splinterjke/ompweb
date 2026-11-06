# omp-web - Development Notes

## Quick Start

```bash
npm run dev     # Bun server with hot reload (HMR for the SPA), port 30178
npm run build   # bundle the SPA into dist/ (scripts/build-client.ts)
npm start       # serve dist/ + the API, port 30177
npm test        # bun test --parallel (Bun runs the node:test API too)
npm run smoke   # start the built server and `ompweb host` (or a packed install: -- --package <dir>; a binary: -- --binary <path>) and check them
npm run build:binary [-- --target bun-<os>-<arch>]   # build, then compile release/ompweb-<os>-<arch>/ and its .tar.gz/.zip (scripts/build-binary.ts)
npm run typecheck && npm run lint
```

**Optional graphify graph** (upstream #358): the repo tracks `graphify-out/graph.json`
and a `.githooks/pre-commit` that rebuilds it per commit. It is INACTIVE unless you run
`uv tool install graphifyy==0.9.99 && sh scripts/setup-hooks.sh` per clone — keep it
inactive here: the hook refuses `git commit <path>` commits, and this repo's convention
is pathspec-scoped `git add -- … && git commit -m … -- …`. Bypass with `GRAPHIFY_SKIP_HOOK=1`.

Typecheck: `node_modules/.bin/tsc --noEmit`  
Lint: `npm run lint`  
The server (dev/start/build/smoke) runs on **Bun** (`bun` is a dependency; the npm package
brings its own), and `npm test` is upstream's **`bun test --parallel`** — Bun implements the
`node:test` API, so both the fork's node-style suites and the DOM-harness tests
(`tests/setup-dom.mjs`, extensionless `.tsx` imports) run under it; the `.tsx`-importing
suites do NOT run under bare `node --experimental-strip-types --test`.
The dev server needs the `omp` binary installed (on `PATH`, or set `OMP_WEB_OMP_BIN`).
All live-agent features go through it; session browsing works without it.

## Testing a dev instance (auth + prerequisites)

Before you can hit the dev server's `/api/*` with `curl`, you need to clear the
auth gate. This is the single most common thing an agent gets wrong when smoke-
testing — read this before assuming an endpoint is broken.

### Web password gate (`OMP_WEB_PASSWORD_HASH`)

`proxy.ts` is a Next middleware that gates **all** `/api/*` requests behind a
session. The gate is keyed by the scrypt hash in `OMP_WEB_PASSWORD_HASH`
(generated with `ompweb hash-password`); an unauthenticated `/api/*` request
gets `401 {"error":"Password required","code":"password_required"}`, non-API
paths get a 302 to `/login`. A configured-but-broken password (leftover
plaintext `OMP_WEB_PASSWORD`, or a malformed hash) answers **every route**
with `503` plain text (and logs one console error at boot) — it never
degrades into an open server. A lone `OMP_WEB_PASSWORD` is migrated by the
launcher: it is hashed at startup, deleted from the server's environment, and
a warning prints the hash to set instead. With `OMP_WEB_TRUSTED_HEADER_SHA256`
set, a request whose `X-Omp-Web-Auth` header hashes to that digest counts as
signed in (the trusted-reverse-proxy vouch; `OMP_WEB_TRUSTED_PROXY=1` remains
separate legacy loopback-via-forwarded-headers behavior for the pairing gate,
not an authentication vouch).

The dev server is usually launched with **no** password hash (gate off), so
plain `curl http://127.0.0.1:30178/api/...` works. But if it's launched with
one (the docker compose default ships an `OMP_WEB_PASSWORD_HASH` for the dev
password `asdf1234`; the entrypoint also hashes a legacy `OMP_WEB_PASSWORD`
once and persists it under the bound `.omp` store), you must log in first.

**Loopback test flow** (from the same machine as the server):

```bash
# 1. log in -> sets the omp_web_session cookie
curl -s -c /tmp/jar -X POST \
  -H 'Content-Type: application/json' \
  -d '{"password":"<PW>"}' \
  http://127.0.0.1:30178/api/web-auth/session   # -> 200 {"ok":true}

# 2. call the API with the cookie
curl -s -b /tmp/jar http://127.0.0.1:30178/api/diagnostics
```

- Login endpoint is `POST /api/web-auth/session` with body `{"password": "…"}`.
  There is **no** `/api/web-auth/login`.
- The cookie is `omp_web_session` (HttpOnly). Pass it back with `-b /tmp/jar`.
- A wrong password returns `401` too (indistinguishable from "no password set
  yet" by status alone) — if you get 401 on the login call, the configured
  password differs from what you sent. Only the hash reaches the server env
  (a plaintext-only config 503s instead of 401s), so read the configured hash:
  `tr '\0' '\n' < /proc/<next-server-pid>/environ | grep ^OMP_WEB_PASSWORD_HASH=`
  (the value lives in the *next-server* child's env, not the wrapper's, if you
  launched it manually; for the docker/deployed instance it's in the entrypoint
  env).
- To read a running server's configured password hash without guessing: inspect
  its `/proc/<pid>/environ`.
- Non-loopback hosts are allowed only if listed in `OMP_WEB_ALLOWED_HOSTS`
  (comma-separated). Loopback (`127.0.0.1`, `localhost`) is always allowed.

### Loopback detection (why remote clients can't spoof)

`proxy.ts` detects loopback via the socket peer IP, which the Bun server itself
stamps at the HTTP boundary: `server/app.ts` `stampPeer()` deletes any
client-supplied stamp and sets `x-ompweb-socket-peer` +
`x-ompweb-socket-proof` (HMAC of the real `server.requestIP()` address with a
per-process secret, from `bin/request-peer.js`) on every incoming request, so a
client cannot forge a "loopback" header. This means:

- **You can only exercise loopback-gated paths (e.g. the `/api/ui/refresh`
  exemption) from the machine running the server.** A remote `curl` is not
  loopback and will be denied.
- The in-server stamp is what makes `isLoopbackConnection()` trustworthy; a
  Request that never passed through `stampPeer()` carries no proof, and
  loopback detection fails closed. (Dev and production share `startServer`,
  so both stamp identically.)

### Host daemons (JS only)

There is no Rust host any more. The only host this machine runs through is the
JS `ompweb host` daemon (`bin/omp-web-host.js`, see "Local daemon"): it owns
every omp child and every machine-local file/git/session op, reached over the
link (`getHost("local")`). Without a linked daemon the server still browses and
reads sessions, but sending a message fails with the host offline, and in
production the local row of Settings → Hosts shows offline (with the banner
telling you to start `ompweb host`).

### Quick checklist before testing a dev instance

1. Confirm the port (dev = `30178`, `npm run start` = `30177`).
2. Check whether the server has `OMP_WEB_PASSWORD_HASH` set (gate on/off). If on,
   log in via `/api/web-auth/session` and keep the cookie jar.
3. For live-session testing you need a linked daemon for THAT server. Dev mode
   skips `ensureLocalHostLink`, so the dev server never points the daemon at
   itself (and the production `host.json` keeps the daemon on the deployed
   server). To smoke-test locally, run a production-mode server on a throwaway
   port with `OMP_WEB_PORT` set and start `bun bin/omp-web-host.js` (see the
   "Local daemon" section; NEVER aim a throwaway daemon at the deployed
   instance's agent dir/token).
4. Remember the loopback exemption only works from the server's own machine.
5. The diagnostics route (`/api/diagnostics`) drives the health KPIs and the
   backend-error list — if it 500s, the whole panel shows a fallback even when
   everything else is fine.

---

## Long sessions: avoiding re-verification loops

ompweb tasks (especially multi-fix bug sessions) easily outlive the ~200 k
context window. One 17-hour bug-fixing session compacted 32 times, and every
compaction archive instructs the agent to *re-derive from the workspace
(re-read files, re-run commands)* rather than guess. That is correct for code
state, but without a durable record of what is already done it turns "I
verified X" into "re-verify X" — observed: one fix re-checked 20+ times across
hours, one test file re-run 55×, the full suite 65×, the dev server restarted
122×.

Rules:

- **Commit as you go.** As soon as a fix is implemented and verified (tests
  pass, browser check confirmed), commit it in its own commit. `git log` +
  `git status` becomes the durable "done" ledger that survives every
  compaction and server restart. After a compaction or restart, check the git
  state first — never re-do or re-verify work that is already committed and
  green unless its inputs changed.
- **Before re-running any verification** (E2E, browser check, full test
  suite), confirm the inputs changed since the last run (code edit, server
  restart, config change). Same inputs → the previous result is still valid;
  skip the re-run.
- **E2E restart tests must not kill the server hosting the current agent
  session.** Killing it (e.g. `pkill -f "next dev"`) interrupts the running
  turn, triggers a "server restarted — continue from persisted context"
  re-establishment, and restarts the whole re-verification cycle. Run
  restart tests against a throwaway instance on a non-sibling port (see the
  `ompweb-dev` skill, "E2E / restart testing").
- **Keep a progress ledger in the todo list.** Mark items with explicit
  completion evidence ("verified in browser 15:32", "tests green", "committed
  as `abc123`") so the todo itself carries the proof across compactions, not
  just the task name.

## Architecture

omp-web never imports `@oh-my-pi/*` or `@earendil-works/*` packages, even
though the server now runs on Bun: live work goes through the installed `omp`
child. See `DESIGN.md` for the full porting contract.

```
Browser                Bun server (server/app.ts)        local `ompweb host` daemon      omp child process
  │                        │                                  │                            │
  ├─ GET /api/sessions ────▶ reads ~/.omp/agent/sessions/     │                            │
  ├─ GET /api/sessions/[id] reads .jsonl file directly        │                            │
  ├─ SharedWorker ── GET /api/events ──▶ ONE multiplexed SSE per browser │                 │
  │   (all tabs)     POST /api/events ─▶ subscribe running/session/file  │                 │
  │                        │                                  │                            │
  ├─ send message ─────────▶ POST /api/agent/[id]             │                            │
  │                        │   startRpcSession() ── host.spawnRpc ──▶ spawn ──▶ omp --mode rpc-ui
  │                        │   sendCommand({type:"prompt"}) ──▶ (channel) ────▶ (NDJSON stdio)
  │                        │                                  │                            │
  ├─ session subscription ─▶ event-stream-hub onEvent() ◀── event frames ◀─────│           │
  │                        │   (via the shared /api/events socket)             │            │
  │◀── event: s<n> data: {...} ──│                                  hello/adoption ──▶│     │
```

The launcher (`bin/omp-web.js`) and the host daemon (`bin/omp-web-host.js`)
and tray run on Node. The launcher spawns `bun server/main.ts` (Bun resolved by
`bin/bun-runtime.js`: the npm `@oven/bun-*` binary, else `bun` on `PATH`), which
serves the SPA from `dist/`, the API routes and the password gate in one
process. Nothing in the daemon or tray may use a Bun API. The compiled binary
(`server/binary.ts`) is the exception: one Bun program that runs the server in
its own process (no launcher), `ompweb host` and `ompweb hash-password`.

**Session browsing** (read-only): pure-Node parsing of omp session `.jsonl`
files via `lib/session-reader.ts` — no child process involved.  
**Sending a message**: `startRpcSession()` in `lib/rpc-manager.ts` asks the
session's `Host` (`lib/hosts/host.ts`) to `spawnRpc` — for this machine that is
the `ompweb host` daemon's link (`getHost(LOCAL_HOST_ID)` in `lib/hosts/hub.ts`,
offline while no daemon is linked; `lib/hosts/local-host.ts`'s direct spawn runs
only INSIDE the daemon) — and runs `lib/omp/rpc-process.ts` over the returned
transport (one omp process per active session). Every machine-local action of a
session wrapper (spawn, session-file checks, list invalidation) goes through
that host; when the web server restarts, still-running children are ADOPTED
(see "Local daemon").

Shared foundations in `lib/omp/`:

- `paths.ts` — Node port of omp's directory resolution (`~/.omp/agent`,
  profiles, XDG, session dir slugs).
- `omp-cli.ts` — locate/probe the installed `omp` binary (`resolveOmpBin`,
  `getOmpVersion`).
- `rpc-process.ts` — process + NDJSON protocol layer (`RpcProcess`).
- `rpc-transport.ts` — `RpcTransport`: the byte pipe under `RpcProcess`
  (`spawnLocalRpcTransport` for a local child; `RemoteRpcTransport` in
  `lib/hosts/hub.ts` for a remote one).
- `auth-gateway.ts` — shared, idle-killed `omp auth-gateway stdio` child:
  omp's own credentials and models behind JSON-line gateway requests.
- `title-generator.ts` — web mirror of omp's auto-title generator (opener
  gates, model chain, response parse); drives `auth-gateway.ts` for the
  mid-run session naming in `rpc-manager.ts`.

---

## File Map

```
server/
  main.ts             production entry: sets NODE_ENV, then `startProduction` (app.ts); prints the `Ready on` line the launcher waits for
  binary.ts           the compiled `ompweb` (scripts/build-binary.ts): the launcher's checks (`checkLaunchSecurity`) and `startProduction` in-process, `host` (lib/hosts/host-cli.ts), `hash-password`; refuses tray/service commands
  dev.ts              dev entry (`bun --hot`): serves the HTML import with HMR; re-runs itself once with OMP_WEB_PUBLIC_* set so `bunfig.toml` can inline them
  app.ts              `startServer`: `Bun.serve` + route table + gate + SPA fallback; `startProduction` (listen, `register()`, Ready line); `parseListenArgs`
  routes.ts           the API route table (see "Adding an API route"); `routePattern`, `dispatch`
  http.ts             `finalizeResponse` (security headers, gzip for pages and static files, never `/api/`), `serveFile` (dist/, public/, KaTeX), `renderIndex`
  client-env.ts       build-time constants for the browser bundle (app version, event-stream worker hash)
app/
  index.html          the SPA shell, the bundler entry; #root holds static copies of RouteLoadingFallback and (swapped in on /login by an inline script) LoginForm's first render, painted before the bundle runs
  client.tsx          browser entry: renders `LoginForm` on `/login`, else `AppShell` (a path check, no router)
  boot.ts             runs first in client.tsx: installs the sidebar history bridge before AppShell registers popstate listeners
app/api/
  sessions/route.ts               GET  list all sessions
  sessions/search/route.ts        GET ?q= — NDJSON { scores } batches (titles + transcripts); closing the request stops the scan
  sessions/[id]/route.ts          GET/PATCH/DELETE session
  sessions/[id]/context/route.ts  GET ?leafId= — context for a specific leaf
  sessions/[id]/matches/route.ts  GET ?q=&limit= — best `limit` search hits in the active conversation (best match, then newest); Load more asks for a longer prefix
  sessions/[id]/export/route.ts   GET exported HTML for a session
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST any RPC command
  events/route.ts                 GET multiplexed SSE | POST subscribe/unsubscribe channels (running/notifications/host-tools/session/file)
  events/link/route.ts            GET WebSocket upgrade: the browser link (lib/browser-link.ts), bound to the request's web session; gated like every API route, 426 without an upgrade
  transport-metrics/route.ts      GET { now } (the SSE clock probe) | POST { samples } → <agent dir>/omp-web/transport-metrics.jsonl
  hosts/route.ts                  GET hosts (this machine first) | POST { label } → token once + login command | PATCH { id, label?, allowAgentStart? } (`local`: label only, empty resets to "This machine") | DELETE ?id= revoke (registry first, then close the link); 503 if hosts.json is unreadable
  hosts/link/route.ts             GET WebSocket upgrade (the `ompweb host` daemon; bearer checked before the upgrade, skipped by the `proxy.ts` gate) | POST 426 for pre-WebSocket daemons
  notifications/devices/route.ts  GET VAPID key + subscribed | PUT { deviceId, prefs, subscription? }
  notifications/presence/route.ts POST { clientId, deviceId, visible, sessionId, seq }
  notifications/test/route.ts     POST { deviceId } send a test push (502 on push-service refusal)
  notifications/history/route.ts  GET entries | PATCH { ids } mark read | DELETE ?id= remove one, ?all=1 clear
  chat-event-actions/route.ts     GET/POST named actions fired on chat events
  chat-event-actions/[id]/route.ts  GET/PATCH/DELETE a single action
  auth/**                         provider list, login/logout, API keys (via RPC)
  cwd/validate/route.ts           POST validate/select a cwd
  default-cwd/route.ts            POST create ~/omp-cwd-YYYYMMDD
  files/[...path]/route.ts        GET file contents for viewer
  media/[hash]/route.ts           GET tool-result image by sha256 (?thumb=1 → 480px WebP preview)
  home/route.ts                   GET user home directory
  models/route.ts                 GET { models, modelList, defaultModel }
  models-config/route.ts          GET/PUT — read/write ~/.omp/agent/models.yml
  models-config/test/route.ts     POST test a configured model/provider
  omp-settings/route.ts           GET/PUT native config.yml settings (allow-listed)

  mcp/route.ts                    GET/POST/PUT/DELETE project MCP servers
  plugins/route.ts                GET/POST plugin management (shells out to `omp plugin`)
  projects/route.ts               GET registered+discovered projects | POST add | DELETE hide
  skills/route.ts                 GET/PATCH loaded skills and disable-model-invocation
  skills/install/route.ts         POST install skills through npx skills add
  skills/search/route.ts          GET/POST skills.sh search
  stt/route.ts                    POST audio (+scope) → 202 { jobId } | GET ?scope= live jobs (lib/stt-jobs.ts)
  stt/[jobId]/route.ts            GET job state | POST retry with kept audio | DELETE ?claim= claim/discard
  stt/[jobId]/audio/route.ts      GET the kept recording (audio/* only) for playback
  uploads/route.ts                POST { id, host, name, size, type } start/resume a composer upload (SSE-mode path of the browser link's `up_start`) → { received, done }
  uploads/[id]/route.ts           PUT ?offset=N raw body ≤ 1 MiB, answered once the host acked it (409 `upload_offset` with { received }) | DELETE abort
  usage-reset/route.ts          GET saved Codex/Claude rate-limit resets (`omp usage reset --json`) | POST {target} spend one (Settings → API Keys & Providers → Rate-limit resets)
  web-settings/route.ts          GET/PUT server settings (auto-resume sessions, browser transport; a transport change is pushed to every open browser)
  worktrees/route.ts              GET/POST/DELETE git worktrees

lib/
  dynamic.tsx          `dynamic()` over `React.lazy` + `Suspense`
  navigation.ts        `useRouter`/`useSearchParams` over the History API
  omp/                 shared omp foundations (paths, CLI probe, RpcProcess)
  hosts/               hosts and the local daemon (see "Remote hosts"); none of the daemon-loaded files may import `@/` (the daemon runs on Node through `jiti`)
    host.ts            `Host` interface, `HostStatus`, `isLinkUp`
    local-host.ts      `localHost`, the daemon's side: spawn + file checks on the daemon's machine; `resolveSpawnCwdResult`; `SESSION_EDIT_EXTENSION_PATH` (from the module's own location: the daemon runs in HOME). Never imported by main, nor is `daemon.ts` (`no-direct-local.test.mjs`)
    local-bootstrap.ts web server side of the local link: `localLinkUrl`, `ensureLocalHostLink` (the `local` record + `host.json`)
    host-login.ts      `host.json` (`loginHost`, `readHostLogin`) and `isLoopbackHost`, shared by the daemon and local-bootstrap
    session-ops.ts     file-reading half of the session/project routes, run on the owning host's daemon (this machine's too)
    uploads.ts         daemon side of composer uploads: `StagedUploads` (staging dir `<agent dir>/omp-web/uploads/`, offset writes, 24 h sweep, attach into the session's `local/uploads/`), `sanitizeUploadName`, `sessionLocalRoot`
    upload-retention.ts  daemon side of sent-upload retention: `UploadRetention` (op `setUploadRetention`, `<agent dir>/omp-web/upload-retention.json`, sweep at start and every 24 h), `sweepSentUploads`; `upload-retention-sync.ts` is main's side (`startUploadRetentionSync` on every hello, `pushUploadRetention` when the setting changes)
    link-protocol.ts   link messages, codec, binary blob frames, close codes, size limits, `HOST_OP_NAMES`, `SeqWindow`/`Outbox`, `LinkSender`/`PartJoiner` (pieces, fair sending)
    hub.ts             main side: the link's upgrade and `websocket` handler (`handleLinkUpgrade`, `hostLinkSocket`), `RemoteHost`, `getHost`, `listHosts`, adoption of live children (`reattach`/`adopt`), orphans, `freezeHostLinks`, `hosts` change events
    daemon.ts          daemon side: `runHostDaemon` (reconnect, buffering, op dispatch, hello with each child's `{sessionId, cwd, pending}`; follows a `host.json` url or token change when a dial fails; loopback redials at most 3 s apart)
    pending-requests.ts daemon side: `PendingRequests`, a channel's still-open blocking requests and current session id for the hello
    registry.ts        `<agent dir>/omp-web/hosts.json`: create/update/revoke, token hashing and lookup; the `local` record (`rotateLocalHostToken`, `customLocalLabel`)
    session-index.ts   sessions and projects across hosts, cached per host; `hostForSessionId`, `sessionSpawnTarget`, `invalidateLocalSessionLists`
    update-types.ts    shared per-host software status and operation contract
    updates.ts         daemon-side version checks, compatibility gate and durable update state
    update-worker.ts   host-only install/restart helper; never starts or stops the web-server service
  provider-accounts.ts distinct omp accounts per provider from `omp usage` reports (Models → provider detail)
  agent-client.ts      agent commands from the tab: POST /api/agent/[id], or the worker's browser link in the `ws` transport; records each command's `action` sample
  agent-command.ts     `runAgentCommand`: the one command path behind POST /api/agent/[id] and a browser link's `cmd`
  browser-link.ts      `/api/events/link`: Bun `websocket` handler for the browser link (sequencing, pieces, resume, `(session, rid)` dedupe)
  btw.ts               /btw side-question records + pure frame/snapshot merge (order-safe)
  chat-event-action-types.ts  ChatEventType + ActionSpec union (notification/http/bash/scheduled)
  chat-event-action-store.ts  persistence (~/.omp/agent/chat-event-actions.json), validation, per-event cache
  chat-event-action-bus.ts  globalThis relay for `chat_event_action` frames (running event-stream channel)
  chat-event-actions-executors.ts  run each action type (never throws, records lastRun)
  chat-event-actions-dispatcher.ts  event → enabled actions, per-run dedupe
  diff-model.ts        Copilot-style diff model: unified-diff parsing, hunk/gap items,
                       progressive hidden-lines reveal, split rows + word spans
  event-stream.ts      tab-side EventSource-shaped streams over the shared worker
  event-stream-worker.ts  the shared worker: the one EventSource or browser link per browser (bundled by server/client-env.ts)
  event-stream-hub.ts  server connections + running/notifications/host-tools/session/file channels for /api/events (SSE) and the browser link (`FrameSink`); `broadcastBrowserTransport`
  event-stream-protocol.ts  wire contract shared by hub, route, worker, and facade
  file-access.ts       allowed file roots for /api/files and worktrees
  file-authorization.ts  single allow-list gate for /api/files and the file channel
  media-cache.ts       tool-result images → /api/media URLs; media copies + thumbnails
  file-paths.ts        client/server path encoding helpers
  markdown.ts          shared markdown helpers
  npx.ts               npx runner used by skill install
  pi-types.ts          local structural types for agent/RPC objects
  project-ordering.ts  pure project sort/group/activity helpers (client + tests)
  project-command-env.ts  child-process environments: strips PORT/NODE_ENV/NEXT_*, omp-web secrets and the request-peer proof secret
  project-registry.ts  on-disk managed-project registry (~/.omp/agent/projects.json)
  notification-events.ts  shared: event/prefs/history-entry types, frame→event detector, renderNotification()
  notification-hub.ts  server: presence, routing, Web Push, recording published notifications
  notification-store.ts  server: SQLite store for VAPID keys, devices and the notification history
  notification-history.ts  browser: mirror of the server's notification history (Notifications tab)
  notification-client.ts  browser: device id, prefs store, service worker + push subscription
  rpc-manager.ts       session registry + startRpcSession over RpcProcess (spawn via a Host)
  scheduler-store.ts   script-scheduler persistence (~/.omp/agent/schedulers.json) + ensureSeedSchedulers()
  scheduler-engine.ts  in-process cron (globalThis ticker): fires due scripts, manual runs
  schedule.ts          ScheduleSpec (interval/daily/weekdays/weekly/cron/manual) + next-slot math
  scheduler-seed.test.mjs  seeds the rebuild script as a "Manual launch" scheduler on boot
  session-reader.ts    session .jsonl parsing + path cache + buildSessionContext
  session-search.ts    shared fuzzy/phrase query scorer for sidebar search (title weights ≫ transcript)
  session-content-search.ts  server: per-file transcript text cache (size+mtime) + searchSessions()
  session-search-matches.ts  shared types/constants of the sidebar's per-session search hits
  session-match-listing.ts   server: lists a session's search hits counted per rendered text node (remark parse)
  session-resume.ts    mid-run session tracker (on-disk list) + resume prompt; resume orchestration lives in rpc-manager
  transport-metrics.ts transport samples → `<agent dir>/omp-web/transport-metrics.jsonl` (renamed to `.jsonl.1` above 20 MiB)
  transport-stats.ts   durations of transport samples (percentiles, per-metric derivation) shared by the worker's Connection tab stats and scripts/transport-metrics.ts
  skills-service.ts    skill listing via `omp skill list --json`; pure-Node replica scan as fallback
  tool-presets.ts      PRESET_NONE/DEFAULT/FULL + getPresetFromTools()
  types.ts             shared TypeScript types
  normalize.ts         normalizeToolCalls() — field name mismatch between file format and our types
  navigation-history.ts  pure back/forward view-history stack + shortcut matcher (⌘[/⌘], Alt+←/→)
  worktree.ts          project/worktree resolution and git worktree operations
  web-settings.ts      omp-web server settings (autoResumeSessions) persistence, ~/.omp/agent/omp-web-settings.json
  web-auth.ts          hash-only sign-in check (OMP_WEB_PASSWORD_HASH) + per-install-keyed session cookie
  web-auth-secret.ts   per-installation session-signing key (~/.omp/agent/omp-web/web-auth-secret.json, 0600)
  web-password-hash.ts typed view of bin/omp-web-password-hash.js (scrypt$ln$r$p$salt$digest)

components/
  AppShell.tsx        layout + URL state + tab management
  SessionSidebar.tsx  session tree + FileExplorer; with a linked host the workspaces group per host (`HostGroup`), keyed by `hostProjectKey` (`lib/project-ordering.ts`: bare path on this machine, `<hostId>:<path>` elsewhere)
  ChatWindow.tsx      chat composition + completion sound wrapper
  SessionLoading.tsx  animated SVG letter-build + glowing trail for the session loading state
  ChatInput.tsx       input bar + model/thinking/tools/compact controls
  ComposerPanels.tsx  composer hub bars: /btw side question, git changes, todo plan, subagents (stack or row layout, per-bar visibility)
  BtwPanel.tsx        /btw side-question panel (stream, cancel, copy, follow-up) + history dialog
  SessionSearchMatches.tsx  a search result's hits under its sidebar row (10 at a time + "Load more…")
  TodoList.tsx        todo phase grid with preview/show-all (used by ComposerPanels)
  SubagentTranscriptDialog.tsx  task + final output summary dialog (wide, screen-adaptive)
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
  CommandPalette.tsx  ⌘K/Ctrl+K palette (cmdk): session switch, new session, theme
  ImageLightbox.tsx   click-to-preview lightbox for chat images (ClickableImage)
  BranchNavigator.tsx in-session branch switcher
  NotificationList.tsx  notification history list + Mark all read/Clear toolbar (workbench tab, desktop bell popover)
  NotificationBell.tsx  desktop top-bar bell: unread badge + floating history popover (upstream 351237d7)
  ConnectionDiagnostics.tsx  workbench Connection view: transport in use, status, latency stats (opt-in, Settings → Session & Agent Behavior; the fork's RightWorkbench hosts it instead of upstream's RightPanel tab)
  ChatMinimap.tsx     scroll minimap alongside the message list
  EventActionsPanel.tsx sidebar "Chat event actions" list (between Schedulers and Usage)
  EventActionModal.tsx create/edit chat-event action (event checkboxes + 4 action types)
  MarkdownBody.tsx    markdown renderer
  ModelsConfig.tsx    modal for models/auth configuration
  McpConfig.tsx       project MCP server editor (Settings → MCP tab)
  HostsConfig.tsx     linked hosts: add (token shown once), rename, revoke, allowAgentStart (Settings → Hosts tab)
  HostUpdates.tsx     per-host ompweb/OMP versions, update checks, blocked reasons and update actions
  LocalDaemonBanner.tsx  production-only hint with the install command while no local daemon has linked (90 s grace)
  host-status.ts      host name, status text and dot colour shared by Settings → Hosts and the sidebar
  PluginsConfig.tsx   modal for installed plugins
  SkillsConfig.tsx    modal for loaded/search/installable skills
  FileExplorer.tsx    file tree inside sidebar
  FileViewer.tsx      file content in a tab
  diff/DiffViewer.tsx  shared Copilot-style diff viewer (split/inline, wrap, gutters, hidden-lines bars, Viewed)
  TabBar.tsx          tab bar (Chat + open file tabs)
  WorktreesPanel.tsx  right-workbench Worktrees view: list/switch/create/remove the active repo's worktrees
  ui/                 shared primitives: Dialog/Tooltip/Collapsible, fields, toast

hooks/
  useAgentSession.ts       messages + streaming + SSE + fork/navigate/reconciliation logic
  useHostRows.ts           the `hosts` channel as React state (status of every host; sidebar, new-session picker, Settings → Hosts)
  useAudio.ts              completion sound + browser AudioContext unlock
  useNotifications.ts      presence reports, toast/system delivery, notification clicks
  useBtw.ts                /btw records/active panel/history dialog fed by btw_* SSE frames
  useDragDrop.ts           shared drag/drop state
  useIsMobile.ts           responsive breakpoint hook (exports `matchMobileViewport` for reads outside render)
  useTouchTargets.ts       touch-target density pref (localStorage "omp-touch-targets" → html[data-touch-targets], no Settings UI yet — set via layout boot script)
  useNavigationHistory.ts  in-app back/forward stack (record/peek/commit/drop) for visited chat views
  useWordPrediction.ts     debounced omp predict_word ghost text + feedback
  useChatSearchHighlights.ts  find-in-page for the sidebar search: CSS Custom Highlight API paint + jump to a picked hit
  usePrefersReducedMotion.ts OS reduce-motion preference (SMIL-safe)
  useTheme.ts              theme state (localStorage key "omp-theme"; the top bar's `--bg-panel` → theme-color meta, "omp-theme-color" cookie and the manifest link's ?theme=, see lib/manifest-theme.ts)

bin/
  bun-runtime.js      resolves the Bun binary (npm `@oven/bun-*`, else PATH, minimum version check); used by the launcher, scripts and nix
  omp-web-host.js     `ompweb host [login]`: loads lib/hosts/host-cli.ts through jiti; token read from stdin, never argv. `omp-web.js host` requires it in-process (no child) so SIGTERM/SIGINT reach the daemon's stop

scripts/
  build-client.ts     `npm run build`: bundles app/index.html into dist/ (Bun.build + tailwind-plugin.ts; fonts emitted as /assets files)
  tailwind-plugin.ts  bun-plugin-tailwind minus Tailwind's color-mix() polyfill (Bun 1.4.4 drops repeated @supports rules); build and dev
  smoke.ts            `npm run smoke`: starts the built server (or `--binary <path>`) and `ompweb host` with a throwaway HOME; checks the SPA, an asset, the API, a session listed through the daemon and SSE
  transport-metrics.ts `bun scripts/transport-metrics.ts [--since 2h|<ISO>] [--until <ISO>] [--client <id>] [--session <id>] [--file <path>]`: per-transport summary of the browser transport samples and per host and direction of the host link samples (`--session`: link samples of one session; default: the last 24 h of the agent dir's file)
  link-hol-probe.ts   `bun scripts/link-hol-probe.ts --host <id> --model <provider/modelId>`: head-of-line load on one host link (large prompts down, large session reads up, get_state beside them) for the link samples; usage at its top
  build-binary.ts     `npm run build:binary`: compiles server/binary.ts (NODE_ENV define, no .env/bunfig autoload) into release/ompweb-<os>-<arch>/ beside dist/, public/, the KaTeX files, the session-edit extension and the licenses; archives it
  licenses.ts         the release's `licenses/`: license files of every npm package the server and client bundles hold (Bun.build metafiles; build-client.ts writes build/client-packages.json) and `bun-LICENSE-<version>.md`, the vendored license of the embedded Bun runtime. Bumping Bun: vendor its LICENSE.md for the new version, or build-binary.ts stops

dist/                 build output (git-ignored, shipped in the package); the production server reads index.html and assets from here
bunfig.toml           Bun dev-server bundling: tailwind plugin and the OMP_WEB_PUBLIC_* inlining
```

---

## Key Design Decisions & Traps

### Adding an API route
1. Create `app/api/<path>/route.ts` exporting `GET`/`POST`/`PUT`/`PATCH`/`DELETE` handlers (plain `Request` → `Response`; dynamic segments `[id]`, catch-all `[...path]`).
2. Add one `import * as x from "@/app/api/<path>/route"` and one entry to `ROUTE_MODULES` in `server/routes.ts`; the key is the directory under `app/api` (`"sessions/[id]"`).
3. `server/routes.test.ts` fails when the table and the files on disk differ, and when a route module exports anything but method handlers.

The table is static imports, not a runtime glob, so `bun build --compile` (`scripts/build-binary.ts`) bundles every handler. `dispatch` answers HEAD from `GET`, OPTIONS and a missing method (405 with `allow`), passes `params` as a promise (plus `disableIdleTimeout`, below), and turns a throw into a 500 JSON body.

### Bun server (`server/`)
- Bun's 10 s `idleTimeout` stays on: it reaps sockets that stall before or during a request, and it also cuts a handler still working after 10 s. So `handle` (`server/app.ts`) calls `server.timeout(request, 0)` for an `/api/` request that `proxy()` reports as `"authenticated"` (never `"public"`) and puts the 10 s back once the handler returns or throws: the setting outlives the response on a keep-alive socket. A handler whose response stays open without traffic (SSE `/api/events`, the login SSE, the clone/search/bash-output/file streams) calls `disableIdleTimeout` from the route context (`dispatch`, `server/routes.ts`) to keep it off until that stream ends or is cancelled; a new stream must do the same, or it is cut after 10 s idle. The host link is no longer an idle-lift stream: it is a WebSocket, and an upgraded socket is outside the HTTP idle timeout (so is the browser link, `/api/events/link`). `server/app.ts` passes `upgrade` in the route context (`server.upgrade(request, { data })`) and one `websocket` handler: a socket whose `ws.data.kind` is `"browser"` goes to `browserLink` (`lib/browser-link.ts`, with the close code: 1000/1001 end the link, anything else keeps it for a resume), any other to `hostLinkSocket`. Bun's WebSocket limits (`maxPayloadLength`, `backpressureLimit`, `idleTimeout`) are per server, so browser links share the host link's; `browserLink` caps its own frames at a piece (256 KiB). A handler that upgraded returns `undefined`, which `dispatch` and `handle` pass through without `finalizeResponse` or the idle-timeout restore. `maxRequestBodySize` is left at Bun's 128 MiB default, above the 101 MB upload cap; do not lower it.
- Bun's router matches the **raw** path, while `request.url` is normalized (`..` and `%2e%2e` resolved). The gate and handlers read `request.url`, so each route re-matches the normalized path against its own `URLPattern` after the gate and answers 404 if it no longer matches. Never serve a gated route under an ungated path.
- Redirects carry a relative `Location` (`request.url` is always `http://` under Bun, so an absolute URL would leave https behind a TLS proxy).
- `Response.redirect()` headers are immutable; `finalizeResponse` (`server/http.ts`) copies every answer into a fresh `Response` to set the security headers and gzip. Do not mutate a handler's response headers elsewhere.
- `globalThis` state survives `bun --hot` re-evaluation, and `register()` (`instrumentation.node.ts`) runs once per process behind a `globalThis` guard in `server/dev.ts`. New server singletons use the `globalThis` registry pattern of `rpc-manager.ts`.
- Dev (`npm run dev`) serves the SPA from the HTML import with HMR, bundled in memory, and re-runs itself once with `OMP_WEB_PUBLIC_*` set because `bunfig.toml` inlines them from the environment Bun started with. Dev pages carry `script-src blob:` in their CSP (HMR updates run as blob scripts); production does not.
- `OMP_WEB_PACKAGE_DIR` (set by the launcher) is the root for `dist/`, `public/` and KaTeX; `process.cwd()` is the fallback for dev and tests. The compiled binary sets it to its own directory (unless set) before any server module loads, so every runtime file must come from that root: a module's `import.meta.url` in the binary is Bun's virtual `/$bunfs/`, which no other process can read. A new file the server or daemon reads at runtime also goes into `scripts/build-binary.ts`'s copy list.
- The binary needs `process.env.NODE_ENV` defined as `"production"` at build time (`scripts/build-binary.ts`): a plain `bun build --compile` inlines `"development"`, and the server then never writes the daemon's link. `npm run smoke -- --binary` catches that (no session lists).
- `Bun.serve` turns on `SO_REUSEPORT` when `development` is false, so a second omp-web would share the port instead of failing; `startServer` passes `reusePort: false`, and `startProduction` (`server/app.ts`) reports an `EADDRINUSE` in one line.
- The web-server in-app update worker runs on Node (`OMP_WEB_NODE_BIN`, the launcher's `process.execPath`), not Bun. The compiled web server updates by download (`lib/self-update.ts`). Host-daemon updates use their own helper in `lib/hosts/update-worker.ts`, including for binary hosts; never reuse the web-server worker to restart a host.
- The daemon-owned watcher (`lib/hosts/workspace-watch.ts`) re-stats ~50 ms after every event to catch burst saves (Bun may drop native events within ~2 ms); main only routes its sequenced watch events.
- `bun:sqlite` `.get()` returns `null` for no row (not `undefined`).
- `bun:sqlite` `close()` keeps the database file open while prepared statements are alive (until GC), so Windows cannot remove or replace it: the stores close with `close(true)`, which finalizes them (`closeNotificationStore`, `closeUsageDatabase`).
- `readSttConfig` lives in server-only `lib/stt-jobs.ts`; the browser bundle must never import it.
- Browser code must not import `next/*`: use `lib/dynamic.tsx` and `lib/navigation.ts`.

### Tests (`npm test`, or `bun test --parallel`)
- `--parallel` is required, not just faster: Bun gives each file a fresh global/module registry. The transport singleton (`lib/event-stream.ts`) and each file's `SharedWorker`/fetch/DOM fakes otherwise leak into the next file; a shared-process run can send commands to another file's fake worker. These fixtures are deliberately file-isolated rather than reset between files. Use `--parallel` even for a multi-file subset.
- DOM tests import `tests/setup-dom.mjs` first and then import Testing Library dynamically, so its queries bind to that document. Nothing is torn down.
- A module under test that must see a fake builtin is imported with a fresh query (`?fresh=N`) after `mockBuiltin(t, name, overrides)` (`tests/mock-builtin.mjs`, built on `mock.module`; Bun's `mock.restore()` does not undo `mock.module`, so the helper restores by hand).

### RPC session lifecycle (`lib/rpc-manager.ts`)
- One wrapper per session id, keyed in a `globalThis` registry.
- `globalThis` survives `bun --hot` re-evaluation; a plain module-level Map does not.
- Idle sessions are disposed after a timeout; concurrent `startRpcSession()`
  calls must share a single start promise.
- **Prompt images and the child-stdin frame cap**: user-prompt images stay
  inline base64 in the `prompt` command, and that command is ONE complete NDJSON
  line on the child's stdin. omp parses stdin records as WHOLE lines and
  protocol-v2 `rpc_chunk` reassembly exists only in the child's OUTBOUND
  direction — verified against omp 18.13.3: a 6.18 MB single-line prompt is
  accepted, while inbound `rpc_chunk` records are rejected as "Unknown command"
  even after a successful `negotiate_protocol`. So `RpcProcess.writeFrame` (the
  one stdin writer, running inside the daemon) preflights the EXACT escaped
  line size against `MAX_IPC_FRAME_BYTES` (`rpc-frame.ts`, 16 MiB) and refuses
  with a plain "Prompt payload is too large…" error before touching the pipe —
  the routes' 8 MiB-body / 5 MiB-image gates alone are NOT sufficient, because
  JSON-string-inside-JSON escaping can double a body-sized payload. Frames
  FROM omp children legitimately exceed the per-line READ cap (user-message
  image echoes): omp chunks them into `rpc_chunk` lines and `RpcProcess`
  reassembles (`MAX_RPC_REASSEMBLED_BYTES`) — the per-line read cap is a
  transport framing bound, not a payload budget.
  Regression: `lib/omp/rpc-frame.test.mjs`,
  `RpcProcess refuses an over-cap command without writing anything to stdin`
  (`lib/omp/rpc-process-runtime.test.mjs`).
- Two cleanup backstops, both unref'd so they never hold the event loop:
  `IDLE_DESTROY_MS` (10 min) and `DISCONNECT_DESTROY_MS`
  (`OMP_WEB_DISCONNECT_DESTROY_MS`, 2 min, `0` disables). The shorter one only
  fires once a session has been genuinely abandoned — no `onEvent` listener, no
  run in flight, no startup handshake, no unanswered `send()` or command preparation.
  The last `onEvent` detach *starts* that window rather than exposing the last frame's,
  so a reload reattaching seconds later does not 409. Both are fed by
  `resetIdleTimer()`, the single activity choke point for `send()` and every
  child frame: adding a new call path must route activity through it.
- **Wedged-run watchdog** (`STALL_CHECK_MS` / `STALL_SILENCE_MS`,
  `OMP_WEB_STALL_CHECK_MS` / `OMP_WEB_STALL_SILENCE_MS=0` disables): an omp
  worker can deadlock inside its post-turn maintenance routing (observed on
  18.12.6 with a stale `async-result` yield entry) and never emit the terminal
  `agent_end` — while still answering `get_state` with `isStreaming: true`
  forever, so **liveness is not the oracle, only progress is**. Armed at
  `agent_start`, the wrapper treats every child-originated frame as progress
  (own `response` replies NEVER count — a reconcile poll proves nothing);
  after 10 min of silence it probes `get_state` twice: child reporting the
  run finished ⇒ the swallowed terminal is completed locally (synthetic
  terminal `agent_end`, held-completion flush, running-badge clear); child
  still claiming streaming with `messageCount` frozen across both probes ⇒
  ONE warning notice pointing at `/reload` (never an auto-restart — a long
  silent tool costs only a dismissible warning; ask/host-tool/compaction
  waits suppress the probe entirely). `WebSessionState.stalledSuspected`
  carries the flag; late child activity clears it and re-arms. `/reload`
  restores the worker-held queue (`queuedMessagesRef`) into the composer,
  because the queue lives only inside the child a reload replaces.

### Cross-session host tools and the ask dialog (`lib/rpc-manager.ts`, `host-tools` channel)
- Agent-callable host tools (`open_url`, `notify`, `open_file`) are registered per session via `set_host_tools`. While a tab is viewing the session, `host_tool_call` frames go to that session's own event stream and the tab answers with `host_tool_result`. When **no** tab views the session (the user switched sessions mid-run), the call is broadcast to *every* open omp-web tab through `subscribeHostToolCalls()` + the `host-tools` event-stream channel; each tab executes the tool and sends a `host_tool_result`, and the server settles the call on the first one received (`pendingHostTools.delete`, so later duplicates are no-ops).
- Calls routed to other tabs are flagged `webCrossSession` in `pendingHostTools`. When the last other tab leaves (`subscribeHostToolCalls` unsubscribe with an empty set), only the cross calls are settled via `rejectCrossSessionHostTools()` (`which: "cross"`) — the session's own outstanding calls are untouched; when the session's last listener detaches, only the own calls are rejected.
- Full-page Settings hides the chat, so its session counts as *not viewed* (`viewing = call.sessionId === selectedSession?.id && !settingsTab` in `AppShell`) — opens from it go through the confirm queue like any cross-session open.
- URL opens from a session the tab is **not** viewing always go through the `pendingOpens` confirm queue (`ConfirmDialog` in `AppShell`). The "Open agent links without asking" setting only auto-opens links from the viewed session (`!crossSession && openUrlAutomatically`).
- The multi-question `ask` dialog is opted into on spawn **and** respawn with `set_ask_dialog` (bounded like `get_state`, so a child that never answers cannot stall startup); older omp rejects the command and the per-question select/editor fallback keeps working. Pending `ask` requests only accept their `answers` payload or a cancel — `isAskAnswers()` shape-checks it in `extension_ui_response`, so a replayed reconnect response cannot drop them with a stale/malformed payload.
- The ask panel's "Other" is an **option row** (port of upstream ac4d5ecb): its
  radio/checkbox (`otherChosen`) marks the answer, and the text lives as long as
  the question — choosing a regular option only *unchooses* Other (the typed text
  stays in the row; `customInput` is sent only while Other is chosen and non-blank).
  Typing chooses Other (replacing a single-select choice); clearing unchooses; a
  tap or focus back into kept text re-chooses it (`chooseKeptOther` — a touch tap
  that finds focus already in the box fires no focus event, so `onClick` covers it).
  While an ask is open the composer **hides** (`display: none`, kept mounted so the
  draft/attachments/recording survive) and blurs, or its phone keyboard would
  survive into the panel and make the first tap miss (see the keyboard hysteresis
  in `ExtensionDialog`'s mobile tests).

### Remote hosts (`lib/hosts/`, `app/api/hosts/`, `bin/omp-web-host.js`)
- **Host seam** (`lib/hosts/host.ts`). Every host, this machine included, is
  reached over the link: `getHost(id)` (`hub.ts`) returns a `RemoteHost` whose
  calls go to a daemon. `getHost("local")` is the link of this machine's own
  `ompweb host` daemon (see "Local daemon"); there is no direct spawn or file path
  on main. `localHost` (`id: "local"`, `local-host.ts`) is the daemon's side: it spawns
  and reads files on the machine the daemon runs on. `startRpcSession(..., host)`
  asks `host.spawnRpc` for an `RpcTransport`; `RpcProcess`, the wrapper, the
  event hub, notifications, the queue and `/btw` never see where omp runs.
  Session and project file reads are `host.sessionOps` (`session-ops.ts`, run in
  the daemon), addressed by session id, never by path: routes use `resolveSessionHostOr404`
  (`lib/api-utils.ts`) and the host resolves the file itself. New route code
  must not open a session file on main for a session that may be remote or local.
  `SessionInfo.hostId` and `ManagedProject.hostId` carry the host; sidebar and
  project state key on `hostProjectKey` (bare path on this machine, `<hostId>:<path>`).
- **Link = one WebSocket per host, dialled by the daemon** (`/api/hosts/link`;
  design `docs/specs/2026-10-31-websocket-link-design.md`). **Text frames**
  carry the messages (hub → daemon one per frame; daemon → hub newline-separated
  batches flushed every 16 ms or at one 256 KiB piece), **binary frames** carry large op
  results (daemon → hub, before the `res` naming them) and, from v6, upload bytes
  (hub → daemon, `up:<id>`). Every line except
  `hello`/`welcome`/`ack`/`ping`/`pong` has a per-direction `seq`; `ack {ack}`
  is a message: the first line of every daemon frame, and the hub answers every
  uplink frame (v5: binary ones too) with exactly one. **Pieces and fair sending
  (v5, design D7):** a
  line over `LINK_LIMITS.pieceBytes` (256 KiB) goes as sequenced `part {at, end,
  data}` messages (`PartJoiner` joins them, one partial line at a time, ≤ 512
  parts) and a
  result as binary frames of at most 256 KiB; both sides queue per key (channel,
  or request id) in `LinkSender`, send round-robin and number each line as it
  goes out, so wire order stays `seq` order. **Unacked window:** each side sends
  queued units only while less than `LINK_LIMITS.unackedBytes` (512 KiB; ≤ 768 KiB in
  flight with the last unit, ~3.1 s at 2 Mbit; ~512 KiB per round trip of throughput) is
  unacked, since kernel/proxy buffers hide megabytes from `bufferedAmount` and
  Bun's `send`: the hub counts outbox lines written (`unacked`, shrunk by the
  daemon's `ack` line), the daemon counts frames the hub has not answered (one
  `ack` per frame) and also waits for `bufferedAmount` under two pieces. The
  daemon acks applied downlink lines within 16 ms (ack-only frame if need be).
  A small message waits behind at most that window plus about one piece per
  busy key; control lines skip both. The
  `hello` is the first text frame of a socket. Each `hello.channels`
  entry carries `pending`: the raw stdout lines of that child's
  still-open `host_tool_call`s, `host_uri_request`s and blocking `extension_ui_request`s
  (`PendingRequests`), or null past `LINK_LIMITS.pendingBytes`. Each side keeps unacked
  lines, resends after a reconnect and drops any `seq` it already applied. The
  hub decodes a whole frame before applying any of it (a bad line closes 1007).
  `hello.ack === 0` means a fresh daemon: main restarts that host's uplink
  window. The hub paces the downlink from its outbox (`drain`): the 16 MiB send
  buffer limit (`closeOnBackpressureLimit`) is only a backstop, and the outbox
  holds the unacked backlog in server memory. A v4 daemon still gets whole
  lines, so for it a multi-MiB line slower than `offlineMs` is retried (below
  roughly 280 KiB/s for an 8 MiB line). Close codes: 1000 revoke,
  1001 freeze (a real SIGTERM exits first, so daemons usually see 1006 or
  ECONNREFUSED), 1007 bad frame, 1008 bad first frame, 1009 too big, 4409
  replaced,
  4426 version (`LINK_CLOSE`). Wire shapes and size limits live in
  `lib/hosts/link-protocol.ts` (one op allow-list, `HOST_OP_NAMES`, shared by
  both sides); the summary spec is `docs/specs/2026-10-28-remote-hosts-design.md`.
- **Link head-of-line samples** (`metric: "link"` in `<agent dir>/omp-web/transport-metrics.jsonl`, measurement
  only). Each side samples every sequenced message once, when it is queued: time, UTF-8 size, session (a session
  op's `id`, else the channel's child as its `get_state` answers name it) and `bytesAhead`, the bytes queued or
  unacked on that link then (`LinkSender.queuedBytes` plus an unacked counter, never a scan; a queued line counts at
  its size before its seq is filled in, up to 15 bytes over). The sample is made when the message is acked: a line
  sent in parts at its last part, with the joined size; a `res` counts its result bytes as its own. The hub writes
  its `down` samples; the daemon reports its `up` ones in sequenced `stats` messages of at most
  `LINK_LIMITS.statsSamples`, queued under their own sender key (fair and inside the unacked window like any
  message). The samples are advisory: the hub keeps the valid ones, drops a malformed one (logged once per host) without
  failing the frame, and writes at most 8 × `statsSamples` `up` samples per host per `statsFlushMs` (the excess is
  written as one `{dropped}` record when the next window starts, or when the link ends or the hub freezes). `ackMs` is monotonic (`performance.now()`) on both
  sides, `at` the wall clock. Both sides batch (`statsSamples` or `statsFlushMs`, 30 s): the hub's batch lives in its
  `globalThis` state, resolves its file when it starts and is written in `freezeHostLinks`; the daemon queues what it
  holds when it stops (best effort). Tests that drive the hub call
  `flushLinkSamples()` before they restore `PI_CODING_AGENT_DIR`. `ackMs` is a round trip: a v5 daemon acks the
  downlink within `flushMs` (an ack-only frame if need be) and the hub's ack rides the downlink.
  `bun scripts/link-hol-probe.ts` makes the load; `scripts/transport-metrics.ts` prints `link small ackMs` (`clear`
  vs `behind-large`, 64 KiB ahead), `link bytesAhead` and `link dropped` per host and direction (`--session` for one
  session's link samples).
- **Link protocol versions** (spec "Protocol versions and compatibility"). A
  released `LINK_PROTOCOL_VERSION` changes only compatibly: an added optional
  field or a message type receivers skip is fine; a changed type or meaning, or
  a newly required field, needs a new version. Receivers skip unknown message
  types (acking their `seq`) and answer unknown ops 501 `unknown_op`, from v3 on.
  v4 (the WebSocket link) dropped v3 before any release. v5 (pieces) keeps v4;
  v6 (uploads: hub → daemon binary frames, `upload_ack`, `uploadStart`/
  `uploadAbort`/`uploadAttach`) keeps v4 and v5:
  `MIN_LINK_PROTOCOL_VERSION` is 4 and `LINK_PROTOCOL_VERSION` 6 (literal
  one-liners: the deploy script parses them with `sed`); a v4 daemon gets no
  `part`, whole lines and no unacked window (`link.sender.parts`); a v4/v5
  daemon gets 426 for uploads. Main keeps at least N-1, and
  dropping one is an explicit decision (a hello
  outside the range gets close 4426 with `{"serverVersion":N}`, a pre-WebSocket
  daemon's POST gets 426). Once the WebSocket experiments end, the first version
  released after them is a floor: the handshake, version report and an update op
  keep working for every daemon on it or newer, and `MIN_LINK_PROTOCOL_VERSION`
  never goes above it (spec, "Decided: backward compatibility"). Upgrade order: web app
  first, then hosts; a daemon need not support a newer main (a v5 daemon gets
  4426 from a v4 server and exits 1). A daemon dialing a pre-WebSocket server
  keeps redialing with a hint.
- **One socket per host.** A new hello on a new socket of the same token closes
  the old socket 4409 (the old daemon exits 0); two daemons must never run
  competing `omp --resume` children on one agent dir. A frame belongs to the
  socket it arrived on: the hub ignores frames from a socket that is no longer
  the host's link, so no nonce is needed. A revoked host is refused at the
  upgrade (401) and at the hello (close 1000).
- **Transport down is not exited.** While the link is down the omp child keeps
  running on its machine. A wrapper on a host whose `isLinkUp(status)` is false
  is "transport down": no `process_exit`, idle and disconnect timers paused
  until the link returns; frames carry `host_status` for the offline banner;
  sends answer 503 `{hostOffline: true, delivery}`: `"refused"` when nothing
  left (the composer keeps the draft), `"unknown"` when the link dropped after
  the command was sent (it may still run; the composer drops the draft so it
  is never sent twice). A fresh chat adopts the `sessionId` a 503 from
  `/api/agent/new` carries. A child missing from `hello.channels`
  gets a synthesized `process_exit`. Use `isLinkUp` (`host.ts`, client-safe) as
  the one link predicate; do not compare `status === "online"` (an `omp-missing`
  host is linked).
- **A failed op never runs later.** An op that times out (504) or whose
  downlink ends or host goes offline (503, at once, not at the 30 s timeout)
  drops its `req` from the outbox (`failOp` in `hub.ts`), so a delete the user
  saw fail is never applied after a redial. The 30 s op deadline counts silence:
  each binary result frame restarts it, so a large result at a slow ack round
  trip is no 504 (a timeout still drops the `req` as above). `destroyAndWait` returns once the
  session's host is offline (`untilHostDown`); the kill stays queued for the
  link. A wrapper therefore stays in the registry until its child really exits
  (a resume whose handshake failed is registered in the catch for this), so a
  retry awaits its `destroyPromise` instead of spawning a second `--resume`
  child. A reload (`restart`) waits for the old child the same way: if the
  host drops first, it fails `host_offline`, the wrapper answers
  `host_offline` until that child's exit arrives (or `lost` on the next
  hello) and is then destroyed; no replacement spawns beside it.
  `restartAllRpcSessions` (omp update) restarts local sessions only.
  Remote-only transport members (`onResync`, `lost`) are optional on
  `RpcTransport` and duck-typed. There is one module graph, but live objects on
  `globalThis` outlive a `bun --hot` re-evaluation, which may re-create the
  `RemoteRpcTransport` class (not verified); duck typing holds either way, so
  never `instanceof RemoteRpcTransport`.
- **Live-link recycle rule.** A prompt, history-edit or MCP command that times
  out normally recycles the child. On a remote host it does so only if the host
  sent uplink traffic after the command was dispatched (`lastUplinkAt`,
  `linkLostDuring` in `rpc-manager.ts`); a quiet or dropped link answers
  `host_offline` (503), queues no kill and leaves the run to
  `reconcileAfterGap`. A kill through a dead link only waits in the outbox.
- **Orphans and resume.** On `hello`, listed channels with no wrapper are children
  of a previous server run: they are adopted (see "Local daemon"), and killed
  (`kill`, escalating to force after 5 s, registered until their `exit`) only when
  adoption is impossible. A cold spawn for a session
  awaits `orphanExit(hostId, sessionId)` first so two children never write one
  file; the wait rejects 503 as soon as the link goes down. A buffer overflow on
  the daemon (32 MB per channel, two image-prompt echoes) drops the channel's
  backlog and sends `resync {ch}`; main's `RpcProcess` discards any partial
  chunked frame, skips leftover chunks until the next frame start, and reruns
  the `get_state` reconcile. With `autoResumeSessions` on, an interrupted
  session resumes after its host's hello (`resumeOnHostLink`,
  `lib/session-resume.ts`), once, after the orphan's exit.
- **Proxy exclusion.** The `proxy.ts` gate lets exactly `/api/hosts/link` through
  (the `UNGATED` pattern names that path, no subpaths): the daemon has no
  session cookie, so it authenticates with its bearer token instead. The hub
  verifies the `Authorization: Bearer <host token>` header before the upgrade
  (401 unknown token, 503 unreadable `hosts.json` or frozen server). Keep
  `/api/hosts` itself behind the proxy.
- **Remote paths never reach `allowFileRoot`** or any other main-side
  filesystem check: they mean nothing on main. `startNewRpcSession` calls
  `allowFileRoot` and the local session-list invalidation only for the local
  host; remote cwd validation is the host's `validateCwd` op. Daemon input is
  untrusted: blob hashes must match `^[0-9a-f]{64}$`, results are shape-checked
  in `hub.ts`, and `sessionFileExists`/`spawn` accept only paths under the
  daemon's sessions directory. A remote session export is always served as an
  attachment: inline, its HTML would run on main's origin.
- **Daemon-loaded modules must not import `@/` or use Bun APIs.** `bin/omp-web-host.js`
  loads `lib/hosts/daemon.ts` through plain `jiti` on the Node runtime, which does
  not resolve the `@/` alias and has no `Bun` global (the tray modules likewise). That covers everything the daemon pulls in
  (`daemon.ts`, `link-protocol.ts`, `local-host.ts`, `session-ops.ts`,
  `host.ts`, and their `lib/` imports). Use relative imports there.
- **Registry.** `<agent dir>/omp-web/hosts.json` (0600, atomic write) stores
  only `sha256(token)`; the token is shown once. Mutations use the strict
  reader and throw `HostRegistryUnreadableError` (503) instead of rewriting a
  file they could not parse. Revoke deletes the record first, then closes the
  link (the daemon sees 401 and stops its children). The `hosts` event channel
  carries the `GET /api/hosts` body. A missing `hosts.json` (an agent-dir
  mismatch, say) answers 401 to every daemon, and a daemon told its token is
  unknown stops all its omp children: check `PI_CODING_AGENT_DIR` before
  starting main.
- **Agent tools.** Calls carry the caller's host (`sourceHostId`);
  `new_session`'s `host` defaults to it. A host with `allowAgentStart` off asks
  a server-owned `confirm` through the normal extension-UI path
  (`confirmFromServer`). Local callers never ask for this machine. A remote
  caller asks before any other host unless that host allows agent starts, and
  always before this machine, for `new_session` and `send_to_session` alike.
- **Workspace operations are daemon-owned** (`lib/workspace-types.ts`,
  `lib/hosts/workspace-ops.ts`; design `docs/specs/2026-11-03-remote-workspaces-design.md`).
  Files/index/shell output/watch, Git/worktrees, browsing/default cwd and clone
  APIs use `Host.workspaceOps` for every host, including local. Optional hello
  capabilities gate old daemons; unavailable operations never fall back to main.
  File tabs retain host/cwd/session ownership. Upload publication extends the
  existing staged 2 GiB uploader; its workspace receipts are not session attachments.
- **Not yet remote:** Skills/Plugins/Agents/MCP settings and session archiving.
  Archive remains 501 `remote_unavailable` with its menu item disabled; transcript
  search and the archive browser still read this machine's files.

#### Local daemon (`docs/specs/2026-10-29-local-daemon-design.md`)
- **Two services.** `ompweb` (web) and the daemon (`ompweb host`, `bin/omp-web-host.js`)
  run side by side; this fork has no service installer, so the daemon is kept running
  explicitly — foreground in a terminal (`ompweb host`), or supervised by the deploy
  tooling (`ompweb-rebuild-restart.sh` starts it beside the web server and its reaper
  sweeps orphaned daemons). The daemon owns this machine's omp children, so a web
  restart, update or redeploy leaves runs going; restarting the daemon ends them
  (auto-resume then resumes the sessions that were running). An upgrade restarts the
  daemon only when the running daemon's link version is outside the new release's
  `[MIN_LINK_PROTOCOL_VERSION, LINK_PROTOCOL_VERSION]` range (it would get 426 and
  exit); a daemon inside the range keeps running.
- **Local link bootstrap** (`lib/hosts/local-bootstrap.ts`, called from `instrumentation.node.ts` on production boot only). `localLinkUrl()` builds the daemon's URL from `OMP_WEB_PORT`/`OMP_WEB_HOSTNAME` (set by `startProduction` from its listen address, so the launcher, the binary and `npm start` all link; wildcard binds map to `127.0.0.1`, a non-loopback bind gets no link and a console warning). `ensureLocalHostLink()` makes sure the `local` record exists (`registry.ts`, `rotateLocalHostToken`) and writes `<agent dir>/omp-web/host.json` (`{url, token}`, 0600). A `host.json` whose token the registry still accepts and whose url matches is left alone, so a web restart does not make the daemon redial. It throws, and startup only logs, when `host.json` points to a non-loopback server (a remote-host login on this machine): it is never overwritten. The daemon re-reads `host.json` when its link gets 401 and exits only if the file still holds the rejected token.
- **Dev mode does not take the daemon.** With `NODE_ENV=development` `ensureLocalHostLink` is skipped, so the daemon stays linked to production and the dev server shows "This machine" offline. The local row of `GET /api/hosts` carries `daemonManaged: false` there, which hides the offline banner.
- **`local` is a registry record like any host**, with three exceptions: it is listed first, `PATCH` takes `label` only (`allowAgentStart` is fixed), and it cannot be revoked. Renaming "This machine" is a `PATCH /api/hosts {id: "local", label}`; an empty label resets it (`registry.ts` stores `""`; `customLocalLabel()` / `DEFAULT_LOCAL_LABEL` map it). `getHost("local")` works without the record: it is the daemon link, offline while none is linked, and "needs upgrade" on a protocol mismatch (`hostVersion` in the row is the daemon's).
- **Adoption on hello** (`reattach`/`adopt` in `hub.ts`, `adoptRpcSession` in `rpc-manager.ts`). Each listed `{ch, sessionId, cwd, pending}` channel that has no transport on this server is a child of a previous server and is taken over by a new `AgentSessionWrapper` (`adopted: true`, `RpcProcess` option `adopted`). There is no session-list lookup: the spawn `cwd` comes from the hello, and the session identity from the child's own `get_state` (`applyIdentity`), so a new session whose file is not written yet is adoptable. The daemon names each child's current session in the hello (`PendingRequests.sessionId`: the file's header id at spawn, then the last successful `get_state`). Re-sync (`AgentSessionWrapper.adopt`): `negotiate_protocol`, `set_subagent_subscription`, `set_ask_dialog`, `set_event_filter` (delta message updates, see "Streaming message updates"), `get_state`, `get_subagents`, `get_btw_history`, then `replay` of the `pending` lines and `release` of the frames held meanwhile. Every command is bounded by `GET_STATE_TIMEOUT_MS`.
- **The daemon replays open blocking requests** (`pending-requests.ts`): `host_tool_call`, `host_uri_request` and blocking `extension_ui_request` lines, until answered or cancelled, capped at `LINK_LIMITS.pendingBytes` per channel. An adopted wrapper feeds them through `handleFrame` (`replaying`; agent tools are not re-run), so dialogs reappear and browser tool calls wait for the next tab (`hostToolsUnknown`, `parkHostTool`). A request opened while the old server stopped is also resent unacked: `RpcProcess.release` skips held requests the replay already delivered, so it is handled once. The hello also carries `autoApproveExtension`, which an adopted run has no spawn result for.
- **A child is killed only when it cannot be adopted:** its hello entry has no session id or lost its `pending` lines to the cap (`killOrphan`), or a re-sync command times out or the child exits, its held output overflows, or its real session (after `get_state`) is already started on this server (`adoptRpcSession` kills it: its wrapper's dispose). Auto-resume (`resumeOnHostLink`) first awaits `adoptedChild()` and resumes a session only if it was not adopted.
- **Shutdown freezes the links and never kills daemon children.** The `cleanup` in `rpc-manager.ts` runs `markShuttingDown()` and `freezeHostLinks()`: link sockets are closed 1001 and from then on a link neither sends nor applies anything (no kill, no rejection of open host tool calls as tabs close); new upgrades get 503 "omp-web is shutting down". A real SIGTERM exits in the same tick (`process.exit` in `instrumentation.node.ts`), before Bun writes the close frame, so daemons usually see 1006 or ECONNREFUSED rather than 1001 and redial the same way. The daemon keeps the output unacked and redials for the next server. An adoption that fails after the freeze leaves its child to the next server instead of killing it.
- **Local daemon banner** (`components/LocalDaemonBanner.tsx`). In production, when the local row stays offline with `hostVersion === null` (no daemon has linked since this server started) for 90 s of a page view (well past the daemon's redial wait, at most 3 s on loopback, so a restarting daemon does not trip it), it shows the foreground `ompweb host` command to keep the daemon running in another terminal (Settings → Hosts shows it, and the copyable `npx @kahme247/ompweb@latest host` form, for an offline local row). Dismissal is kept in `localStorage`. Main never installs services or starts the daemon itself.
- **No direct local path.** `local-host.ts` is the daemon's; `lib/hosts/no-direct-local.test.mjs` fails when anything outside its allow-list spawns omp or imports it. The utility omp (`rpc-utility.ts`, login) is the one deliberate exception: it is not a session.

#### Windows source-run deploy (`ompweb.ps1`)
- **One entry point.** `ompweb.ps1 start|stop|restart|rebuild|status|logs` (verbs are positional,
  only `-All` and `-DryRun` exist). `start` is idempotent: a role already supervised is left
  alone, so double-clicking the launcher twice cannot produce two servers fighting for the port
  or a second daemon. A double-click launcher is a two-line `.cmd` that calls `ompweb.ps1 start`.
- **The checkout is the install dir.** `node bin\omp-web.js` (`bin/bun-runtime.js` resolves
  `node_modules\bun\bin\bun.exe`) runs `server/main.ts` against `dist/`, so a deploy is
  `rebuild` -- build the client bundle, record what must be served, stop the instance; the
  supervisor relaunches it from the same checkout (~4 s of downtime, ~1 s incremental build).
- **The supervisor is the reaper.** `ompweb.ps1 supervise server|host` (what `start` launches)
  keeps its process running, 3 s between restarts -- the job `entrypoint.sh`'s loops do in the
  container. Because it is the *parent*, `taskkill /T /F` on the instance never reaches it, so no
  detached watchdog is needed (`Win32_Process.Create` would be the Windows analogue of `setsid`,
  but it needs elevation). The supervisors' command lines carry the `supervise` verb, which is
  what keeps them out of every kill list.
- **Post-restart verification lives in the server supervisor.** `rebuild` writes the fresh entry
  chunk to `<agent dir>\ompweb-rebuild\pending-asset.txt`; after the respawn the supervisor polls
  `/login` (gate-exempt, serves the same `index.html`) and logs `OK:`/`FAILED:` -- the marker is
  single-use, so an unrelated restart never re-verifies an old build. Logs: `run-server.log`,
  `run-host.log`, `rebuild.log`; `status` prints who runs what and which bundle is served.
- **A server bounce leaves the daemon alone** (the daemon redials, omp children survive); only
  `-All` stops it, because that ends every agent session it owns. Stopping is scoped to the
  process listening on the port plus its launcher/Bun-child pair, so a second ompweb on the
  machine is never touched; `rebuild -DryRun` prints the targets and builds nothing.
- **Elevation is part of the process model.** An instance started from an ELEVATED shell is
  invisible to a normal one except as a bare pid: `Get-CimInstance Win32_Process` reads no command
  line for it, `taskkill`/`Stop-Process` answer Access denied, and neither its supervisor nor its
  children can be listed (so the roles read "not running" while the port is served). Because
  taskkill's exit code cannot tell "already gone" from "refused" (both surface as a nonzero),
  `Stop-Instance` proves the kill against the listening port and logs `FAILED: port … still held
  by pid …` + exit 1 rather than announcing a hand-off; `status` names the elevation instead of
  guessing "started by hand". Bouncing an elevated instance needs an elevated `ompweb.ps1`.
- **A bounce must always leave a relauncher behind.** `Restart-Instance` ensures a server
  supervisor exists: after the kill for a normal caller, and BEFORE it when the caller runs
  inside the instance (`Test-InsideInstance` — the seeded "OmpWeb Rebuild & Restart" task is a
  child of the web server), where the relauncher is started through `Win32_Process.Create` so it
  sits outside the killed tree. A supervisor launched afterwards from inside would die with the
  tree and leave the port empty forever. `rebuild`/`restart` on a stopped stack now bring it up
  instead of exiting; a port held by a non-ompweb process is reported and never supervised.
- **Machine settings live in `ompweb.local.ps1`** (git-ignored; see `ompweb.local.example.ps1`):
  port, bind, `OMP_WEB_PASSWORD_HASH`, `OMP_WEB_ALLOWED_HOSTS`, `NODE_EXTRA_CA_CERTS`, and
  prepending `C:\Program Files\Git\bin` so an explicitly invoked `bash` is Git bash rather than
  the `System32` WSL launcher.
- **Windows PowerShell 5.1 reads these files as ANSI**, so keep them ASCII-only. Other 5.1 traps
  paid for here: `$MyInvocation.MyCommand.Path` is empty during parameter binding (use
  `$PSScriptRoot`), `Start-Process -PassThru` yields `.Id` not `.ProcessId`, `$pid` is read-only,
  `Start-Process -ArgumentList` must not wrap to the next line, and `taskkill`'s localized output
  is console-codepage text -- discard it and log `$LASTEXITCODE`.
- The container flow (`entrypoint.sh` + `ompweb-rebuild-restart.sh`) is unchanged and does not run
  on Windows: it needs `python3`, `setsid`, a `/proc` tree walk and an `/opt/ompweb` deploy target.
- **And not a bash runner either** (tried and retired): under Git bash a child's `$!` is an
  MSYS job id, not its Win32 pid, `ps` lists only the current session, `wmic` (the only
  bash-reachable pid+command-line source) is deprecated, `tasklist`/`wmic` speak UTF-16,
  `netstat`/`taskkill` output is localized, `mawk` has no `\b`, and MSYS rewrites `/PID` into
  `C:/Program Files/Git/PID` in a child shell but not the parent one. `Get-CimInstance
  Win32_Process` answers the same question natively, which is what the supervisors' kill lists
  are built from.

### Session moves (omp >= 18.5 ownership) and title generation
- Only the first omp process to write a session file owns it; a non-owner moves
  to a sibling file with a new id on its first write and emits a
  `notice` with `source: "session-persistence"`. `handleFrame` answers it with
  `followSessionMove()`: the pending flag makes the next `applyIdentity` treat
  the id change as the same conversation (stream/run state kept, **old id kept
  as a registry alias**, new id registered via `onIdentityChange({keepOldId})`).
  Branch/new/switch drop every key the wrapper had (aliases included), since it
  now serves another conversation — a move is the only implicit re-key.
  `startRpcSession` also reuses any live wrapper reporting the requested session
  file instead of spawning a second `--resume` child (which would fork again).
  A move during startup (before the first `get_state`) is aliased too, so the
  requested id stays routable.
  `onDestroy` removes every key that points at the wrapper.
- **Pre-spawn holder gate** (`releaseStaleSessionHolders` in `lib/rpc-manager.ts`,
  finder/classifier in `lib/session-watcher.ts`): a second live process resuming an
  owned file can never take it over — its first write forks the session into a sibling
  file, which move-following can only honor as a fork (observed as a fork-per-prompt
  storm after restarts that left the previous instance's `omp` children alive under
  orphaned `ompweb-host` daemons). So before any resume spawn, live holders of the
  file are found by **open fd as well as by the `--resume` cmdline** (a holder that
  already moved at runtime keeps the *current* file's fd while its cmdline names the
  pre-move path — the old cmdline-only scan was blind to exactly that, and so was the
  external-holder badge), leaked children of orphaned daemons (parent `ompweb-host`
  reparented to init) are SIGTERMed **together with their daemon** and awaited, and
  holders that must not be stopped (live terminal run, another live instance) reject
  the spawn with `session_held_external` / `session_held_stuck` instead of forking.
  `ompweb-rebuild-restart.sh`'s reaper sweeps orphaned daemons too; the queue lives
  inside the owning process, which is why prompts that land on a *different* fresh
  process can never queue — they fork.
- `POST /api/sessions/[id]/auto-name` asks omp to generate the title
  (`AgentSessionWrapper.generateTitle()`: native `generate_title`, else
  argument-less `/rename`, never while a run is in flight). Only when omp cannot
  does it fall back to the stored/derived title (`generated:false`), saved
  through the live process when there is one. A run in flight is NOT a silent
  fallback: the endpoint answers `409 session_busy`, and the top-bar wand
  disables while the session is busy — ChatWindow mirrors `sessionBusy` up
  through the `onBusyChange` prop, and the button gates with
  `aria-disabled` + a click guard (NEVER the native `disabled`, which
  swallows pointer events and would make the explanatory tooltip
  unreachable on hover).
- The web-initiated argument-less `/rename` is a **prompt run**, so its echo
  (`command_output`: the success line or "Could not generate a session title…")
  would land in the chat as a transient row. `generateTitle()` therefore arms
  `renameOutputPending` around the run and `handleFrame` swallows that single
  `command_output` (same precedent as the `/mcp list` waiter); the failure text
  also settles the title poll immediately instead of burning the 20 s timeout.
  An unchanged title means failure — `generateTitle` returns `null`, never the
  PREVIOUS title (omp ≤ 18.8.7 has no `generate_title` RPC; `/rename` is the
  only path and fails outright when the title call's model answers with
  reasoning-only content, e.g. `disableReasoning` ignored server-side).

### Resume fail-closed model restore (omp ≥ 18.6.3) — `lib/session-model-check.ts`, `ModelRestoreDialog` in `components/ChatWindow.tsx`
- omp ≥ 18.6.3 refuses to resume a session whose saved model cannot be
  restored (`Could not restore model <provider/id>`), and ≥ 18.7.0 fails
  `--resume <path>` closed on a missing file (`Session "<path>" not found.`)
  instead of silently continuing on the default model or creating a session.
- **Pre-flight** (`checkSavedSessionModel`, run by `startRpcSession` before
  every resume spawn): reads the last *default-role* `model_change` entry from
  the session file (bounded tail scan; `role:"title"`/`subagent:*` entries
  name OTHER models and must never shadow the default) and checks it against
  the same availability list the composer picker uses (utility RPC
  `get_available_models`, 60 s snapshot, minus disabled providers). A miss is
  a `WebRpcError` `session_model_unavailable` with `data.model` — never a
  dead child. `invalidateModelAvailability()` must run whenever credentials
  change (wired into the logout route; login's own models-cache sweep
  bounds the staleness to the TTL). The pre-flight is the primary detector;
  the daemon additionally classifies a child's startup stderr as the backstop
  (`classifyStartupFailure`). A failed
  availability read SKIPS the check (never blocks a start on a guess).
- **Recovery UX**: `POST /api/agent/[id]` accepts a web-only `startup` field
  (`{modelOverride}` or `{forceModelCheck}` — stripped before the command
  reaches omp, validated by `parseSessionStartupBinding`). The hook keeps the
  failure (`modelRestoreFailure`) from the `session_model_unavailable` code,
  `sendPrompt` returns the draft to the composer, and the dialog resumes the
  session bound to the picked model. `--model` only binds the LIVE run — the
  handler must follow with `set_model` so omp records a `model_change` entry;
  without that persist every later cold start re-asks (verified in E2E).
  The binding is stored on the wrapper (`startupModelOverride`) so `restart()`
  never falls back onto the unrestorable saved model.
- **Rename auto-rebind**: a saved model whose provider is gone but whose
  model id exists under exactly ONE live provider (`resolveUniqueRename`) is
  a rename, not a loss: `checkSavedSessionModel` returns `rebind` and
  `startRpcSession` spawns bound to the replacement (`--model`) and persists
  it with `set_model` right after ready — the same permanence as the dialog,
  with no dialog. Ambiguous or missing ids keep the explicit `unavailable`
  error and the dialog.
- **Model-switch repair**: a `set_model` command doubles as the spawn
  binding when the client sent no `startup` field
  (`modelSwitchRepairBinding` in the agent route) — switching the model of a
  session with an unrestorable saved model applies the pick instead of
  failing on the model the user just replaced.
- **Missing-file retry**: a `missing` classification (the file moved/was
  archived between the route's resolve and the spawn) re-resolves the id
  once and retries against the current path, then fails with
  `session_file_missing` (localized in all three locales;
  `session_model_unavailable` deliberately is not — its message carries the
  dynamic model id, and the dialog localizes itself).

### Editing and branching — don't confuse them
- **Fork** ("Fork a new session from this point" button, `messageView.newSessionTitle`, on user and assistant messages; only offered while the session is idle — ChatWindow gates it on `!sessionBusy && !isNew`): creates a new independent `.jsonl` file via omp's `branch` RPC. Shown as a child in the sidebar tree via `parentSession` header field. `branch` only takes a user entry and keeps the history *before* it, so `lib/chat-fork.ts` maps rows: a user prompt forks at itself and its returned text prefills the fork's composer (edit-and-resend, text only — attached images are not restored); an assistant reply forks at the next user prompt so the reply is kept; the newest reply falls back to its own prompt with the prefill. Rows that would edit the very first prompt (an empty fork) offer no fork.
  The button only opens a `ConfirmDialog` (`ForkSessionButton`); `onFork` runs on confirm, so a stray tap while scrolling never forks.
- **Edit** (`edit_message`, user-message button): moves the live conversation's history to before that user entry; it is not a read-only historical view or an explicit Fork. `lib/omp/session-edit-extension.mjs`, explicitly loaded on spawn/restart, calls omp's public `ctx.navigateTree(entryId, { summarize: false })` and appends a non-message `omp-web-history-navigation` entry. Node never imports the Bun-only SDK or rewrites the JSONL.
  - The button only opens a `ConfirmDialog` in `UserMessageView`; `onEdit` runs on confirm, so a stray tap never rewinds the live session.
  - Require authoritative `get_state.isSettled === true` and reject pending background work; runtimes without settlement reporting fail explicitly. Preserve run/edit fencing, including rename and automatic-title fallbacks, and do not report success after an observed edit-time native persistence error.
  - `SessionEditResult` remains `{ sessionId: string, cancelled: boolean, leafId: string | null }`. The returned ID identifies the confirmed post-edit conversation. Single-owner Edit keeps ID/file; a non-owner's native copy-on-write relocation is expected. Server persistence notices feed `applyIdentity` and registry aliases; the HTTP result drives client identity adoption (there is no public identity-change frame). Reload the confirmed target before text prefill, reject unrelated switches, and preserve the original file and old branches.
  - The private `/omp-web-edit` transport uses `prompt`, so installed input hooks must pass the internal command through unchanged. OMP v18.12.6 invokes input hooks before command dispatch; registration checks alone do not bypass them. A temporary-hook probe confirmed consumption can intercept the command without an agent run. No input-handler registrations were found in the 20 official hook/extension TypeScript examples examined, and the official RPC fixture matches `consume:`, `transform:` and `slow:` rather than slash commands. Conflict probability is unmeasured and no known shipped third-party conflict is established. This is an explicit compatibility boundary, not a promise of arbitrary plugin support or a requirement for universal hook-free upstream RPC.
  - Preserve ordinary native storage/error semantics: appends commonly reach the OS page cache synchronously, persistence failures latch and emit `source: "session-persistence"`, `level: "error"` notices, and native `flush()` throws latched errors. An append returning alone does not prove error-free persistence; surface observed edit-time write failures rather than claim success. Edit does not introduce a stronger fsync guarantee or require a new global durability API.
  - A native `prompt` acknowledgement may have no data; only the request-correlated extension result confirms Edit. An observed persistence-error notice is not handler completion: keep the operation fence until the handler completes, or await child teardown on uncertain completion before unlocking. If an input hook invokes an agent, an observed run must retain run ownership; an acknowledged but not-yet-started agent cannot leave an unfenced startup gap and requires awaited teardown.
  - Prefill only the selected message's text, not its original images. Preserve existing drafts, newer typing and composer attachments through pending edits, cancellation, errors and genuine navigation. `submissionBlocked` keeps asynchronous dictation from submitting or clearing the composer without disabling recording pause/resume/discard. `session_history_changed` carries the leaf marker; the initiating tab deduplicates its own delayed echo without resetting a newer view or run. Editing does not undo filesystem/tool side effects.
  - Legal identity moves keep the hook and composer mounted. Transfer drafts capacity-neutrally and carry the exact source snapshot so input completed in the same React batch is merged, not overwritten or duplicated. Pending attachment reads, recordings and recovery operations retain their owner across the move; genuine navigation remains isolated. Draft text survives full-page reload via sessionStorage; attachment payloads remain memory-only.
  - The confirmed-move callback synchronously calls `ChatInputHandle.retargetPendingRecovery(from, to)` before state updates or parent callbacks. This advances only captured queue-recovery ownership, closing the acknowledgement-to-commit gap; layout hydration still owns the live composer key/state. Do not turn this pre-commit ownership handoff into eager draft hydration.
  - Pending transcription keeps its original server scope/job/claim ownership. Confirmed moves record a tab-local recovery association so the target can rediscover that job after navigation/remount; other clients' drafts and server scopes are not migrated. A hard reload before an upload acknowledgement can leave multiple possible source jobs; retain recovery and report ambiguity rather than guess or reupload.
  - Event connections own their readiness waits: replacement and unmount settle the old wait as closed, clear its timers/coalesced work and close its observer. Late continuations must not attach streams to an unmounted hook or let a stale connection authorize a new operation. Keep lifetime cleanup separate from the mount-load latch so StrictMode setup/cleanup replay still cleans up observers attached afterward.
  A new chat's first prompt is the exception to "abandoned readiness": when its chat unmounts while omp spawns, `handleSend` still sends the prompt, opens no observer, skips host-tool/roster setup and returns `accepted`. An existing session's messages need no exception: they go through the message outbox (below), which delivers them with no tab involved.
  Ordinary `ChatInput.onSend` returns `Promise<PromptSubmissionResult>` (`accepted` / `rejected` / `superseded`). With `outbox` (an existing session) the composer clears only once `onSend` (or `onSteer`/`onFollowUp`) reports the message stored in the browser's outbox, and only if it still holds what was sent; a refusal leaves it in place. For a new chat only rejection restores composed text/file contents and images through `recoverDraft`; its receipt supplies the promoted real-session draft key when the new chat became a session, otherwise the composer uses the originating key captured before submission. Superseded failures must not reinsert a processed turn or reset a newer run. The composer owns recovery; `useAgentSession.handleSend` must not separately insert failed-send text and duplicate it.
- **In-session branch** (Continue button / BranchNavigator): reads a historical view of the entry tree within the same file; it does not change the live agent's context. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=` through `handleLeafChange`; never use that read-only path to implement Edit.

### Session title cards (`lib/title-card.ts`, `components/TitleCardBadge.tsx`)
- omp >= 18.8.1: generated and `/rename`d session titles may carry a card —
  `<icon> <CODE>: <title>` (e.g. `🧪 FLAKY: Fix flaky park tests`). The card is part
  of the title string stored in the session file; every title reader receives it
  unchanged. `parseTitleCard` mirrors upstream exactly (`CARD_LINE`
  `^(\S+) ([A-Z0-9]{1,6}): (\S.*)$` + the icon must be 1-8 non-ASCII code points),
  so a plain title is NEVER split apart — anything else parses to `null`.
- `TitleCardBadge` renders the icon glyph + the code as a monospace chip from the
  shared design tokens; rows and the chat-header breadcrumb render
  `parseTitleCard(name).title` (card stripped) next to it. The stored title is
  never rewritten (`formatTitleCard` exists only for rename round-trips).
- Surfaces: sidebar session rows + project/session tree (`SessionItem`, now
  exported for row-level tests and the SSR harness) and the chat top-bar
  breadcrumb (`AppShell`).

### Auto-generated titles at session start (web setting `autoGenerateSessionTitles`)
- Two triggers, one setting. **Mid-run (TUI parity):** the TUI names a new
  session the moment its first assistant reply starts, but omp wires that
  generator only for the interactive terminal — an `omp --mode rpc-ui` child
  never runs it, and no released omp (through 18.16.0) has a title-generation
  RPC (`set_session_name {name}` is the apply command; it hardcodes source
  `"user"`, which only blocks native auto-over-user, so the wand can still
  regenerate an early web title). So when the FIRST real agent run of a
  brand-new session is dispatched, `AgentSessionWrapper.maybeAutoTitleDuringFirstRun()`
  generates the name from the opening message through `lib/omp/title-generator.ts`
  (a faithful mirror of omp's gates and parser, verified against the 18.16.0
  binary: low-signal/weak-pointer opener gates, the `<user>`-wrapped prompt,
  the tiny→commit→smol role chain plus the session model per `title.generator`,
  the `Ee`→`z`→`$$` response parse) and applies it mid-run with
  `set_session_name` — exactly what the TUI's own generator does at that
  instant. The completions run through the shared `omp auth-gateway stdio`
  child (`/v1/chat/completions`, `@tiny`/`@commit`/`@smol` resolved by omp),
  so LOCAL-HOST sessions only — a remote session's title stays with the
  generator on its own machine. One shot per wrapper (`earlyAutoTitleTried`);
  early titles are PLAIN (the `🧪 CODE:` cards are applied only by native
  rename paths).
- **Settle fallback (unchanged):** when the FIRST settled run of a brand-new
  session still leaves it untitled (the `conversation_completed` signal —
  `prompt_result` settled or the deferred `session_settled`),
  `AgentSessionWrapper.maybeAutoTitleOnStart()` fires omp's quiet
  `/rename` generator; omp declines low-signal openers, so a later
  settled turn retries up to `AUTO_TITLE_MAX_ATTEMPTS`. Both triggers are
  brand-new sessions only (`recordedCwd === null` — resumed sessions keep
  their saved names) and only while no title exists; the shared
  `autoTitleInFlight` fence means the settle path never races the in-flight
  mid-run attempt — when the mid-run attempt yields nothing, its `finally`
  hands naming back to the settle path. A title that arrived elsewhere
  (terminal, wand) always outranks the mid-run result (re-checked before
  applying).
- Toggle: Settings → Interface & Behavior (Session & Agent Behavior) →
  "Auto-generate session titles" — **default OFF**, a deliberate opt-in; the
  fallback first-message naming and the top-bar wand work regardless.
  Persisted with the other server settings via `/api/web-settings`
  (`autoGenerateSessionTitles` in `~/.omp/agent/omp-web-settings.json`).
- Wand gating invariants (pinned by `AppShell.test.mjs`): "anything to name"
  counts ANY committed turn — stats only count when their `sessionId` matches
  the selected session (leaked stats from the previous one armed the wand of a
  conversation-less session), and USER messages alone are NOT the gate: the
  post-compaction window can hold no user turn, which disabled the wand after
  every compaction with a misleading "Send a message before naming…" tooltip.
  `selectedSessionBusy` is push-only — never reset it on session-id change:
  starting a new session does NOT remount the ChatWindow, so its busy push is
  never repeated and a blind reset left the wand enabled for the whole first
  run. A run the CLIENT did not start (auto-title, deferred continuation) is
  invisible to the idle page until the hook's post-run `/state` probe (~2.5 s
  after each client run ends) re-asserts the running state.

### ToolCall field normalization
Sessions store toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called in both `session-reader.ts` (file load) and streaming event handling.

### Live tool execution (`tool_execution_start/update/end`)
omp announces a tool the moment it starts, streams the tool's output while it
runs, and only commits the `toolResult` message at the end. The UI must not
wait for that commit:
- `useAgentSession` keeps a `liveToolResults` map keyed by `toolCallId`
  (seeded on `tool_execution_start` with `partial: true`, refreshed on
  `tool_execution_update` — omp sends the FULL accumulated partial result per
  chunk, latest wins — and released on `_end`/the committed toolResult).
  Committed results always win over live entries (`ChatWindow` merges them), so
  a reload never shows a stale snapshot.
- `ToolCallBlock` renders a `partial` result as **running** (spinner, and
  "Running tool…" instead of the "(no output)" marker when nothing has been
  printed yet), and opens the row while it runs when the "Keep tool calls
  collapsed" setting is off — that is what that setting means. `AppShell` must
  pass `toolCallsDefaultCollapsed` into `ChatWindow`; without it the setting is
  inert (the chat then always collapses).
- Two more UI switches shape the fold, both planned in
  `planTurnSegments` (`lib/chat-segments.ts`): `showThinking`
  (driven by the Thinking Blocks mode "expanded") and `showToolCalls` ("Show
  tool calls outside Process details", `omp-web:show-tool-calls-unfolded`)
  treat those blocks like text, so they never fold. A text segment can
  therefore carry thinking, and `ChatWindow` passes its `sourceBlockIndices`
  so deferred thinking loads the right block. "Never fold tool activity"
  (`omp-web:never-fold-activity`, `buildChatGroups` option `neverFold`) makes
  every message its own group, so the virtual window pages per message and no
  turn ever builds a Process details row; it overrides "Hide tool activity
  while working".
- `tool_execution_update` is coalesced per tool call at display rate in
  `lib/message-update-coalescer.ts` (chatty commands emit ~10-100+ frames/s),
  like `message_update` (which carries omp deltas, see "Streaming message
  updates").
  `message_end` drops the pending `message_update` (the committed message
  supersedes it) but must NOT drop buffered tool updates.
- The same fold runs SERVER-SIDE in `rpc-manager.ts` (`frameCoalescer`, the
  shared `lib/message-update-coalescer.ts`): `emit` pushes every frame
  through it, so subscribers — SSE and internal alike — receive at most one
  `message_update` / `tool_execution_update` per display window (~20/s
  instead of 100+). The wrapper folds omp's deltas into whole messages
  before the fold (see "Streaming message updates (omp deltas)"), and the
  shared coalescer dispatches the rebuilt whole — every subscriber, server
  or browser, only ever sees whole messages, which is what makes the
  latest-wins fold legal with delta mode on. Order is unchanged (any other
  frame flushes the fold first); `restart` and `destroyAndWait` reset it.
- Live entries are cleared on `agent_start`, terminal `agent_end`, prompt
  send/settlement failure — a tool must never leak into the next run.

### Reasoning display ("Thinking Display Behavior" = Expanded)
- `ThinkingBlock` (`components/MessageView.tsx`) seeds `expanded` from the
  `thinkingDisplayMode` preference ("expanded" always opens; "auto" opens only
  the streaming latest block; "collapsed" never), plumbed and stored like
  `toolCallsDefaultCollapsed`. Manual collapse/expand keeps working per block,
  and a reload remounts from the preference.
- Auto-expanded historical blocks are `deferred` (thinking text is fetched on
  demand), so a mount effect loads their content through the same loader the
  click path uses — one request per mount, cached per (session, entry, block).
- While the mode is "expanded", thinking never folds into **Process details**
  (`planTurnSegments` option `showThinking`): a streamed block mounts
  expanded, and folding it when the step commits would hide it in a closed
  row, which reads as the block collapsing on its own.

### Tool-result images (`lib/media-cache.ts`, `/api/media/[hash]`)
- Tool-result images never reach the browser as base64. History (`deferMedia`)
  and live frames (`AgentSessionWrapper.emit`, which also feeds the replay
  snapshot) replace each image with `{type:"image", mimeType, url:"/api/media/<sha256>"}`.
  User-message and custom-message images stay inline.
- The hash is omp's blob address (sha256 of the bytes): blob refs map directly
  (a missing blob becomes the `[image unavailable …]` text), inline images are
  hashed and copied to `<omp-web dir>/media/`. omp writes blobs in place, so the
  route serves the copy until the blob has the copy's size. A daily sweep (run
  on the next media write) deletes copies omp now holds and files older than
  30 days.
- `ToolCallBlock` shows `?thumb=1` (480px WebP made once with `Bun.Image`, which
  applies EXIF orientation, and cached next to the copies; full image if the
  bytes do not decode) and opens the full
  image in the lightbox. The route serves only PNG/JPEG/GIF/WebP by magic bytes.

### Streaming message updates (omp deltas)
A full `message_update` carries the whole message twice (`message` and
`assistantMessageEvent.partial`), 7-11 KB per frame at several frames per
second. omp >= 18.13.2 sends rebuildable deltas instead, and omp-web uses them
end to end:
- Every session start (spawn, restart, adoption) sends `set_event_filter`
  `{ events: null, messageUpdates: "delta" }`. omp accepts the option since
  18.4.5 and sends rebuildable deltas (with block shells) since 18.13.2; an omp
  that rejects or ignores it keeps full updates, which every consumer below
  still handles (a frame is a delta when its `message` has no `content`). The
  reply is not read: the first delta that does not fit tells.
- `lib/message-delta.ts` is the one reducer, shared by server and browser: a
  `*_start` carries the opened block, `*_delta` appends at `contentIndex`,
  `*_end` carries the final block, `start` restarts from a whole message.
  `toolcall_delta` text accumulates in the block's `partialJson`; the arguments
  are parsed from it only for display and snapshots (`withStreamedArguments`,
  read as omp's `parseStreamingJson` does). It returns null for anything it
  cannot place, and nobody renders a guess. `message_end` stays authoritative
  (omp adds `intent` there; block kinds with no start event arrive only there).
- The wrapper (`rpc-manager.ts`) keeps each open assistant message by
  `messageId` and rebuilds it. Only `message_start` and a rebuilt delta set that
  base: a full update drops it (its tool calls have no streamed JSON, and its
  snapshot can be ahead of the next delta). `getStreamSnapshot()` (HTTP catch-up) carries it
  with `streamingMessageId`, and `onEvent` replays it as one whole
  `message_update` to a tab that attaches mid-message, before any later delta.
- No base (adopted child after a server restart, frames lost on the host link —
  `reconcileAfterGap` drops every base): the delta is not forwarded and the
  wrapper switches omp to full updates until that assistant message ends (or the
  run ends), then back to deltas. A delta that does not fit a message the
  wrapper does have (an omp from 18.4.5 to 18.13.1 sends no block shells), or a
  `set_event_filter` switch that fails, leaves the session on full updates for
  good; after a failed switch the next lost delta asks for full updates again.
- Backpressure (`event-stream-hub.ts`, SSE and WebSocket sinks): a behind socket
  queues `message_update` frames; consecutive deltas of one block concatenate,
  a whole message replaces the queued updates of its message, and nothing is
  dropped or reordered. Merged frames keep the latest frame's sequence and emit
  time and carry `web.first`, their first piece's sequence. Deltas of different
  blocks never merge past each other: that would break the sequence order.
- Browser (`lib/message-update-coalescer.ts`): applies each delta on arrival and
  dispatches the whole message at display rate, so `useAgentSession` only ever
  sees whole messages. A delta with no base is held and triggers a catch-up; the
  HTTP live snapshot (`seed`) re-bases the coalescer whenever it is applied, and
  otherwise completes held deltas newer than it when it is not older than them.
  At most 1000 deltas are held; past that they are dropped, and only a snapshot
  that covers them takes the deltas held afterwards.
  A snapshot at S already holds delta S, so catch-up drops that frame as stale
  (`useAgentSession-sync.ts`); a merged frame with `web.first <= S < sequence`
  is held for the next snapshot instead of applied. Streamed tool arguments are
  re-parsed for display only after 2 KB more JSON or 100 ms.

### Event protocol differences vs pi
omp emits no `prompt_done` / `prompt_error` events. Completion is `agent_end`
(`isTerminal !== false`), errors surface as failed RPC responses plus `notice`
events. Compaction is announced as `auto_compaction_start`/
`auto_compaction_end`, and (omp >= 18.13.3) additionally
`manual_compaction_start`/`manual_compaction_end` around RPC `compact`,
`/compact` and extension `ctx.compact()` — both wrappers mirror the manual
frames into the `compacting`/`isCompacting` state, but the
`context_compacted` chat-event action still fires once per compaction (the
auto frame, or the `compact` command's success path — never the manual
frames).
New frame types (`turn_start/end`, `notice`, `todo_reminder`, ...) must be
handled or safely ignored.

### Queued messages are omp-owned
The queue panel renders omp's snapshot only: `get_state.queuedMessages` on
load/reconcile/stream open and live `queue_update` frames. Never track chips
client-side — every client viewing the session must show the same queue.
The one exception is what omp does not have yet: the message outbox's held
bubbles (below), never omp's queue.
One sequence (`queueSeqRef`) orders every source: a get_state snapshot takes
a number when requested and applies only if no newer snapshot or
`queue_update` was applied (HTTP and SSE can reorder). Edit/Delete use
`remove_queued_message` (act only on `removed: true`; newer omp also returns
the message's `images`, which Edit restores), Steer uses
`promote_queued_message`; the chip changes when omp's next snapshot arrives.
`handleAbort` coalesces overlapping Stops, then sends `abort_and_restore_queue`:
omp's Esc (`clearQueue({ forInterrupt: true })`, then abort) in one step,
returning the withdrawn user messages, whose texts and images go to the
session draft via `recoverDraft`. omp labels an image-only message `[Image]`;
that label is never restored as text. It covers what a client snapshot
cannot: a steer promoted
after the last `queue_update`, and live-steered input the run claimed but never
recorded (omp would otherwise requeue it and drain it into a new turn right
after the abort). Never reimplement this client-side. A failed request is
retried once (omp returns whatever is still queued) and only while the run
captured at the click is current; texts lost with a response that never
arrived cannot be recovered, so the hook warns (`queueRestoreUncertain`).
Fallback ONLY when omp answers "Unknown command" (omp without the command):
withdraw each listed message with `remove_queued_message` BEFORE sending
`abort` (bounded by `WITHDRAW_BEFORE_ABORT_MS`), saved as each removal
confirms. A follow-up that answers `removed: false` is retried on `steering`
(a concurrent promotion moved it); never the reverse. Every abort is fenced to
the prompt run id captured at the click, so it cannot kill a prompt started
during the wait.

A prompt/steer whose wrapper is running a web shell command (`!` RPC `bash`) is
never rejected: the wrapper degrades the frame into omp's `follow_up` queue and
answers `{queued:true, queue:"followUp", reason:"shellRunning"}`
(`queueWhileShellRunning`); the hook then withdraws the optimistic bubble and
shows `agentSession.queuedWhileShellRunning`. Chips still come only from omp's
snapshot. This applies only with no turn streaming: during a turn, prompts and
steers reach omp unchanged. The default submit-during-run behavior is queue
(`DEFAULT_SUBMIT_DURING_RUN_BEHAVIOR` in `lib/composer-prefs.ts`); only a
stored `omp-web:submit-during-run` choice overrides it.
- A `!cmd` submitted during a run is never queued as text: `sendQueued` hands
  it to `handleSend`, which runs it at once beside the turn, as omp's terminal
  does. omp holds such a result back until a later prompt starts (with omp
  18.15 it was seen landing one prompt later than the next); the wrapper marks the reply
  `deferred`: its `streaming` read by `sendCommand`'s `onReply` as the reply
  is read (omp's own `isStreaming`; after the await, an `agent_end` from the
  same link batch would already have cleared it). The hook shows it from
  `heldBash` (after the transcript) until the transcript has a run of that
  command stamped after the newest omp stamp the tab had seen when the command
  was sent (`newestStampRef`, which only grows, so a history view cannot lower
  it; both omp's clock, so an older run revealed by the pre-compaction view
  never matches; never compare counts, they change with the view). Each
  recorded run settles one held entry (`settledRunsRef`). It then retires it
  for good (compaction or a branch view without it must not bring it back). Never clear it on a client
  event such as sending a prompt: the result may reach the transcript one
  prompt later. Other tabs see it only from then on. Stop (`handleAbort`)
  stops a running turn first, as omp's Esc does; `abort_bash` only when no
  turn runs. An EXTERNALLY held session keeps refusing `!` (the
  externally-running notice, `externalRunningRef` in `executeBash`): a second
  holder would fork the file.

### Skill-invoked first prompt (`customType: "skill-prompt"`)
- When a session is started with a skill mention (`/skill:name …`), omp stores the
  first content entry as a `custom_message` (`customType: "skill-prompt"`,
  `display: true`) containing the full skill body plus the user's original prompt
  in a trailing `"User: <prompt>"` block — **there is no `role:"user"` message
  entry**. The session therefore must not be named after the skill body.
- `MessageView` renders these via `SkillPromptView` (NOT `CustomMessageView`): a
  collapsible "Skill: <name>" badge (expands to the skill body) above a
  user-style bubble showing the `"User: "` trailer. The branch sits AFTER the
  `display === false` check, so a hidden skill-prompt stays hidden.
- Session-list `firstMessage` recovery: `extractSkillPromptUser` in
  `lib/omp/session-files.ts`. Rules: no `"User: "` marker → no first message (NEVER
  fall back to the whole skill body); a leading web-slash-command wrapper line
  (`"Prefix:"` + blank line, e.g. `/goal`'s "Work toward this goal for the rest
  of the session:") is stripped so the session reads as the task itself.
- First-message discovery streams lines when the 4 KiB prefix has none — no
  fixed window cap (`scanFirstUserMessage` in `lib/omp/session-files.ts`). Files past the load ceiling (1 GiB) skip the scan: the
  oversized session stays listed without a first message, and its open route
  answers 413 (`session_file_too_large`) instead of 404.

### "Todo reminder" chat rows are agent nudges, not errors
- `todo-error-reminder` and `mid-run-todo-nudge` custom messages (`display:
  false`) are **model-directed** system-reminders injected by omp: when a `todo`
  tool call fails (e.g. a new turn in a conversation whose previous todos all
  completed — the old tasks no longer exist, so "Task … not found" /
  "Missing list for …"), omp tells the model "todo failed, so todo progress is
  not visible to the user" to force a valid retry (the follow-up `todo init`).
- ompweb surfaces these as collapsed "Todo reminder" pills via `HiddenExtensionView`
  (`friendlyHiddenLabel` in `components/MessageView.tsx`). That display is
  intentional — it is the faithful rendering of the internal nudge, not an
  ompweb error and not a failure of the todo list. Don't "fix" the pill away;
  the composer `TodoList` bar (ComposerPanels) is a different surface.

### Message outbox (`lib/message-outbox.ts`, `lib/event-stream-worker.ts`, `docs/specs/2026-11-04-message-outbox-design.md`)
- **Every message to an existing session is held until acceptance is confirmed**:
  an idle prompt, follow-up or steer (slash commands too; `!cmd` and `/btw`
  retain their own paths). Send ends once browser storage commits. Retain
  unconfirmed outcomes visibly across reconnects, restarts and host outages;
  uncertain host delivery is not independently retried. Native process crashes
  preclude an unconditional exactly-once guarantee. New chats keep their first
  `ensureNewSession` + prompt path (phase 1).
- **Browser leg.** `addToOutbox` (`lib/event-stream.ts`) hands the entry to the
  event-stream worker, which commits it to IndexedDB (`omp-web-outbox`/`entries`)
  and only then answers, so the composer clears only then. Missing IndexedDB
  or a failed transaction rejects the add and preserves the draft. The worker sends `outbox_add` over its current transport
  (a link `cmd`, or POST `/api/agent/[id]` in SSE mode), one entry per session at
  a time, oldest first; 401/408/429/5xx/network retry with backoff (1 s → 30 s,
  at once on a wake), other 4xx mark it failed. Delete its browser copy only
  after a matching successful outbox receipt, not an arbitrary HTTP 200, and
  wait for the IndexedDB transaction to complete. Allocate logical enqueue
  order and insert a unique ID atomically; clock ties and worker restarts must
  not reorder entries or overwrite a held intent. An entry still unsent seven
  days after `createdAt` fails instead (server IDs live eight days); an
  unscoped one fails too. Every sender, Background Sync included, persists
  that failure before moving on, so a stale head never blocks the session's
  later entries. Pagehide
  sends each session's head only (64 KiB total, no incomplete ordering view).
  Background Sync registers `omp-outbox` only after the active service worker
  proves outbox capability; an old push-only worker is not sufficient.
  A transient initial IndexedDB read failure must not latch the SharedWorker
  unusable: later list/add/delete operations retry the existing shared load,
  with one retry attempt shared by concurrent tabs. Persistent failures still
  preserve drafts and stored rows rather than claiming successful storage.
- **Idempotent by id.** `outbox_add`/`outbox_remove` are agent
  commands in `runAgentCommand`, before any wrapper spawn; a repeat of a known
  id answers the stored entry. These and `outbox_scope` are in
  `isIdempotentCommand`, so the link's `(session, rid)` dedupe never remembers
  them and a resync resends them.
- **Scope follows the installation, not the cookie.** The state route's
  `outboxScope` (or `outbox_scope` command) is a nonsecret installation/auth
  fingerprint, cached for offline enqueue. Every browser entry persists it
  unchanged; worker, keepalive and SW sends never rebind an old row.
  Replacement installation/credentials refuse it permanently with
  `outbox_scope_changed`; normal same-owner re-login keeps it. With no cached
  scope, a first-ever offline send must retain its draft until the server can
  identify itself.
- **Server leg.** SQLite and a per-conversation FIFO dispatcher (aliases share
  the same claim) send through the wrapper. Acceptance is bounded by the
  per-alias 16 MiB limit and the global 256 MiB/1,000-active-row pool; overflow
  is retryable 429 while the browser keeps its copy. Never trim accepted rows.
  Storage startup failure remains retryable without a new send or hello;
  successful initialization installs hooks once and shutdown cancels retries.
  Startup recovery fails a same-PID `delivering` row (a reused PID from the
  last run) unless this process holds that claim in memory: an add accepted
  before a delayed startup retry may already be in flight.
  Host offline → `waiting_host`; uncertain replies/child exits while delivering
  → `failed` with `mayHaveBeenSent`, never independently resent. Anything that
  stops an entry before its native write (an error before the claim, omp exiting
  during preparation, attachment copies or a send fence inside `runAgentCommand`)
  leaves it unsent, never marked possibly sent: a gone child is retried after
  `RETRY_MS`, and any other refusal (an attach op's `host_offline` included) is
  classified as not sent (`waiting_host` for an outage). The boundary is
  `nativeWriteStarted(command)`, set by whichever wrapper's
  `sendNativeMessageCommand` begins writing that submitted command object, never
  inferred from one wrapper's generation (a respawned child may write it); test
  fakes record their write in the same `__ompNativeWrites` registry. An
  `outbox_add` for an archived session is accepted and held until it is restored
  (the restore route pumps it); only a session neither listed nor archived is a
  404. Internal `/rename` and `/mcp` prompts stay counted as message
  commands, so an outbox watch never claims an echo they cause. Host tool and URI
  scheme registrations apply in `sendCommand`'s `onReply` (success only), so a
  call omp sends in the same batch as the reply is routed. The session carries
  `outbox_update {entries,settledIds}` (every non-delivered entry plus the latest
  256 delivered/removed ids, retained 8 days) on subscribe and on every
  change, and opens without a wrapper while held entries exist. Observe the
  session-registry lifecycle too: an explicit command can create the ready
  wrapper without another outbox mutation; attach/rebind then announce `connected`.
  Internal handoff observers protect lifetime but do not count as browser tabs
  for host-tool/URI routing or disconnect cleanup. Only the submitted command's
  own reply proves rejection; an older run's session-wide error cannot reject it.
  `GET /api/sessions/[id]/state` carries `outbox`, `outboxSettledIds` and
  `outboxScope` on every answer, an offline host's error included, so a reload
  subscribes to follow them. Upload completion receipts persist privately
  before the completion ACK, so upload ids survive a restart even before
  outbox_add reaches the server.
  Completion replies also carry upload-specific `proof`; browser-held entries
  retain it as `uploadProofs` across re-login. The dispatcher receives accepted
  original-owner receipts out of band, never from client JSON. Private proof
  columns and other schema migrations share one immediate discovery/ALTER
  transaction so concurrent instances cannot race the upgrade.
  Upload authority is revalidated inside the same immediate transaction as
  outbox insertion, after asynchronous lookups. Private completion fingerprints
  bind later preparation to the original file generation. A UUID still referenced
  by a retained outbox entry cannot be repurposed after its canonical upload
  registration is canceled or consumed; cancellation must never substitute bytes.
  Canonical completion records refresh stale main-side caches. Every attachment
  replay still asks the daemon to validate its real file; a missing completed
  file never resumes as replacement bytes under the old proof. Delayed native
  replies retire only their captured completion generation.
  First proof issuance atomically binds matching retained legacy receipts too.
  Original-owner preparation captures that private generation before awaiting
  another command, so a completion replay cannot invalidate unchanged legacy files.
  Consecutive unsent outbox snapshots replace each other in the session
  backpressure queue. Resume and heartbeat do not serialize them while the sink
  is still behind; native events remain ordering fences, with genuine overflow
  handled by the existing resync limits. Never rewrite numbered or partial lines.
- **Held bubbles** (`HeldMessageView`, after the live turn, delivery order:
  server-held entries in arrival order, then this browser's first-leg entries
  in submission order; browser and server `createdAt` are never compared):
  the hook merges the worker's entries (`subscribeOutbox`) with the server's
  snapshot by id; a server confirmation (`{stored}`) bridges until the server
  lists or settles its id (an older empty snapshot cannot hide it); seen and
  settled ids prevent late ACKs from resurrecting delivered entries. States:
  Sending (browser, locked while its first-leg command may be in flight),
  Waiting to send / Waiting for <host> (Delete), Delivering (locked),
  Not sent (Delete). The delivery mode is a read-only label. Delete
  (`deleteHeldMessage`) awaits the IndexedDB delete commit for a browser-held
  entry; a server entry sends `outbox_remove`, refused with 409
  `outbox_dispatched` once delivering. A late commit consumes only the original
  draft's unchanged content and edit generation, including after remount.
  Equal text after newer typing is not unchanged; hydration is not a user edit.
  Active submission ownership lives in the shared draft store, not a composer
  mount. Confirmed identity moves transfer it synchronously before React commits;
  live draft hydration and source-snapshot merging still belong to layout.
  Mark accepted attachment reads as edits before asynchronous completion, not
  only when their chips appear. During pre-commit identity handoff, do not
  recreate the obsolete draft key or consume capacity belonging to other drafts.
- **Run state comes from omp's frames**, never from Send: `agent_start` starts
  the run. The server captures `previousEntryIds` before dispatch and publishes
  it only on the active delivering entry, before omp frames; recovery must use
  this authoritative boundary, not cached/late-fetched history that could
  mistake the previous saved answer for a new response. The boundary is
  cleared after handoff/failure, never kept in tombstones.
  Active replacement inference also requires unambiguous message admission:
  an intervening message command from another origin cannot supply this
  attempt's identical echo. Retain uncertainty instead of guessing ownership.
  A later new idle message may renew an ambiguous child through the existing
  awaited restart lifecycle: require authoritative native settlement, a saved
  session, no active/queued/background work, dialogs, history mutation or unrelated
  pending command, and stable child/admission identity across preparation awaits.
  Recheck before teardown; never infer old acceptance from time or settlement,
  and never replay old uncertain entries. Preserve accepted host-tool and URI
  registrations under current policy before submitting to the replacement child.
  A prompt's bubble leaves when the server sees omp's reply and echo;
  the hook shows omp's echoed user message (`echoedUserMessage`) until the
  transcript catch-up has its saved copy (same timestamp and text), so there is
  no gap. A follow-up or steer becomes omp's queue chip. Stream connections
  opened for held messages (`connectEvents(sid, "connected")`) talk to omp only
  after `connected`, since any command would start a wrapper.
- **Fork port (this repo).** The client half was hand-ported onto the fork's
  monolithic `hooks/useAgentSession.ts`: upstream's module split
  (`use-agent-session/`, `session-sync`) never landed here, so its files
  (`session-sync.*`, `useAgentSession-sync.*`, the boundary-review suites) are
  deliberately absent. Divergences to keep in mind:
  - Two sends bypass the outbox: a **new chat** (its first POST is what mints
    the id an entry would name) and a session with `modelRestoreFailure`
    (the rebind dialog reacts to the direct RPC error; an entry cannot carry
    the startup binding and would only show a flat "Not sent" bubble).
  - `deleteHeldMessage` splits by holder: a browser copy goes through
    `dropFromOutbox` (its promise is the worker's delete commit), a server
    copy posts `outbox_remove`; `sending`/`delivering` refuse either way.
  - The dispatcher's pre-dispatch history boundary is the cheap entry-list
    read (`ContextReadOptions.boundary` in `lib/hosts/session-ops.ts`), not a
    full context build.
  - The session channel's `connected` frame keeps the fork's shape
    (`{type:"connected",sessionId}`), and the hub ends a session subscription
    on `session_destroyed` **or** `process_exit` — the wrapper's early-dispose
    `process_exit` (emitted at the head of `destroyAndWait`) is what feeds
    `onChildExit` in `lib/message-outbox.ts`.
  - `lib/pending-sends.ts` (the fork's earlier tab-local resend shim) is
    deleted: the outbox is the only browser-side retention, and the composer's
    queue bar shows omp's queue alone (`queuedCount > 0`).
  - Because a send no longer awaits its stream, a run the `running` channel
    reported **while the held message's stream was still connecting** must be
    adopted when that stream opens: the lookup is owed past the open stream
    (`seenWhileUncovered` in the running-frame effect), rechecked when the
    connection settles, and applied with `attachLiveRun(…, lateStream = true)`
    — the hub never replays an older run's start frame to a late subscriber.
  - Coverage: `hooks/useAgentSession-outbox.test.mjs` (held send, the three
    queue modes, `outbox_update` frames, delete semantics, state-route
    hydration against a fake worker ledger) plus the held-flow blocks of
    `hooks/useAgentSession.rpc.test.mjs`.

### Live event stream: one socket per browser (`/api/events`)
- Browsers cap HTTP/1.1 at **6 connections per host across all tabs**, and an
  SSE response pins one for its lifetime. Per-stream SSE (sidebar + host
  tools + chat + file watch per tab) froze everything after ~2 tabs, so
  **never add a new `EventSource`** for live data: add a channel instead.
- `lib/event-stream-worker.ts` (SharedWorker; dedicated Worker where
  SharedWorker is missing) holds the browser's one connection: by default the browser link below, one WebSocket;
  the only `/api/events` EventSource is the fallback (a stored `sse` setting, or a proxy that refuses the upgrade). It multiplexes every tab's subscriptions:
  frames arrive as `event: <subId>`, control frames as `event: mux`
  (`hello`/`open`/`end`/`ping`). Subscriptions are attached with `POST /api/events`.
  `buildEventStreamWorker` (`server/client-env.ts`) bundles it into one classic
  script (`dist/event-stream-worker.js`; the dev server serves it from memory),
  and its URL carries the bundle's content hash so a changed worker never serves stale tabs.
- Tabs use `openEventStream(channel)` (`lib/event-stream.ts`), which keeps
  EventSource semantics: `onerror` + CONNECTING = reconnecting on its own,
  CLOSED = fatal (e.g. 409 for a wrapper-less session; the chat hook then
  retries with backoff). Dead tabs are detected with a lifetime Web Lock —
  MessagePort has no close event.
- Channels (`lib/event-stream-hub.ts`): `running` (sidebar badges +
  session-list hints + boot epoch + chat-event-action broadcasts + the
  externally-running heartbeat), `notifications` (one tab's toasts and in-page
  system notifications, keyed by its `clientId`), `hosts` (the `GET /api/hosts`
  body on subscribe and on every link or registry change), `host-tools` (cross-session
  `open_url`/`notify`/`open_file` calls), `session` (observer-only, never
  spawns omp; queues and merges `message_update` frames under backpressure,
  see "Streaming message updates"), `file` (viewer watch, same allow-list as `/api/files`). A
  failing frame ends only its own subscription, never the shared socket.
- Split channels by consumer, lifetime, key and access check, not by which
  stream happens to be open: a subscription costs one `POST`, not a socket, so
  never piggyback a frame type on another consumer's channel. `notifications`
  and `host-tools` are subscribed from `AppShell`, so they outlive the sidebar
  (which unmounts while Settings is open).
- **Liveness (the "tab was away, chat stopped updating" bug):** a sleeping
  machine / dropped network leaves the SSE half-open — no error, no close,
  EventSource never reconnects, and prompts POST fine while every frame dies
  in the dead socket. Detection is explicit, on both sides: the server
  heartbeat is a real `mux` `ping` event every 30 s (an SSE comment is
  invisible to JS), the worker stamps every arriving frame and force-opens a
  fresh EventSource after 3 missed beats (`STALE_AFTER_MS`), and every tab
  posts a `wake` (`visible`/`online`/`network`) so the check runs the moment
  the user returns, before the first stale prompt. A fresh hello
  re-subscribes every channel (the same path as EventSource's own reconnect).
  The browser link (below) is the default transport and needs none of this:
  its own ping/pong, silence redial and resume cover the same failure.
  Server-side backstop: a connection whose queue stays backpressured across
  >2 heartbeats is treated as dead and closed (releases file watchers and
  session listeners); a live client just reconnects.

  A wrapper **destroyed while a browser still watches it** is the other half of
  the same bug. The 10-minute `IDLE_DESTROY_MS` backstop tears the child down
  regardless of attached UIs, but the hub's session subscription lives on the
  dead wrapper instance: unless `openSessionChannel` ENDS that subscription the
  moment the wrapper emits `session_destroyed`, the browser's `isOpen` stays
  true, so `handleSend` takes the hot path (skips the cold `get_state` that
  would respawn), the prompt POST spawns a *fresh* wrapper, and every frame of
  the new run emits to **zero** listeners — the "idle, then a new prompt never
  updates" freeze (observed: `emit … listeners=0` for a whole turn). Ending the
  sub makes the worker reconnect it like any ended channel (`end` control frame
  → resubscribe), which re-attaches to the respawned wrapper (or 409-closes so
  the next send cold-starts one); `useAgentSession` then re-registers the
  per-wrapper host tools / URI schemes / roster on every `connected` frame, not
  just the fatal-reconnect path. Regression: `event-stream-hub.test.mjs`
  "destroying the wrapper ends its session subscription". `OMP_WEB_IDLE_DESTROY_MS`
  shortens the backstop window for E2E.
- **Browser link** (`browserTransport: "ws"`; `docs/specs/2026-11-01-browser-link-design.md`). The server's
  setting (`omp-web-settings.json`, `lib/web-settings.ts`; `"ws"` default, any other stored value except `"sse"`, the
  old `ws-*` experiment modes included, reads as `"ws"`) picks the worker's connection. With `sse` everything
  above holds and the worker opens no WebSocket. Switch it in Settings → Interface & Behavior → "Browser
  connection" or with `PUT /api/web-settings {"browserTransport":"ws"|"sse"}`; a change
  broadcasts a `transport` control frame on every connection and every `hello` carries it. From a shell
  (production on 127.0.0.1:30185, the trusted header from the pr-watcher env file; no `Origin`, so no
  origin check):
  ```bash
  curl -sS -X PUT http://127.0.0.1:30185/api/web-settings \
    -H "x-omp-web-auth: $(sed -n 's/^OMP_WEB_TRUSTED_HEADER_SECRET=//p' /opt/omp-deployment/pr-watcher.env)" \
    -H 'content-type: application/json' -d '{"browserTransport":"ws"}'
  ```
  - **One WebSocket per browser** at `GET /api/events/link` (`lib/browser-link.ts`), gated like every API
    route, carries every subscription and every agent command and reply. Reconcile polls, `POST
    /api/agent/new`, files, settings and the metrics POST stay HTTP.
  - **The host link's delivery, reused** from `lib/hosts/link-protocol.ts`: sequenced lines both ways
    (`LinkSender`, `SeqWindow`, `Outbox`), acked and resent after a reconnect; lines over 256 KiB as `part`s
    (`PartJoiner`); per-key queues served round-robin (a subscription's frames, a session's commands or
    replies, `mux`); a session's commands stay in order, so Stop never overtakes the prompt it stops. The
    server keeps at most about 1 s of the measured ack rate unacked below the socket (64 KiB to 512 KiB,
    `measure` in `lib/browser-link.ts`; only a stretch where the window or the socket's backpressure held lines back resizes it), the
    worker at most 512 KiB. `welcome`/`ack`/`ping`/`pong` skip the queues. So a command's reply waits behind
    about a second of the link plus a piece per busy key, never behind a snapshot. The pacing loops
    are the browser link's own copies: the server's mirrors the hub's (`send` → `-1` → `drain`), the
    worker's the daemon's (`bufferedAmount` under 2 pieces); a fix to either original must be carried over
    (`lib/browser-link.integration.test.mjs` runs the real worker against the real server end). A socket
    that has not said hello within 10 s is closed 1008.
  - **Liveness:** the server pings every 15 s; each side drops a socket after 30 s without any frame.
    Command delivery additionally watches sequence-ack progress, including multipart uploads: initially
    5–6 s without progress redials with trigger `command`, even while updates arrive. Each such redial
    doubles the deadline up to 30 s; an advancing ack on the current socket covering all watched
    command pieces resets it to 5 s (a resume welcome does not). Acknowledged commands waiting for
    their results never cause this redial. Replay and resync retain the rules below.
    Wakes: `online` and a network change redial at once and reset dial backoff to 1 s; `visible`
    pings and redials a socket silent for 3 s.
  - **Resume.** The link outlives its socket for 2 min (`LINK_RESUME_MS`): the worker's `hello` carries
    its token and `ack`, the server (same web session only: SHA-256 of the session cookie, else
    `trusted`/`open`) reattaches and both sides resend what the other missed. Subscriptions stay open on
    the server, so the tabs see nothing: no `error`, no second `open`, no snapshot. While the socket is
    gone or lines wait for the window, `message_update`s merge (`queueUpdate`) and go on the next ack. A socket that holds unacked bytes and gets no ack for 120 s (`ackMs`; pings do not count) is closed: its link detaches, resumable, and falls under the total budget. A link slower than about 17 kbit/s cannot finish a 256 KiB piece before that deadline.
  - **Resync** when the gap is gone (2 min passed, the backlog passed 32 MiB and the socket closed 4410,
    all links together passed 256 MiB and this one's socket was gone longest, or the server restarted):
    `welcome {resumed: false}`, both sides start over, every stream gets CONNECTING and subscribes again
    (fresh snapshots, as an SSE reconnect). Sent commands go again (same `rid`) when idempotent
    (`isIdempotentCommand`: `get_*`, `predict_word`, `predict_word_feedback`, `set_host_tools`,
    `set_host_uri_schemes`; never `abort`; the server does not remember those) or when the
    server is the same and their first send was within `COMMAND_DEDUPE_MS` (10 min; the server's
    `(session, rid)` dedupe answers a repeat with `deduped: true`), else 503 `transport_lost`
    (`TransportLostError`). A command with no link for 15 s answers 503 `transport_unavailable`. A worker
    done with its link closes it 1000 (the server drops it at once); 4000 is its own redial.
    The server answers a command whose JSON is over the route's 8 MiB body cap (UTF-8 bytes; the worker
    checks first, the server again for a joined line, whose cap leaves room for the envelope) 413
    `request_too_large`, and a command that changes something 429 `too_many_commands` while `DEDUPE_MAX`
    (500) remembered ones are all still inside `COMMAND_DEDUPE_MS`: neither runs, neither is remembered.
  - **Fallback.** A socket that closes before it opens gets a plain `GET /api/events/link`: offline, 401,
    502, 503 or 504 redial. Any other answer (426: a proxy that drops Upgrade, but also a healthy server's
    answer to a dial that failed as the network came back) is a refusal: 3 in a row, with no open between
    and none while `navigator.onLine` is false, put this worker on SSE for 5 min. Close 4426 (another link
    version) falls back at once.
  - **One command path.** `runAgentCommand` (`lib/agent-command.ts`) is what `POST /api/agent/[id]` runs
    after parsing and what a link `cmd` runs, so both answer identically. Command logic goes there.
  - **Metrics** (both transports). Tabs and the worker record `action`, `event`, `reconnect` (with
    `resumed` on the link), `hang` (HTTP only) and `dropped` samples tagged `transport` (`sse`/`ws`),
    `socket`/`conn` (`sse`, `link`, `http`, `worker`) and `sockets`; the worker POSTs them to
    `/api/transport-metrics` every 30 s or 200 samples (a probe not answered within 10 s is abandoned, a POST within 10 s plus its body at 2 KB/s; a failed POST keeps its samples, so a timeout after the server processed it can duplicate them). The route appends JSONL to `<agent
    dir>/omp-web/transport-metrics.jsonl` (`.jsonl.1` above 20 MiB). One worker-wide clock (the
    lowest-RTT of the last 20 link pings and SSE probes, at most 5 min old unless it is the newest sample) times every sample.
    `bun scripts/transport-metrics.ts --since 2h` prints the per-transport summary (also `--until`,
    `--client`, `--file`).
  - **Connection tab** (right panel, both layouts, shown while Settings → Interface & Behavior → "Show connection
    diagnostics" is on, `omp-web:connection-diagnostics`, per browser). It polls the worker (`diag` op,
    `requestConnectionDiagnostics`) once a second while visible: the mode in effect, fallback, status (`idle` when
    no connection is needed, `down` after `SEND_DEADLINE_MS` without a connection), the last reconnect, and
    per-transport stats (mean, p50, p95, p99.9 from 1000 values, max) of the worker's last 30 min of samples (at most
    20 000, kept beside the POST buffer). Command rows include confirmed successful replies only; app ↔ omp and round-trip rows skip commands whose reply does not confirm omp got them (`NO_OMP_REPLY_COMMANDS`: the `NO_SPAWN_REPLIES` the web app answers itself, a test keeps them included, plus the results `dispatchCommand` forwards without awaiting omp). A new command of either kind belongs there. Shared durations
    come from `lib/transport-stats.ts`; one-way estimates use clock correction and assume symmetric latency.
    Without a SharedWorker (Chrome for Android) each tab has its own worker, so the numbers are that tab's.
  - **Worker rules.** Browser code: no `AbortSignal.timeout`/`any` or `Promise.withResolvers` (a test checks
    the bundle). Every global the worker uses must be injectable into the `vm` context of
    `lib/event-stream-worker.test.mjs`. The link URL is absolute (`new URL(path, self.location.href)`,
    `http`→`ws`). Ids are `Math.random().toString(36).slice(2, 12) + Date.now().toString(36)`: insecure LAN
    origins have no `crypto.randomUUID`.
  - **Limits:** a socket stays authorized after logout until it closes; Bun buffers a browser frame up to the host
    link's 64 MiB `maxPayloadLength` (per server) before the handler refuses it; a notification routed to a tab whose
    link then resyncs is not shown there.

### Running state + reconciliation
- The sidebar subscribes to the `running` channel, backed by `subscribeRunningSessions()` in `lib/rpc-manager.ts`, so running badges update without polling.
- An open chat subscribes to `running` too: when its session shows up there while the chat has no `session` stream (the run started after the chat loaded: another tab or device, or a send from a chat instance the user switched away from), it reads `GET /api/agent/[id]` and attaches exactly as on load (`attachLiveRun`). Without it the chat stayed idle beside a running badge until a reload. A lookup that reports `external: true` goes to `enterExternalMode` instead — an externally-held file is never attached over RPC (that would fork it).
  - The lookup waits for the chat's own work: its mount load while in flight (a stream attached before that load lands would make its `agent_start` drop the load), a stream of its own still connecting (its readiness wait can still fail and close it), and a local send, `!` command, Edit or manual compaction until it settles. The frame is kept meanwhile, and the operation's release rechecks it (`runningRecheckRef`). A local operation that starts during the lookup makes its answer stale (one generation per operation kind). A failed lookup is retried after 1, 2 and 4 s.
  - Compaction state has one owner at a time. A manual compaction this tab sends holds it until its command settles (`localCompactionsRef`): omp may not have the command yet, so an idle snapshot cannot release it; when it settles during an auto-compaction (`autoCompactingRef`), the control stays with the auto-compaction. Native snapshots (state polls, attach, mount) apply only if no compaction started or ended since they were requested (`compactionGenRef`); `setCompacting` keeps `isCompactingRef` and the rendered state together.
- `useAgentSession` still treats its `session` channel as primary for chat events, but while a run or a manual/auto compaction is active it periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed `agent_end` events from background tabs and half-open connections, and a missed compaction end that would leave the Stop control stuck.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.
- A prompt this tab has minted but not yet dispatched (cold wrapper spawn)
  is legitimately absent from the server: `promptDispatchPendingRef` spans
  the optimistic bubble to the prompt-POST settle, and the reconcile net
  SKIPS while it is set — finishing on a not-running state in that window
  erased the bubble and the running state (the "prompt disappears until the
  session really starts" symptom). Likewise the session-file watcher reload
  skips while a WEB-owned run is in flight (`agentRunningRef.current &&
  !externalRunningRef.current`): the write comes from the own wrapper and
  reloading pre-prompt on-disk state would wipe the bubble / live tail;
  external runs keep the watcher as their only transcript feed.
- The sidebar badge set merges two feeds in one state (`hooks/useRunBadges.ts`,
  pinned by `hooks/useRunBadges.test.mjs`): AUTHORITATIVE full snapshots (the
  `running` channel frames and the pre-SSE `/api/sessions` fallback — each
  replaces the whole set) and EXTERNAL marks (file-activity frames + the 5 s
  heartbeat, each id with a 15 s TTL). Invariant the old bug broke: a WEB child
  writing the session file while its wrapper's running flags are momentarily
  false (the auto-compaction / maintenance-continuation window) gets marked
  externally running — and the expiry timer MUST NOT delete an id the latest
  authoritative snapshot claims (the continuation turn resumed; the session IS
  running). `applyAuthoritative` therefore clears the timers of the ids it
  claims and the expiry callback defers to the snapshot ref — otherwise a
  long-running session loses its badge mid-run until the next transition
  (the "running session, no spinner in the list" symptom).

### External session detection (`lib/session-watcher.ts`, `/api/sessions/[id]/state`)
- When ompweb restarts mid-run, the omp children do NOT die with it — they run under the local `ompweb host` daemon and are ADOPTED by the new server (see "Local daemon"). External detection therefore covers what adoption cannot: a terminal `omp --mode rpc-ui`/`omp --resume <file>` started outside omp-web, and children of a DIFFERENT instance's daemon. The server detects such "externally held" sessions by scanning `/proc` for `omp` processes with `--resume <file>` on the command line, or — for daemon-spawned children whose cmdline has no file — with a session file held open (fd scan). Web-owned children (direct children of this node process or of its daemon) are excluded by PPid, NOT by the RPC registry: after a restart a session can hold a freshly restored idle RPC while a stale previous-server child still owns the file.
- `GET /api/sessions/[id]/state` reports `external: true` ONLY from a live holder (`isExternallyActive`) with a turn in flight (`heldSessionsWithPendingTurn`). "Turn in flight" = the last committed `message` entry is a user/toolResult (model generating) or an assistant with a pending toolCall. **A recent file write is NOT a running signal** — the 90 s `EXTERNAL_ACTIVITY_WINDOW_MS` remains only as the client's reclaim-poll gate (`isRecentlyActive`, a quiet-THINKING run stays external so it can still be reclaimed). Trusting mtime made every freshly edited session file answer "running" on visit: the page rendered committed running-looking toolCalls with an idle composer until the next write flipped the badge on (the exact symptom this replaced). Idle holders (a terminal waiting for input, a leftover child after its turn finished) end on a final assistant message and must not keep the session "running" forever. `STALE_HOLDER_MS` (5 min) silence drops a holder **only when its tail is final** (a run that truly ended on an idle prompt); a mid-run tail keeps the holder listed — a long silent tool (subagent collecting results, a build) is a live run, and `hasRunningTurn`/fd probes cannot see another process's in-flight assistant stream. A dead-end process is dropped once its turn settles or the file is deleted; a live run re-announces itself on its next file write.
- Client (`useAgentSession` `enterExternalMode`): external sessions render as running (Stop button, "running in an external omp terminal" notice), never attach a per-session RPC stream or registry reconcile, and a 10 s poller reclaims to idle once the file is quiet and the committed tail is final. Stop/send/steer/compact are rejected with the same notice — the web server has no RPC channel to the external process, so it must be stopped at its source (the terminal). The session-file watcher re-enters external mode on the next write (which also reloads via `loadContext(sid, null, true)` so an open pre-compaction view survives external writes).
- The session-file watcher uses per-directory non-recursive inotify watches (one per project dir, lazily added with a one-shot resync). Node's recursive `fs.watch` lstats every directory entry on folder events, which raises an uncaught EIO on WSL2/9p (dentry race on transient `.jsonl.lock` files) and killed the server. `instrumentation.ts` additionally suppresses exactly those errors.
- **inotify is silent on 9p/drvfs mounts** (WSL2 with the agent dir on a Windows drive, e.g. `/root/.omp` → `C:\`): no events at all, so external sessions never updated in real time there. The watcher therefore also runs a **polling fallback** (`pollForChanges()`, exported for tests): a 2 s stat-based sweep over known session files feeding the same `pendingPaths` → `flush` → listeners pipeline (size baselines shared with inotify via `lastSizeByPath`, `pendingPaths` dedupes both sources), plus a 15 s directory rescan that discovers new `.jsonl` files. On native filesystems the sweep is a cheap no-op once inotify has delivered the event.
- **Sessions waiting for their first response** (sidebar naming before the file exists): the `running` channel carries `meta: { cwd, firstPrompt }` frames for live RPC sessions (`getRunningRpcSessionMeta`; `firstPrompt` is captured once by the wrapper at the first real `prompt` send and NEVER by `/rename`-style title runs or resumed sessions). `SessionSidebar` keeps these as `pendingSessions` and renders placeholder rows under the SPAWNED cwd with the prompt text as the title — a bare file-less id gets no row (never a GUID slice, never attached to the currently-viewed workspace), so a switching user sees the running session where it was created until omp writes the real file.

### Auto-resume after a restart (`lib/session-resume.ts`, `lib/web-settings.ts`)
- ON by default (`autoResumeSessions` in `~/.omp/agent/omp-web-settings.json`, toggle in
  Settings → System & Updates, served by `/api/web-settings`). An explicitly saved
  disabled value stays disabled. While on,
  `recordRunningSessions()` keeps `omp-web-interrupted-sessions-<pid>.json` files in
  the agent dir current (per-instance lists, so two instances sharing an agent dir
  never resume each other's sessions).
- **A web restart usually needs no resume at all**: the omp children run under the
  local `ompweb host` daemon, so stopping the web service does not reach them and the
  next server ADOPTS the ones still running (see "Local daemon"; `adoptedChild`).
  Only sessions whose child actually died (daemon restart, crash, failed adoption)
  resume — after the daemon's hello, via `resumeOnHostLink()`, which first awaits
  `adoptedChild()` and skips any session that was adopted.
- A session leaves the list when its run ends normally (process still alive), or
  `EXIT_GRACE_MS` (2 s) after its process dies — a service stop signals every process
  at once, so a child can die just before the shutdown handler runs;
  `markShuttingDown()` (the registry cleanup hook, fired from `instrumentation.ts`)
  freezes the list so those deaths still count as interrupted, while a crash with
  omp-web still up is dropped after the window.
- On boot, `instrumentation.ts` calls `resumeInterruptedSessions()` (fire-and-forget,
  must never block boot): each interrupted session is re-spawned and prompted with the
  side-effect-aware recovery prompt ("The omp-web server restarted while your previous
  turn was active… Do not repeat completed side effects…"). omp ≥ 18.10.3's native
  `--restore` (continues the interrupted turn and its subagents itself) is
  deliberately NOT used: **every released omp rejects `--restore` under
  `--mode rpc-ui` (interactive-terminal only)** — verified against 18.10.4 in
  E2E — so an rpc-ui child cannot continue a crashed turn.
- Only session ids + the `--advisor` flag are stored; paths are re-resolved on resume,
  and invalid ids are dropped. The tracker claims the previous run's list on first use
  in the process (`readLeftover`), so this run's first write can never clobber it before
  resume consumes it. `ownedByLiveInstance` treats a **zombie** writer pid as dead
  (`isZombiePid`, `/proc/<pid>/stat` state after the last `)`): signalling a zombie
  succeeds, so under a non-reaping init a crashed server's corpse pid would otherwise
  pin its interrupted list "live" forever (observed in the container; E2E-proven).
- Known limit: resume does not detect a terminal `omp --resume <id>` started on the
  same session while omp-web was down; both would write the file.

### `instrumentation.ts` — edge-runtime import trap
- `instrumentation.ts` is bundled for **both** Node and Edge runtimes. A static
  top-level `import` of a Node-only module (e.g. `@/lib/rpc-manager`, which
  pulls `child_process`/`fs`/the RPC protocol) forces it into the edge
  bundle; Turbopack then fails the edge build on every request and loops in
  continuous rebuilds — the dev log balloons to hundreds of MB and page
  hydration takes minutes, producing false "page never hydrated" E2E failures
  that look like an app bug but are an environment bug. All Node-only imports
  in this file MUST be dynamic `await import()` calls inside the
  `NEXT_RUNTIME === "nodejs"` guard (the file-header comment enforces this).

### Process-details group stability (`components/ChatWindow.tsx`)
- "Process details" groups key their React `key` on the anchor entry id (`process-group-<entryId>`) — never on the message index or the final-assistant index — because the group grows as new tool calls commit mid-turn and index-based keys remount it, silently resetting the user's expanded state. Expansion state lives in `CommittedTranscript.processExpanded` keyed by anchor id, so it survives remounts and virtual-window recycling. With the Interface & Behavior switch "Hide tool activity while working" on (localStorage `omp-web:hide-tool-activity`, **on by default**, port of upstream 84e4bd1b) a running turn folds its activity into Process details rows exactly like a finished turn; turning it off restores the flat live tail for the in-flight turn.
- The rows inside are hoisted the same way: the user's open/collapse choice
  for a tool-call row lives in the ChatWindow-provided
  `ToolExpansionProvider` (`components/tool-expansion.tsx`) keyed by the
  stable `toolCallId` — never in `ToolCallBlock` state — because rows are
  remounted by virtual-window recycling, transcript reloads and the
  live-tail → process-group reshuffle, each of which silently collapsed
  rows the user opened by hand. The provider spans the committed transcript
  AND the streaming bubble, so a row opened mid-stream stays open when it
  commits; outside a provider the row keeps its local state.

### Transcript re-render stability (`components/ChatWindow.tsx`)
- A finished turn's fold rows render through **message-override objects**
  (text segments and activity pieces carry block subsets). They MUST come from
  the per-turn `TurnPlan` cache (`buildTurnPlan`, keyed by the anchor entry id,
  invalidated on the turn's `endIdx` + element-identity of its message slice) —
  building overrides inline produces new objects on every render, which fails
  every row's memo comparator: the whole visible transcript re-rendered on
  every streaming batch / tool commit (E2E-measured: 52-74 renders per old row
  for one run; with the cache: ~3, only on the semantically real
  `sessionBusy`/fork-target flips). Invisible on fresh single-turn sessions —
  the symptom is an aged-session one.
- `messages` carry NO `id` field (`entryIds` is the only stable per-row
  anchor): the `GroupHeightCache` rebuild seeding keys measured heights by
  `entryIds[groups[g].userIdx]` — keying them on `message.id` was a silent
  no-op that reverted every group to its estimate on each append (the height
  reflow/scroll jump when a tool committed). Anything anchoring across renders
  uses `entryIds`, never `message.id`.
- `modelNames` keeps its object identity while the mapping is unchanged
  (`loadModels` compares before `setModelNames`) — a fresh `Record` fails every
  MessageView comparator for the whole committed transcript.

### Composer-attached hub bars (`components/ComposerPanels.tsx`)
- The live todo plan (`TodoList`), the subagent roster and the git changes
  bar (`GitChangesBar`) live **pinned above the chat input**, not inside the
  scrollable message list. `ComposerPanels` renders each as an independently
  collapsible bar (header row with chevron); bars start collapsed (headers
  always show live progress / running-summary).
- **Live status placement** ("Interface & Behavior" → Show live session
  status in Tasks bar, localStorage `omp-web:live-status-placement`, default
  `"bar"`): the transient phase line (`liveStatusText`, ChatWindow — e.g.
  "Waiting for model...", "Thinking...", phase progress) is hosted in the
  Tasks bar header row (the Subagents bar only when no Tasks bar exists)
  while the placement is `"bar"`; `"inline"` (or no host bar) renders the
  classic standalone bouncing O-M-P line in the transcript. `liveStatus` is
  passed to `ComposerPanels` as `null` in inline mode, so a bar can never
  claim a status it does not show.
- **Stacking** (`layout` prop, "Interface & Behavior" → Hub bar layout):
  `"stack"` (vertical column, default) or `"row"` (compact bars share one
  horizontal line). In row mode every bar owns a *stable slot* of one
  wrapping flex row — expansion only changes slot styles (`flex: 0 0 100%` +
  `order: -1` for an expanded bar, which takes a full-width line above the
  collapsed ones), never the element's position. NEVER move a bar to a
  different tree position based on its own data (e.g. git presence): the git
  bar owns its poll and would remount on every presence flip, resetting its
  status and looping.
- **Per-bar visibility** (`showGit`/`showTasks`/`showSubagents` props,
  "Interface & Behavior" → Hub bar visibility): each bar can be hidden
  separately. The git bar stays *mounted* while enabled (its slot is
  `display: none` until the poll reports a repo with changes) so polling
  keeps running; `gitPresent` via `onPresenceChange` gates the slot.
- **Workspace git stats** ("Interface & Behavior" → Workspace git stats):
  `gitStatsPlacement` (`"inline" | "second" | "hidden"`, AppShell →
  `SessionSidebar`) places BOTH the change-count chip and the active
  branch/worktree chip in the sidebar workspace header — both inline on the
  name row, both on a second line under the name, or neither shown (hidden
  workspaces are not polled, and the worktree dropdown loses its inline
  trigger).
- Subagent chips carry live state (pulsing dot while `started`, check/alert/ban
  for terminal states) fed by the same `subagent_lifecycle`/`subagent_progress`
  SSE frames; clicking a chip opens the transcript dialog. Non-running
  subagents (terminal or history) nest under a collapsible `Completed (N)`
  group inside the hub, re-collapsing on every mount (not persisted).
  `TodoList` keeps a non-collapsible default (`collapsible` prop) for SSR tests.

### Todo list state (`lib/todo-phases.ts`)
- The Tasks hub bar has exactly two feeds, and both validate + normalize through
  the shared `lib/todo-phases.ts`: the live `get_state.todoPhases` snapshot
  (`AgentSessionWrapper.buildWebState`) and the on-disk history
  (`getTodoPhasesFromEntries` — walk the branch LEAF→root so the first valid
  snapshot is the latest; scanning root→leaf returned the branch's first list).
- INSURANCE until native OMP resolves the todo-argument laxness: omp ≤ 18.8.9
  accepts a `todo init` whose `items` are not strings and stringifies them into
  the task text (a model nesting `{phase, items}` objects inside `items` shows
  up as raw JSON rows in the bar), and a later `rm` cleanup leaves a zero-task
  phase behind (ghost "0 / 0 complete" bar). `normalizeTodoPhases()` re-expands
  mangled JSON task contents into their declared phases/tasks and drops
  zero-task phases; when upstream validates `items` and prunes empty phases the
  rescue path becomes dead code but the structural validation stays.
- All task bars gate on the TASK count, not the phase count
  (`ComposerPanels.showTodoBar`, `TodoList`, `PlanPanel.hasTasks`) — the client
  backstop for snapshots from an already-running older wrapper.
- omp's store normalizes every todo mutation to EXACTLY ONE active task:
  with nothing in progress it auto-marks the FIRST pending task in flat
  order (verified in the omp binary). A model `init` naming an empty
  `phase` with tasks in `list:[…]` drops the empty phase and activates the
  first `list` task — so the bar can show a dot on a task of the phase the
  agent is NOT working on, and phases can appear in surprising order
  (empty-at-init phases are appended when a later `append` fills them).
  ompweb renders omp's snapshot faithfully; this is upstream store + model
  init-shape behavior, NOT an ompweb ordering bug — do not "fix" it by
  re-sorting phases or faking activity in the bar.

### Mobile context ring placement (`Settings → Interface & Behavior`)
- The context info ring (port of upstream 193047f1 chain, mobile top-bar
  mount of 3c1e8449) is placement-configurable on phone screen sizes:
  `contextRingMobile` (`"composer" | "topbar" | "hidden"`, localStorage
  `omp-web:context-ring-mobile`, default `"topbar"`). Desktop is inert —
  the ring always stays in the composer there.
- The ring renders through one portal (`ChatInput`): `ringInTopbar` picks
  the AppShell `.shell-session-info` top-bar mount (44px touch target,
  popover fixed under the bar), otherwise the composer's own anchor
  (28px, popover opens above the trigger like desktop). `ringHidden`
  renders no ring at all — the composer anchor stays mounted but
  `display: none` (no stray flex gap), and `/session` no-ops.
- The top-bar mount div is only rendered while the setting says
  `"topbar"`; unmounting it nulls `sessionInfoContainer` through the
  callback ref, so the composer anchor takes over without a stale target.

### Side questions (`/btw`, `lib/btw.ts`, `hooks/useBtw.ts`, `components/BtwPanel.tsx`)
- `btw` / `btw_cancel` / `get_btw_history` are passthrough RPC commands;
  answers stream as `btw_delta` (text appended to the latest turn) and
  `btw_record` (full snapshot per lifecycle change) frames. omp persists the
  history per session (and re-reads it from disk when idle), so the TUI and
  omp-web share topics. omp answers `btw` before that turn's frames; the
  running `btw_record` comes first.
- `/btw <question>` and `/btw` are client builtins (`handleBuiltinSlashCommand`
  case `"btw"`). `ChatInput.sendSideQuestion` routes them there from both the
  idle and the streaming submit path, *before* attachments are checked: never sent
  as a prompt, never queued, and refused with a toast (draft and attachments
  kept) while attachments are attached. Asking starts the wrapper
  (`get_state`) and attaches SSE first when it is not open, so no early delta
  is lost; a second ask while one is starting is ignored.
- The `btw` response, history snapshots and frames race (HTTP vs SSE): merge
  only through `lib/btw.ts`, which never lets a stale snapshot drop streamed
  text, a turn, or a finished status. A record that was running before a
  history read and is missing from it becomes `interrupted` (omp lost it).
- `btw_*` frames skip the message-update coalescer (each would flush the main
  stream's pending update) and are batched in `useBtw` with the coalescer's
  `scheduleAtDisplayRate` (rAF, 50ms timer in hidden tabs). Pending frames are
  flushed before a history snapshot is merged, never after it.
- `btw_*` frames are matched in `connectEvents.onEvent` BEFORE
  `eventCoalescer.push`, never dispatched through the coalescer: every push
  synchronously flushes the main run's pending `message_update`, so routing a
  side-question frame through it would defeat display-rate coalescing of the
  run happening beside it (a btw frame can never touch the transcript itself —
  `handleAgentEvent` ignores unknown frame types).
- `get_btw_history` and `btw_cancel` never spawn or replace omp: the agent
  route answers them like `predict_word` (`NO_SPAWN_REPLIES`: empty history,
  `cancelled:false`) when no child is alive. History is re-read on every SSE
  open and from the running-state reconcile (interval, visibility and online —
  the no-spawn read is silent), and after a cancel that found nothing running.
  `/btw` alone sends `get_state` first, so it may start omp. An omp without
  the commands answers `Unknown command: btw` → localized "requires a newer
  omp" toast (`toastBtwError`); background reads stay silent and pause for
  `UNSUPPORTED_RETRY_MS`. omp's "cancelled before it started" failure is the
  user's own Cancel: no toast.
- The panel sits first in `ComposerPanels` (the single site also renders in
  the empty new-chat layout) and is keyed by record id: each new topic starts
  expanded, unlike todo/subagents. A running record this tab did not know yet
  opens it (another tab, reconnect); a known topic never reopens a closed
  panel.

### Subagent integration (`lib/subagent-types.ts`, `lib/subagent-history.ts`)
- **Live detail**: `subagent_progress` frames carry the full `AgentProgress`
  object — `lib/subagent-types.ts` parses it defensively into
  `SubagentInfo.progress` (current tool/intent, tokens, cost, context
  gauge, resolved model, retry state, detached flag, agentSource). The
  composer chips surface the current activity + telemetry line; retry
  (`⟳ retrying N/M`) takes precedence over the tool line. `subagent_event`
  frames also feed a bounded per-subagent activity buffer shown in the
  transcript dialog.
- **Roster hydration**: `get_subagents` snapshots (which carry progress)
  rehydrate the roster after SSE reconnect (`refreshSubagentRoster`, wired
  into mount, send, and the reconcile poll). Terminal subagents vanish from
  the RPC registry — history fills that gap.
- **On-disk history** (`lib/subagent-history.ts`, `/api/sessions/[id]/subagents*`):
  omp persists each subagent's transcript to the parent session's sibling
  artifacts dir (`<session-dir>/<subagent-id>.jsonl`) and the parent file's
  task toolResults keep `progress[]`/`results[]` snapshots. omp-web recovers
  the roster from disk (`extractSubagentHistory`, result fields win over the
  mid-run snapshot), so past/finished runs show in the composer panel after a
  reload. The transcript route pages the sibling file byte-wise (mirroring
  `get_subagent_messages`, which is RPC-registry-gated and refuses files it
  doesn't know). The dialog reads only the final output — `<id>.md` via
  `?mode=completion` (bounded tail read that also works for transcripts
  beyond the 16MB paging cap) with a live `get_subagents` snapshot fallback
  for header enrichment; it never pages the raw transcript. Subagent ids are
  `[A-Za-z0-9_-]{1,80}` — the route validates before joining to confine reads
  to the sibling dir.
- **In-message task summary** (`components/MessageView.tsx` TaskResultPanel):
  the session reader allowlists a SIZE-BOUNDED subset of `task` toolResult
  details (telemetry only — no `output`/`stderr`, long text truncated to
  240 chars, `lib/session-reader.ts` `keepTaskToolResultDetails`), and
  expanded `task` tool calls render a per-subagent summary (status, agent,
  task, tokens/cost/duration/model, async marker) above the raw result text.
- **Chip extras**: agent-source labels (`user`/`project`), nested-subagent
  count (`inflightTaskDetails`/`extractedToolData.task` progress), and the
  `⤴` async marker (live `detached` flag or history `details.async`
  presence). Shared formatters live in `lib/subagent-format.ts`.
- **Async-result job rows** (`CustomMessageView` in `components/MessageView.tsx`):
  omp ≥ 19.1 attaches machine-readable job metadata to `async-result` custom
  messages (`details.jobs[{jobId, status, agentId, label, durationMs}]`, older
  omp keeps jobId/type/label/duration). The card renders one row per job —
  status chip, label, type, duration — and the `agentId` chip opens the Agents
  panel transcript (`openAsyncJobTranscript` in `ChatWindow`: roster entry when
  still live, else `agentLinkTarget`'s history-synthesized info). Rows vanish
  silently for messages without `details.jobs` (pre-18.9 files).
- **Roster order** (omp 18.8.4 Agent-Hub parity): newest spawn first — the live
  and on-disk rosters are a stable sort on descending launch index, so existing
  entries keep their relative order when a new subagent appears.

### Worktrees and project grouping
- `lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches that to each `SessionInfo` so all worktrees for one repo are grouped together in the sidebar.
- `/api/worktrees` delegates authorized operations and root grants to the owning daemon; only that host's session-list cache is invalidated on main.
- New worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused; otherwise `git worktree add -b` creates the branch.
- Removing a dirty worktree returns `409` with `{ dirty: true }` so the UI can ask before retrying with `force`.
- The right workbench's **Worktrees** view (`components/WorktreesPanel.tsx`) lists, switches, creates and removes the active Git workspace's worktrees, alongside the setting-gated inline chip on the project row; the new-session screen's worktree `<select>` (`WorkspaceSelector`, shown when the selected workspace is a Git top-level repo with 2+ worktrees) only switches. `SessionSidebar` owns the per-repo worktree cache and the actions and emits them as a `WorktreeContext` (`onWorktreeContextChange`, null unless the active workspace is a Git top-level repo); AppShell hands it to the Worktrees view (keyed by `projectRoot` so a draft branch or pending confirmation never carries over to another repo) and the new-session picker. Switching moves the sidebar's effective cwd (where a new session starts), not the open session.
- The file panel's **Worktrees** tab (`components/WorktreesPanel.tsx`) switches, creates, and removes worktrees; the new-session screen's worktree `<select>` (AppShell, shown when the selected workspace has 2+ worktrees) only switches. `SessionSidebar` owns the per-repo worktree cache and the actions and emits them as a `WorktreeContext` (`onWorktreeContextChange`, null unless the active workspace is a Git top-level repo); AppShell hands it to both. Switching moves the sidebar's effective cwd (where a new session starts), not the open session.
- Explorer and Git pair `explorerCwd` with its owning host. Each file tab instead retains its source host/cwd/session; relative links and downloads use that source after chat switches. Worktree caches, contexts and pending actions also include host identity.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.
- **omp-managed worktrees** (omp >= 18.8.6 per-session `worktree.onStart/onExit`):
  trees under omp's agent-managed base (`OMP_WORKTREE_DIR` -> `worktree.base` in
  `config.yml` -> `~/.omp/wt`, same chain as pi-utils `getWorktreeDir`) are marked
  `agentManaged` by `listWorktrees` (`lib/worktree.ts` `agentWorktreeBase` /
  `isAgentManagedWorktreePath`), show an `omp` chip and no delete affordance in
  the Worktrees panel, and `removeWorktree` refuses the deletion even with force
  (route -> `409 agent_managed_worktree`) — only omp knows whether a live session
  still runs inside the tree.

### Managed projects sidebar (`lib/project-registry.ts`, `/api/projects`)
- The sidebar lists **managed projects**: explicitly added directories (registered in
  `~/.omp/agent/projects.json`, written atomically as temp-file + rename) plus
  session-discovered ones — hidden entries excluded. Removing a project only
  marks it hidden (reversible via re-adding); hidden entries suppress session
  re-discovery.
- Registry paths are canonical `projectRoot`s: `POST` resolves worktrees to
  their main repo via `resolveProject`, and `resolveProject` returns the
  symlink-free on-disk form for plain directories so registered and
  session-discovered paths compare equal on Windows casing.
- `GET /api/projects` re-authorizes registered roots with `allowFileRoot()` —
  the in-memory browse allowlist does not survive restarts, and empty managed
  projects derive no root from sessions.
- By default (sort "None") the client orders the merged list manually
  (`sortOrder`, set by drag/Move up/down), then most-recently-added, then by
  path (`lib/project-ordering.ts`), so rows never jump while sessions refresh.
  The header sort button (`omp-web:project-sort` in `localStorage`, per
  browser) switches to Alphabetical (label A→Z) or Last updated (newest last
  message first: `lastMessageAt` from the session tail scan, else the file
  mtime) — the latter deliberately reorders on activity. While a
  sort is active, rows get a pin toggle: pinned projects (`pinOrder` in the
  registry, pinned to the end of the group) lead in their own manual order and
  alone keep Move up/down and drag; pins are ignored under "None".
  Expanded project paths live
  in `localStorage` (`omp-web:expanded-projects`), defaulting to only the
  active/restored project expanded, and stale keys are pruned against the
  current project list (only after the first project fetch — an empty
  still-loading list must never wipe storage).
- Each project's session tree is capped at 5 roots with a show-more toggle;
  project rows are cards matching the session items' height/margins/accent
  treatment, and the active project's worktree selector renders directly
  below its row.
- **OMP launch configuration** (`ProjectLaunchConfig` in `lib/types.ts`,
  `components/ProjectLaunchConfigDialog.tsx`): a registered project may carry
  `{ profile, advisor, extraArgs[] }` — the omp launch profile, the `--advisor`
  flag and extra CLI arguments — stored on the registry record and applied when
  a session spawns in that workspace. Set it two ways: the Add-workspace
  `DirectoryPicker` exposes the three controls inline (its `onSelect` carries the
  config to `POST /api/projects`), or the project row's menu
  (`sessionSidebar.editLaunchConfig` / `configureLaunchConfig`) opens the dialog,
  which prefills the stored shape and saves `null` for an empty form to clear it.
  Both write paths run through `handleUpdateProjectPresentation` /
  `commitAddProject`; `PATCH /api/projects` forwards `launchConfig` alongside the
  alias/presentation keys.

### Clone a repository as a new workspace (`/api/projects/clone`)
- The Add-workspace `DirectoryPicker` takes an optional Git URL; "Clone here"
  clones into `<selected dir>/<repo name>`, then registers that directory
  through the normal `POST /api/projects` path.
- Only `https://`, `ssh://` and scp-like `user@host:path` URLs are accepted
  (`cloneDirectoryName`); git also runs with `GIT_ALLOW_PROTOCOL=https:ssh`
  and `GIT_TERMINAL_PROMPT=0`, so credentials must come from helpers/agents.
- The POST streams NDJSON from daemon-owned jobs (`lib/hosts/workspace-clone.ts`);
  DELETE carries `{ id, hostId }` and waits for process exit and identity-checked
  cleanup. Cleanup captures into a private quarantine, verifies identity there,
  and removes only the owned clone. A raced replacement is preserved and its
  recovery location is shown. Existing targets are refused (409). Link/main
  restarts leave jobs alive, but the UI reports uncertain
  outcomes on a lost stream. Unobserved jobs cancel after two minutes; an unknown
  job on a replacement daemon never means successful cancellation.


### Navigate back / forward (`lib/navigation-history.ts`, `hooks/useNavigationHistory.ts`)
- Browser-style back/forward over visited chat views (sessions + the new-chat
  composer), in-memory per page load. It is **omp-web's own stack**, never the
  browser History API — the app only ever `router.replace`s `?session=`, and
  the real history stack belongs to the mobile back-gesture / exit-guard
  machinery (`useSidebarHistory` + the popstate bridge).
- AppShell records views from one effect keyed on
  `(selectedSession?.id, selectedSession?.cwd, newSessionCwd)`: recording the entry the cursor
  already sits on is a no-op, which is what makes back/forward
  self-suppressing — `navigateInHistory` commits the step, the view lands, the
  effect re-records the target, nothing is pushed. Any other view change
  (sidebar/palette select, new chat, session created, fork, project-switch
  close) pushes normally and truncates the forward branch, browser-style.
- Applying a step: peek → resolve the session id via `/api/sessions` →
  commit + `handleSelectSession`, or `handleNewSession` for new-chat entries.
  A dead id (deleted session) drops that entry and tries the next one in the
  same direction; a failed list fetch aborts without dropping. A view change
  during the await (versioned ref) aborts the navigation so a slow fetch
  never yanks the chat away.
- Shortcuts live in `useGlobalKeyboardShortcuts`: ⌘[/⌘] (macOS standard),
  Alt+←/Alt+→ (Windows/Linux standard; on macOS Alt+Arrow stays free — it is
  word-wise caret movement), plus the mouse back/forward buttons
  (`BrowserBack`/`BrowserForward`). The keystroke is always swallowed while a
  handler is registered — an exhausted stack stops dead rather than falling
  through to the browser's own back/forward, so the app is never backed out
  of by accident — and shortcuts are skipped entirely while a
  `[role="dialog"]` modal is open. The sidebar header buttons (before Archived
  Sessions, wrapped in `.sidebar-nav-buttons`) disable on stack bounds, show
  the platform shortcut in their tooltip, and hide below a 250px sidebar via
  the `.sidebar-shell` container query (the keyboard shortcuts still work).
- Local deltas vs upstream: the header row also carries the
  `BackendStatusButton`, which is why the container-query breakpoint is 250px
  (upstream tuned 240px) — the nav pair drops out one icon-width earlier; and
  on mobile the full-width right workbench is closed when a step is applied
  (`setRightPanelOpen(false)` in `navigateInHistory`), so the chat switch is
  actually visible instead of landing behind the panel.

### File access allow-list
- `/api/files` is not a general filesystem browser. `workspace-roots.ts` discovers
  that daemon's sessions/projects, explicit validated grants, scratch directories
  and instruction roots. Reads and watches share explicit-root authorization;
  session references grant reads only, not listing or writes. Credential exclusions
  apply to canonical targets too.
  Credential ownership checks resolve configured symlinks even when the final target is missing, without collapsing native `link/..` traversal. Profile config roots visible in a requested or canonical path remain protected when `profiles/` cannot be listed. Compare inode identities through original configured paths, not only potentially lossy string realpaths.
  Record failures inspecting requested paths separately from owned credential directories and files. Known-secret matches remain denied first. Otherwise, a requested metadata failure terminates that operation with 404 `file_not_found`, even if a later lookup would succeed; never continue with an unclassified path. If the request metadata is sound but ownership metadata is unavailable, return 503 `credential_policy_unavailable` until it is accessible. Missing paths remain ordinary absence. Never change user filesystem permissions automatically.
  Read owned directory entries and unresolved symlink targets as bytes: an undecodable protected filename, profile or target makes ownership metadata unavailable, while unrelated byte-named assets do not. For missing macOS targets, account for Unicode normalization and calibrate case aliases through existing directory metadata without creating files or crossing filesystem devices. This is not a portable filesystem-equivalence guarantee: prospective aliases on Linux casefold mounts and legacy HFS+ ignorable-character rules lack native coverage.
- Successful selection, default cwd and worktree operations grant roots on the
  owning daemon. Browsing alone grants nothing. Main's `getAllowedFileRoots()`
  remains for the unrelated local config/import/skills readers, not workspace APIs.
- The Explorer's `type=list` hides nothing by name and there is no "show hidden" switch (no ignore lists here or in `/api/file-index`, which follows `.gitignore` in a Git repo and otherwise indexes regular files under its caps, skipping symlinks to both files and directories; when `git ls-files` fails it falls back to that walk, ignored files included). The tree sends `&root=<its cwd>` to the owning daemon: the listed directory's realpath must be inside the root's realpath (403 `outside_root`, also for an unknown or relative root; the root needs no allow-list check of its own, since the listed path already passed `authorizeFileAccess` and a root can only narrow it), and each symlink entry gets `linkTarget` (raw `readlink`) and, when it leaves the root or dangles, `outsideRoot: true` (the UI dims it and will not expand or open it; `flattenVisibleRows` never descends into a flagged dir). This limits the tree only; `read`/`download` keep the allow-list and session-reference rules.
  The non-Git index walk uses asynchronous directory reads so other daemon requests can progress during a scan. Preserve breadth-first ordering, the existing depth/file/directory caps, truncation reporting and shared in-flight scans when changing this path.
- The Explorer calls the additive daemon capability `listFilesInRoot(input, root)`. Missing capability returns 501 `workspace_unsupported` with upgrade advice; never fall back to an unconfined listing. Keep the original `listFiles(input, showHidden: boolean)` wire contract for older web servers; it validates the flag but follows the current all-names listing policy. Both operations share one daemon-side listing implementation.
- The session-id → file path cache (`cacheSessionPath`, `lib/session-reader.ts`) on main is filled by main's own scans and by wrappers on the local host; it only serves the readers listed under "Session list caching".

### Explorer listing policy
- The Explorer's `type=list` hides nothing by name and there is no "show hidden" switch (no ignore lists; `/api/file-index` follows `.gitignore` in a Git repo and otherwise indexes regular files under its caps, skipping symlinks to both files and directories; when `git ls-files` fails it falls back to that walk, ignored files included). The tree sends `&root=<its cwd>` to the owning daemon: the listed directory's realpath must be inside the root's realpath (403 `outside_root`, also for an unknown or relative root; the root needs no allow-list check of its own, since the listed path already passed `authorizeFileAccess` and a root can only narrow it), and each symlink entry gets `linkTarget` (raw `readlink`) and, when it leaves the root or dangles, `outsideRoot` — the row is dimmed, with no expand or open from the tree. `flattenVisibleRows` never descends into an `outsideRoot` node, so a listing read before the flag cannot keep rendering stale children.
  The non-Git index walk uses asynchronous directory reads so other daemon requests can progress during a scan. Preserve breadth-first ordering, the existing depth/file/directory caps, truncation reporting and shared in-flight scans when changing this path.
- The Explorer calls the additive daemon capability `listFilesInRoot(input, root)`. Missing capability returns 501 `workspace_unsupported` with upgrade advice; never fall back to an unconfined listing. Keep the original `listFiles(input, showHidden: boolean)` wire contract for older web servers; it validates the flag but follows the current all-names listing policy. Both operations share one daemon-side listing implementation.
### Session list caching — new sessions must appear immediately
- The sidebar and command palette list sessions per host: `listSessionsAllHosts()` (`lib/hosts/session-index.ts`) calls each host's `listSessions` op and caches it 30 s per host (`LIST_TTL_MS`, the daemon's own TTL). **This machine's list is its daemon's**; a host that fails or is offline keeps its last list. Nothing on main parses session files to build it.
- **A lookup miss is not deletion while any host's list is unavailable.** `hostForSessionId()` returns no host only after successful current-generation discovery across all registered hosts; offline or failed-refresh lists produce retryable 503, including a cold remote cache after main restarts while the local daemon is already online. Cached positive mappings remain usable. Outbox acceptance retains validated messages during unknown ownership and normal host-hello dispatch resolves them later; never guess a local owner or trust a caller's host hint.
- The daemon's `listSessions` is `listAllSessions()` (`lib/session-reader.ts`): a 30 s TTL list cache plus an mtime-keyed directory walk in `lib/omp/session-files.ts` (`listSessionFiles`), both in the daemon process.
- The walk cache keys on the **sessions root** mtime. On Windows/NTFS a new
  `.jsonl` inside an existing project subdirectory does NOT bump the root
  mtime, so the walk stays stale indefinitely.
- `invalidateSessionListCache()` (fired on `agent_end`, `session_info_update`,
  compaction, renames) must therefore ALSO clear the walk cache via
  `invalidateSessionFileListCache()` — never add a session-mutation path that
  forgets this. Regression test: `session-reader.test.mjs`.
- A mutation that main triggers calls `invalidateLocalSessionLists()`: it clears main's per-host entry and sends the daemon `invalidateSessionLists` (the daemon runs the invalidation above). A route that changes this machine's session files and does not call it leaves the sidebar stale for up to 30 s.
- **Still read on main, from this machine's own files:** transcript search (`session-content-search.ts`, `/api/sessions/search`), the session watcher (`session-watcher.ts`), archive list/restore, import, usage (`usage-db.ts`), subagent history and local file-reference readers. Their main-side session caches are invalidated separately. Workspace shell-output authorization and bytes now come from the owning daemon; new remote-capable readers must use the host seam.

### Copilot-style diff viewer (`lib/diff-model.ts`, `components/diff/DiffViewer.tsx`)
- All three diff surfaces (the Git Graph panel's diff pane, the right panel's
  Git tab, and FileViewer's git-diff mode) render through ONE viewer: VSCode-agent
  file header (icon, name + dimmed dir, `+N −N`, copy/open, Viewed), split and
  unified layouts ("Inline view", split from ~560px container width, toggle
  persisted), line wrap ON by default, per-side line-number gutters,
  word-level highlighting on changed line pairs (token LCS, 2000-char guard)
  and progressive "N hidden lines" bars (20/40/all) that reveal the REAL
  hidden content.
- The model parses a unified diff into hunks plus gap regions; gaps materialize
  from the real file versions fetched once per file through
  `/api/git/diff?...&contents=1` (without contents the bars stay inert). Split rows are
  built once per row with left+right cells sharing the row index, so the panes
  align line-for-line; a rows block's grid rows are offset by `renderFile`'s
  cursor so a hunk separated from the previous block by a bar cannot overlap it
  (regression tests in `components/diff/DiffViewer.test.mjs`).
- DELETED files are diffable on the contents path too: containment falls back
  to the deepest existing ancestor (`isPathWithinRootsAllowingMissing`), and
  the patch comes from `git diff HEAD` with the old side from HEAD
  (`getDeletedFileDiff`) — the no-contents default stays `supported:false`
  for deletions (frozen by `lib/git-changes.test.mjs`).
- rsh appends a trailing `"\n"` to every processed line inside the deepest token
  span; `stripTrailingNewline` must recurse into nested children — a shallow pop
  leaves it and renders every row two lines tall.
- The word shade paints differently per wrap mode: wrapped rows (the default)
  get REAL `<span>` chips painted inside the syntax-token tree
  (`paintWordRanges`) — the `ch`-unit gradient positions against the whole
  multi-line box, so it would sit on the wrong text once a row wraps; turning
  wrap off restores the single-line `ch` gradient. Both paths are pinned in
  `DiffViewer.test.mjs` (`[data-diff-content]` marks the content span).
- The right panel's Git tab renders NO own file row under the diff: the status
  label, the @mention action and open/copy all live in `DiffFileHeader`
  (`statusLabel`/`statusColor`/`headerExtra` props), so both git surfaces
  share one file header.
- Per-file `+N −N` comes from numstat augmentation in `/api/git/status`
  (`lib/git-types.ts` `added`/`deleted`); the viewer header falls back to
  patch-parsed stats when the status row has none.
- Viewed state persists in localStorage keyed by cwd + file + the new content's
  hash, so editing the file clears it.

### Iframes freeze window-level drags (`lib/drag-frames.ts`)
- An iframe swallows `mousemove`/`mouseup`, so ANY drag tracked on
  `window`/`document` (sidebar rail, right-panel rail, git-graph and terminal
  dividers, sidebar section resizers, chat minimap) FREEZES the moment the
  pointer enters an iframe — the embedded Git Graph webview or the browser
  tab. Every such drag MUST call `setFrameDragGuard(true)` at start and
  `(false)` at end (unmount cleanups included); it toggles
  `body.omp-drag-resizing`, and `globals.css` turns off pointer events on all
  iframes while it is set.

### Embedded Git Graph engine (`vendor/vscode-git-graph/`, `lib/git-graph/`, `app/api/git-graph/`, `app/gitgraph/`)
- The Git graph bottom panel (`components/GitGraphModal.tsx`) hosts the **vendored upstream Git Graph webview** in a same-origin `<iframe src="/gitgraph?repo=<cwd>">` instead of a re-implementation: full right-click context-menu operations, dialogs, find widget, settings, commit details, and the canvas/SVG graph renderer come from upstream unchanged. It docks at the bottom of the workspace column like the terminal drawer (its only display mode — no overlay setting): the top-bar / mobile-menu button is a toggle (`aria-pressed`), the height is drag-persisted (`omp-web:git-graph-panel-height`) and the expand/collapse state is localStorage-persisted (`omp-web:git-graph-expanded`). AppShell keeps the host element mounted with `display: none` while closed, but `GitGraphModal` itself returns null while closed, so the iframe DOCUMENT unmounts on every close: a reopen boots a fresh document whose view state the bridge restores from localStorage — and every `ompweb-gg-ready` MUST re-push the live theme (the theme-push effect keyed on `frameLoaded` alone cannot re-run on reopen: the component's state survives the close, so `frameLoaded` never flips false→true again and the fresh document would keep its light-fallback defaults).
- **Front-end**: `vendor/vscode-git-graph/web/` + the ompweb-authored `ompweb-bridge.ts` (replaces the VS Code webview host: `acquireVsCodeApi()` → fetch bridge to `POST /api/git-graph`, view state → localStorage, host hand-offs → parent relay). Build with `npm run git-graph:build` → `public/gitgraph/gitgraph.{js,css}` (COMMIT the outputs; never edit them — edit vendor sources + rebuild). The vendored files carry only the seams listed in `vendor/vscode-git-graph/README.md` — keep that table current on every upstream refresh.
- **Page route** `app/gitgraph/route.ts` serves the webview document with the injected `initialState/globalState/workspaceState/ompwebGgBoot` globals (same shapes as upstream `getHtmlForWebview`). It sets its own `X-Frame-Options: SAMEORIGIN` + `frame-ancestors 'self'` CSP; next.config.ts's global header rule excludes the exact `/gitgraph` path (config headers would overwrite the route's and break framing).
- **Server**: `lib/git-graph/dataSource.ts` is a port of upstream `src/dataSource.ts` (method-for-method parity, spawn timeouts added); `app/api/git-graph/route.ts` mirrors upstream `baseGitGraphView.respondToMessage` command-for-command. Every request's `repo` is re-validated against the allowed file roots (same pattern as `/api/git/status`), and mutating commands must invalidate the git read cache for the repo.
- **Bridge ↔ host protocol** (iframe ↔ GitGraphModal): `ompweb-gg-ready` / `ompweb-gg-open-file` / `ompweb-gg-open-diff` upstream; `ompweb-gg-theme` / `ompweb-gg-*-result` downstream. The parent pushes the live theme (CSS custom properties incl. the `--git-graph-color0..11` lane palette — `web/graph.ts` renders lanes through CSS vars) and answers file opens by routing to the app's FileViewer tab; diffs render in the panel's diff pane via `client.git.refDiff`/`commitDiff` (never a direct fetch — the client-API inventory audit rejects it).
- **Diff modes** on `/api/git/diff`: working tree (`path`), commit-vs-parent (`hash`+`file`), and ref compare (`from`+`to`+`file`, `to="*"` = working tree) — the compare mode's refs pass `isSafeGitRef` + `git rev-parse --verify` before reaching `git diff`.

### Git health and background polling
- **The GitGraph workspace probe** (`hooks/useGitWorkspace.ts`, `AppShell`'s top-bar button) distinguishes an
  ANSWER from a FAILURE. `/api/git/status` runs on the owning host behind the workspace-root authorization gate
  (`authorizeWorkspaceDirectory`), so it answers 403 for a folder the daemon has not authorized, 503 while the host
  link is down, and an error for a folder that no longer exists — none of which says anything about git. A failed
  probe therefore leaves `isRepository: null` + `unavailable: true`: the button stays disabled but reads "Git status
  unavailable", and the probe retries with backoff (2 s → 30 s, 5 tries; a cwd change restarts the budget). Mapping
  every non-2xx to `false` is what made a perfectly good repository show "This workspace is not a git repository".
  Pinned by `hooks/useGitWorkspace.test.mjs`; the retry tick is separate from the attempt counter so clearing the
  count on a recovered answer cannot re-trigger the probe.
- Read-only git failures (`git_status_failed`, `git_branches_failed`, `git_diff_failed`) are fired automatically by background polling (composer bar, Git tab, sidebar badges all poll `/api/git/status` every 5 s) and their failure is always visible at the point of use (empty bar, inline panel error). They therefore MUST NOT degrade app health or appear in the diagnostics error list — `lib/git-nonrepo.ts` `filterBenignGitEntries()` is applied in both `healthOf` and the BackendDiagnostics views so the badge and the list can never disagree. Write operations (checkout/commit/push) are explicit user actions and still degrade.
- The pollers' `git diff/status` children refresh the index stat-cache and briefly hold `.git/index.lock`, so index-writing commands (`git commit`, `reset`, `add`, `read-tree`) can fail transiently with "index.lock: File exists" while a dev server is serving this repo. It is NOT a stale lock: retry (a short sequence rarely collides twice), and never delete the lock while a live git child exists (the pollers appear under the next-server pid). A `set -e` multi-step git sequence stops mid-sequence on a collision with the next step's tree already staged — inspect `git log`/`git status`/`git write-tree` and finish only the remaining commits, never re-run the whole script.
- The raw backend-error ring keeps git read entries (the diagnostics report is a support artifact where git noise is informative) — do not "clean" them out of the ring.
- The routes skip `recordBackendError` for non-repo workspaces (`isNonRepositoryError`, `not_a_git_repository` code / "Not a Git repository" message) so a plain folder can never land an entry in the ring.
- Single-file diff (`/api/git/diff`, `getGitFileDiff`) classifies the file with a **scoped** `git status --porcelain=v1 -z --untracked-files=all -- ':(literal)<path>'` (~250 ms) instead of a full-tree status scan (2.6–13 s on a 3 GB repo), which made every file click in the Git tab feel like the diff would never load. The scoped result is authoritative except for index status `A` (staged new file) — only a full scan can pair a rename target with its original path — so the classifier falls back to the full scan in that one case (`lib/git-changes.test.mjs` pins the staged-rename case).
- Client git pollers (`useGitStatus`, `useGitStats`, `GitChangesPanel`) carry an in-flight guard: never stack a new poll round while the previous one is still running — a slow repository outlives the 5 s interval and stacked rounds saturate the host and turn every git call into a timeout.
- Server side: `getGitStatus` runs its four post-status calls (branch/upstream/counts/shortstat) concurrently (`Promise.all` in `lib/git-changes.ts`), and every git call runs in its own short-lived `git` child process with a timeout, so a slow repository call cannot block other routes.

### Chat scroll-follow
- `useAgentSession` follows the conversation: the effect depends on both
  `messages` (boundaries) and `streamState` (every token batch) and throttles
  to one `requestAnimationFrame` while a run is active (`followScrollFrameRef`).
- A manual scroll-up sets `completionScrollAllowedRef = false` and disables
  following until the next prompt; `scrollUserMsgToTop` handles the
  pending-scroll after sending.
- The ResizeObserver on the chat scroller (`ChatWindow`, the viewport-seeding
  effect that keeps the virtual window informed) also re-pins: when the
  scroller changes height (phone keyboard, composer or ask panel growing) a
  reader whose PREVIOUS view reached the bottom stays there — judged by the
  previous height, so content that grew below the reader (an expanded tool
  call) does not count as being at the bottom. The effect is gated on
  `isEmptyNew`: the empty new-session screen owns a different scroller, and
  the conversation scroller mounts after the first send without a remount or
  a load, so the flag must be a dependency for the observer to attach.
- Expansion/collapse growth follows too: opening a row or a Process-details
  group changes no message/stream state and fires no scroll event — it
  reaches React only through the group-height measurement
  (`layoutRevision`). A ChatWindow layout effect re-pins the viewport to
  the new bottom while it was pinned within the hook's 24px tolerance (a
  stale-true pin means the growth was BELOW the fold; growth above shifts
  scrollTop via scroll anchoring, whose scroll event clears the pin), so
  many expand clicks near the tail never lose the end of the conversation
  and readers scrolled up are never yanked.
- Programmatic smooth scrolling must respect `prefers-reduced-motion`
  (`usePrefersReducedMotion` in `hooks/usePrefersReducedMotion.ts` — also the
  only way to stop SVG SMIL animations, which CSS cannot).
- A jump to a sidebar search hit calls `holdScrollPosition()` (`useAgentSession`):
  it marks the initial scroll done and stops following, as a manual scroll-up
  would, so the next frame does not pull the reader back to the bottom.

### Search hits in the chat (`/api/sessions/[id]/matches`, `hooks/useChatSearchHighlights.ts`)
- While the sidebar search has a query, each session row's chevron lists its
  hits (`SessionSearchMatches`, 10 at a time). The server ranks hits of the
  active conversation's user text and assistant text blocks (quality, then
  newest message) and builds snippets for the returned hits only. "Load more"
  asks for a longer prefix (`limit`), never an offset: a running session
  re-ranks between requests, so offsets would repeat or skip hits.
- A hit is addressed as `(entryId, ordinal)`: its index among that message's
  hits, counted per rendered text node in rendered order on both sides. The
  server (`lib/session-match-listing.ts`) parses each body that has a hit in its
  source (a user message's text blocks joined with `\n`, each assistant text
  block separately) with the chat's remark parser and counts in text, inline
  code and code nodes; link targets, image alt text, raw HTML and math render
  no searchable text, and footnote definitions come last in reference order.
  The chat counts in the rendered `[data-message-text][data-entry-id]` text,
  skipping code-block headers, buttons, line numbers, KaTeX, Mermaid notes,
  table charts and generated footnote labels (`NOT_MESSAGE_TEXT`). New chrome
  inside message text must be excluded there too, and new markdown syntax
  that renders text must be counted in `renderedTextNodes`, or later ordinals
  shift. Known gaps: a phrase across syntax-highlighting tokens or a linked
  `#123`/`agent://` ref, and block-level raw HTML; the jump then lands near it.
- Painting uses the CSS Custom Highlight API (`omp-search`,
  `omp-search-current` in `globals.css`), repainted on DOM mutations; browsers
  without it still jump. A jump widens the lazy render window
  (`revealMessage`) first. Each click is a new target object used once:
  `onSearchTargetHandled` drops it in AppShell, so reopening the session later
  does not jump again. AppShell also drops a pending target when the query
  changes or another session opens, and the hook drops one whose entry the
  loaded branch lacks. An empty query clears the highlights and the target.

### MCP configuration (`lib/omp/mcp-config.ts`, `/api/mcp`, `components/McpConfig.tsx`)
- Project MCP config resolution order: `.omp/mcp.json`, `.omp/.mcp.json`,
  `mcp.json`, `.mcp.json` at the git top level (falls back to cwd for
  non-git dirs). Server definitions support `stdio`, `http`, and `sse`;
  exactly one of `command`/`url` is required and validated before any write.
- Writes are atomic (temp file + rename), preserve unrelated top-level keys
  (`disabledServers`, `$schema`, ...), and support rename via `previousName`.
- The MCP settings live in their own Settings tab (`SettingsTabs` id `"mcp"`,
  workspace-gated). Server list rows show a config-derived status dot
  (valid+enabled / disabled / invalid) — no live-connectivity probe exists in
  the RPC protocol, so failures surface as toasts (`toast.error`) from the
  editor actions, not inline text.
- The endpoint is guarded by the same allowed-root rules as `/api/files`.
### Browser tab — proxy-default iframe (`components/panels/RightWorkbench.tsx` BrowserView)
- The Browser tab has two modes; **proxy is the default**. "proxy" loads
  `/api/browser-proxy?url=…` in a sandboxed same-origin `<iframe src>`
  (`sandbox="allow-forms allow-modals allow-popups allow-scripts"` — no
  `allow-same-origin`); "direct" loads the target URL in an `<iframe src>`
  (full JS, own origin, but blocked by X-Frame-Options / CSP frame-ancestors
  on many sites — the "blocked" overlay offers the switch to proxy).
- The proxy route (`app/api/browser-proxy/route.ts`) fetches the page
  server-side, injects a `<base href>` (relative scripts/styles/fetches
  resolve against the original origin), and returns the HTML with a
  **permissive per-response CSP** (`script-src`/`style-src`/`connect-src`/
  `base-uri`/`img-src`/`font-src` allow `https: http:`). That header is what
  makes proxy mode JavaScript-compatible: the sandboxed iframe has an opaque
  origin, so `'self'` matches nothing, and the inherited app CSP
  (`script-src 'self' …`) would refuse every external script/stylesheet —
  the "partly loaded" pages. The permissive policy is scoped to the proxy
  response; the app's own CSP stays strict. Proxy errors (400/413/502) render
  a styled in-iframe HTML page, never raw JSON.
- `next.config.ts` global header rule must exclude `/api/browser-proxy`
  (`source: "/((?!api/files/)(?!api/browser-proxy).*)"`): config-level headers
  overwrite route-handler headers, so without the exclusion the global
  `X-Frame-Options: DENY` (and the strict app CSP) would be stamped on the
  proxy response and the iframe would refuse to frame it.
- Known proxy limits: the document origin is opaque, so `window.location` is
  the proxy URL and `localStorage`/`sessionStorage` are unavailable; page JS
  that builds absolute URLs from `window.location.origin` (or whose
  cross-origin fetches need CORS headers the site doesn't send) won't fully
  work — "Open externally" covers that case.
- Cross-origin framing for direct mode requires `frame-src 'self' http: https:`
  in the app CSP (`next.config.ts`); `frame-ancestors 'none'` (the app can't be
  framed) is independent.
- A `loading` overlay (`role="status"`) covers the frame until `onLoad`. A site
  that refuses framing in direct mode renders blank — the empty-state note
  (`rightWorkbench.browserFrameNote`) and the "Open externally" button cover
  that case.

### Plugins and skills
- `/api/plugins` shells out to the user's `omp plugin` CLI (`list/install/uninstall/enable/disable/upgrade`, `--json` where available) — never the Bun-only SDK.
- `/api/skills` lists through `lib/skills-service.ts`, which execs `omp skill list --json` with the project as the process cwd (omp ≥ 18.3.3; never pass the directory as an argument — Windows `.cmd` launchers run through `cmd.exe`, which would interpret `&` in it). That is the same discovery sessions use, including `namespace/name` collision aliases and plugin/registry/custom-directory skills. A pure-Node replica scan (project `.omp/skills` walk-up, `~/.omp/agent/skills`, the `.claude` / `.agent(s)` / `.codex` / `.github` compat dirs, managed skills) is only the fallback for older binaries and failed or malformed output. A failed run is negative-cached per binary fingerprint **and cwd** (5 min) so old installs don't spawn per request while one broken project config cannot degrade the others. Listing runs omp's normal startup, so it has omp's side effects (e.g. omp renames an unparseable `config.yml` aside, as a session would).
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives. omp reports it back as `hide` (it reads `hide`/`disableModelInvocation`/`disable-model-invocation`). Frontmatter is omp's only per-skill "hide from model, keep `/skill:`" knob; `disabledExtensions: ["skill:<name>"]` removes the skill entirely.
- Only user-owned skills are togglable: `getSkillToggleRoots()` (allowed file roots — workspaces the user opened — plus replica scan roots) is the single allowlist for both PATCH and the `togglable` flag GET returns; it is the pre-CLI allowlist, unchanged. Skills omp lists from anywhere else (the plugin cache, registry installs, custom directories outside a workspace) render a disabled toggle — their files belong to an installer and an update would discard the edit. Never widen PATCH to whatever omp lists.
- `/api/skills/install` shells through `npx skills add ... --agent universal`, which installs into the ecosystem-standard `.agents/skills` dirs omp reads; project installs run with the selected cwd.

### Updates: web server versus host software
- Automatic in-app self-updating of the web server has been removed in favor of explicit user notifications and manual terminal commands. **Settings → System** owns the web server's own application update and settings only.
- `GET /api/app-update` queries the npm registry for `@Splinterjke/ompweb` updates, detects the install manager (`bun` vs `npm` via `detectInstallMethod`), and returns `updateAvailable` plus the exact terminal command (e.g. `npm install -g @Splinterjke/ompweb` or `bun add -g @Splinterjke/ompweb`). A binary install links the release download page instead.
- **Settings → Hosts** owns each machine's ompweb daemon and OMP runtime, including **This machine** (`components/HostUpdates.tsx`). `GET /api/hosts/[id]/updates` checks on that daemon; `POST {target, version}` starts its update. Offline hosts and older daemons return explicit failures, never fall back to checking or updating the web server.
- The hub supplies its supported protocol range to the `checkUpdates`/`updateSoftware` host ops (`lib/hosts/updates.ts`, `lib/hosts/update-types.ts`). Both the hub and the daemon (`lib/hosts/update-worker.ts` is the host-side install/restart helper) reject an unknown or incompatible candidate protocol before installing ompweb; the update stays visible with a blocked reason. OMP runtime updates do not change the link protocol.
- A daemon update is refused while it owns session processes (subagents included); the daemon also refuses new spawns while an update is running. Check completion through the durable operation state after reconnect, not the POST's acceptance alone. An OMP update leaves already-running sessions on their loaded runtime.
- `POST /api/omp-update` (`action: "check" | "update" | "restart"`) remains an explicit server-side maintenance API for existing callers; the `update` stream still ends with the `{type:"done", exitCode}` frame and `controller.close()`. The settings UI and AppShell no longer use it as a global update control, and AppShell no longer announces an "OMP update available" toast.
- Notifications in `AppShell` and the settings cards present the web-server update notification alongside the copyable terminal update command.

### Auth and model config
- Auth flows go through RPC commands (`get_login_providers`, `login`) against the omp child process; credentials live in omp's `agent.db` (SQLite) which omp-web never touches directly.
- The Models panel reads and writes `models.yml` in the omp agent directory (`~/.omp/agent/models.yml`, `.yaml` fallback).
- API-key status endpoints must never return the raw key.
- The Native registry card shows a **Compaction limits** section (`compaction.modelThresholds`,
  omp >= 18.8.5): token points (`120k`/`1.5m`) and `NN%` thresholds resolved against
  the model's context window (`lib/compaction-point.ts`), invalid values surfaced in
  red, plus the global default from `thresholdTokens`/`thresholdPercent`. It's an
  exported `CompactionLimitsSection` in `components/ModelsConfig.tsx` for row-level
  tests; `lib/omp/settings-config.ts` additionally reads `worktree.base` (read-only
  surface — omp owns that knob).

### Automation tasks — script + prompt schedulers (`lib/scheduler-store.ts`, `lib/scheduler-engine.ts`, `/api/schedulers`)
- The sidebar "Automation tasks" panel (renamed from "Script schedulers") has two
  tabs: **Scheduled scripts** (terminal icon) and **Scheduled prompts** (chat icon).
  Entries share one store, `~/.omp/agent/schedulers.json`, and are distinguished by
  `kind: "script" | "prompt"` (absent = script, backward compatible).
- **Script entries**: `{ name, kind, script, args[], schedule, enabled, timeoutMs }` —
  `scriptRunner()` (`scheduler-store.ts`) decides how the path is launched: `*.sh|.bash|.zsh`
  run through bash; on Windows `*.ps1` runs through `powershell.exe -NoProfile -ExecutionPolicy
  Bypass -File` and `*.cmd|.bat` through `cmd.exe /d /c`; anything else is spawned as the image
  the user named. The engine builds that argv in `scriptInvocation()` from the same rule, and
  only the last group needs the executable bit — a Windows script file has no such bit, so
  asking for one would reject the seeded `ompweb.ps1`.
- **Prompt entries**: `{ name, kind: "prompt", prompt, provider?, modelId?,
  thinkingLevel?, cwd?, noSession?, clearContext?, compactContext?, schedule,
  enabled, timeoutMs }`. `name` is REQUIRED for prompts (store + API reject an
  empty one with `name_required`; only scripts fall back to a generated name).
  The modal hides the Timeout input for prompts (POST uses the store default,
  PATCH omits the field so the stored value is kept).
  The engine runs `omp -p <prompt>` with the entry's `cwd` when set (a missing
  workspace directory is recreated at run time; only an uncreatable path falls
  back to the default) — otherwise with cwd `~/omp-cwd-YYYYMMDD` (same dated
  default-cwd dir the UI uses for workspace-less sessions) — and keeps only a
  bounded 1 kB output tail in the run log; the model answer is not stored, only errors.
  - **Context handling** (session mode, i.e. `noSession` off): the entry persists
    `sessionId` and resumes it (`--resume`) on every run, so context accumulates
    across runs. `clearContext: true` skips the resume (fresh session each run —
    the print-mode equivalent of /clear). `compactContext: true` (mutually
    exclusive with `clearContext`; enforced in store + UI) additionally passes
    `--config <agent-dir>/scheduler-compaction/compact.yml` (`compaction.thresholdTokens: 1`)
    to force-compaction the resumed context before the prompt. After each
    successful run the engine updates `entry.sessionId` to the session the run
    used/created (`setSchedulerSessionId`), so the next run resumes from there.
  - `provider`/`modelId` map to `--model=<provider>/<modelId>` (or
    `--model=<modelId>` / `--provider=<provider>` alone). The modal dropdowns are
    populated from `/api/models` (`modelList`). The model dropdown stores
    `modelId` **fully qualified** (`provider/id`), so both the engine's spawn
    args and the panel's meta chip route through `modelFlagValue(provider,
    modelId)` in `lib/scheduler-types.ts` — it does NOT re-prefix a `modelId`
    that already starts with `provider/` (that double-prefixing produced
    `provider/provider/model` "not found" errors). Keep the two consumers on
    this one helper.
  - `thinkingLevel` maps to `--thinking=<level>` (absent = no flag = the model
    default). The modal's Thinking select lists the ladder of the selected
    model from `/api/models` `modelList[].thinkingLevels` (`["off", …efforts]`,
    per the settings' Thinking levels) plus an explicit `Default` option
    (stores nothing).
- **Session marking**: `getAutomationSessions()` maps session id → scheduler name
  from prompt run records (`run.sessionId`); `GET /api/sessions` annotates matching
  sessions with `automation: <name>` and `SessionItem` renders a clock icon with a
  "Created by automation task …" tooltip. The run log links the session id
  (panel `onOpenSession` → opens the session in the chat).
- **Default seed** (`ensureSeedSchedulers`, `instrumentation.ts`): the repo's rebuild workflow is
  added at boot as a **Manual launch** scheduler (`schedule: { kind: "manual" }`, 20 min timeout)
  if not already present — idempotent and best-effort (an install without the workflow script is a
  no-op). `rebuildSeedSpec(cwd, platform)` picks it per platform: the container flow
  runs `<cwd>/ompweb-rebuild-restart.sh`; on Windows that script cannot run (`python3`, `setsid`,
  `/proc`), so the seed stores `<cwd>\ompweb.ps1` with `args: ["rebuild"]` and the engine supplies
  the interpreter at run time (`scriptRunner`/`scriptInvocation`) — the entry then names the very
  script the user sees, edits and deletes, and that path is what the create/PATCH existence check
  looks at. Skipped when **any** entry already carries the seed name:
  repointing the entry by hand must not make the next boot add a second "OmpWeb Rebuild & Restart".
  A run of the rebuild task is a self-bounce — the child dies with the server it stops, so its run
  record is not persisted; `run-server.log`'s `OK:` line is the proof it worked.
  triggers them via `POST /api/schedulers/[id]/run` (the panel's run button).
  `ensureSeedSchedulers` resolves the script from `process.cwd()` (the dev repo
  root or the `/opt/ompweb` install root), while the engine spawns with cwd
  `path.dirname(script)` — so a seeded script must not depend on the caller's cwd.
- **API** (JSON; 400 with a stable `code` on validation failure — `instructions_required`,
  `context_mode_conflict`, `script_required`, `invalid_schedule`, `invalid_cwd`,
  `name_required`, …):
  - `POST /api/schedulers` — create. Prompt example (`cwd` optional — the workspace
    folder the automation session starts in; POST/PATCH reject a non-existent,
    non-creatable path with `invalid_cwd`, and PATCH `{"cwd":""}` clears it back to
    the dated default):
    `{"kind":"prompt","name":"Daily commit review","prompt":"Review commits from the last 24 hours and summarize likely bugs and fixes","provider":"anthropic","modelId":"claude-opus-4","cwd":"/work/myrepo","schedule":{"kind":"daily","hour":9,"minute":0},"timeoutMs":600000}`.
    `schedule` uses the same spec as scripts (`manual | interval | daily | weekdays | weekly | cron`).
  - `PATCH /api/schedulers/[id]` — any subset of the entry fields.
  - `GET /api/schedulers` — `{ schedulers: [...], engineStartedAt }`; entries carry
    `kind`, the prompt fields, `sessionId` (persistent session) and `runs[]`
    (each run has `status`, `sessionId` for prompt runs, stdout/stderr tails).
  - `POST /api/schedulers/[id]/run` — immediate manual run (409 while one is active).
  - `POST /api/schedulers/[id]/clear-runs` — empty the run history.
  - `DELETE /api/schedulers/[id]`; `POST /api/schedulers/preview` (human + nextRunAt
    for a spec); `POST /api/schedulers/validate` (script path check).
- **Creating a prompt automation from an agent session** (loopback, no password gate):
  ```bash
  curl -s -X POST -H 'Content-Type: application/json' \
    -d '{"kind":"prompt","name":"Daily commit review","prompt":"Review commits from the last 24 hours and summarize likely bugs and fixes","schedule":{"kind":"daily","hour":9,"minute":0},"cwd":"/work/myrepo"}' \
    http://127.0.0.1:30178/api/schedulers
  ```
  With the `OMP_WEB_PASSWORD` gate enabled, log in via `POST /api/web-auth/session`
  first and pass the `omp_web_session` cookie (see "Web password gate" above).
  Omit `cwd` to run in the dated default workspace. The modal's **Workspace**
  dropdown is populated from `GET /api/projects` (alias — path labels); a run's
  sessions land in that workspace's project group in the sidebar.

### Chat event actions (`lib/chat-event-action*.ts`, `/api/chat-event-actions`)
- Named actions fired on 10 chat lifecycle events (`conversation_completed`,
  `conversation_interrupted`, `assistant_text`, `thinking_completed`,
  `subagent_completed`, `user_prompt_sent`, `provider_api_error`,
  `task_completed`, `context_compacted`, `question_asked`). Action types:
  `notification`, `http`, `bash`, `scheduled` (triggers a manual script
  scheduler). `task_completed` fires when the agent's `todo` tool transitions
  at least one task to `completed` (detected by diffing `get_state.todoPhases`
  snapshots in `lib/todo-completion.ts` — the tool arguments are stringified
  JSON and the `tool_execution_end` frame carries none). `question_asked`
  fires on `tool_execution_start` for the `ask` tool; the question text (from
  the frame's `args.questions[].question`) is handed to actions as `$question`.
  Action bodies may also use `$event_name` — the localized display name of the
  firing event — resolved server-side by `translateEventName()` in
  `lib/ui-locale.ts`. The client's "Switch language to" choice is synced to
  `PUT /api/ui/locale` (by `LanguageSwitcher` on load and change); the server
  keeps it in `globalThis.__ompUiLocale` and persists it to
  `~/.omp/agent/ui-locale.json` so the choice survives restarts (default `en`).
- Persistence mirrors the scheduler store: atomic temp-file + rename at
  `~/.omp/agent/chat-event-actions.json`. `loadActionsForEvent(type)` is cached on
  `globalThis.__ompChatActionCache` and invalidated on every save — a new action must
  be visible to the next dispatch immediately, so never add a save path that skips the
  cache invalidation.
- **Dispatch lives in `rpc-manager.ts` `handleFrame`/`send()` — one `dispatchChatEvent()`
  call per frame case.** NEVER add a frame case that matches a chat event without a
  `dispatchChatEvent` call, or the action silently never fires. `user_prompt_sent`
  resets the per-run `provider_api_error` dedupe (`clearChatActionRunState`) so an error
  in a new run fires again; a terminal `agent_end` also clears it.
  An interrupted turn (abort / abort_and_prompt) ends with a terminal
  `agent_end` but does NOT fire `conversation_completed` — the wrapper tracks
  the pending interrupt (`_interruptEndPending`) and skips that dispatch;
  `conversation_interrupted` covers it instead. Background-job resume turns
  (a turn started right after a non-terminal `agent_end`, e.g. after a
  backgrounded bash job finishes) likewise do NOT fire `conversation_completed`
  — `_continuationRun` is set at the resume `agent_start` (from
  `continuationPending`) and consumed by the resume turn's terminal `agent_end`,
  so a job finishing reads as "job done", not "conversation completed".
  Neither flag may leak into a later user-prompted turn: both are cleared on
  `agent_start` (interrupt flag) / restart, and each is consumed by exactly one
  terminal `agent_end`.
  The dispatch itself moved off `agent_end` to the `prompt_result` frame that
  follows it (omp emits both; `agent_end` only arms `_completionPending`):
  when the prompt reports `sessionSettled: false` (omp ≥ 18.5 — background
  work like async subagents or deliveries can still wake the session), the
  completion is held (`_completionDeferred`) until the `session_settled`
  frame, so "conversation completed" never fires while the session can still
  continue. A held completion is flushed by the next `agent_start` if the
  settle never arrives — late, never lost.
- Executors (`chat-event-actions-executors.ts`) never throw — every failure is recorded
  as a `lastRun` (`ok:false` + detail) so the UI can surface it. `scheduled` records
  `"scheduler busy"` when the target manual run is already running (not an error).
- Notification delivery is dual-path: per-session SSE (`chatEventPayload().emitToSession`,
  counts attached listeners) plus a globalThis bus (`chat-event-action-bus.ts`) relayed
  over the `running` event-stream channel. `ok` is true only if at least one
  was delivered; the browser renders it via `AppShell` → `showBrowserNotification` and
  clicking selects the originating session.

### Goal mode (`lib/goal.ts`, `ComposerModeStatus` in `components/ChatInput.tsx`)
- omp ≥ 18.4.11 goal mode: the `goal` RPC (`{type:"goal", op:"get"|"create"|"resume"|"pause"|"drop", objective?}`
  → `GoalResult {goal, state}`) plus the `goal_updated` frame (same payload; fired by the host
  command or the agent's `goal` tool). The single goal surface is the themed composer
  status row (`ComposerModeStatus`): a live native goal takes it over — tracked status,
  omp's elapsed time, optional token readout (Interface & Behavior → "Show token budget
  in goal bar", localStorage `omp-web:goal-token-budget`, default off) and pause/resume/drop
  controls; without a native goal the row keeps the plain web `/goal` marker rendering.
  A drop also clears the sessionStorage marker (the row must not keep showing
  "Goal active" after the native goal is gone).
- The **plan row** on the same `ComposerModeStatus` is state-honest: it shows
  "Planning in progress" only for the live web plan (`activePlan`), and a
  historical plan document as a neutral "Plan document" row with the document
  slug. It renders ONLY when something is openable — `activePlan` or
  `planInfo.planFile` — never on the `plan-reader` marker alone (`planModeActive`
  is a permanent signal by design). Clicking opens the document through
  `onOpenPlan` (AppShell `handleOpenPlan` → plan route → FileViewer tab; the
  route authorizes the session `local/` dir via `allowFileRoot`), so ChatWindow
  MUST forward `onOpenPlan` to `ChatInput`.
- Hydration rides `refreshSubagentRoster`'s refresh points (SSE open, mount, send, reconcile,
  restart) and the first `agent_start`; `POST /api/agent/[id]` answers `goal` + `op:"get"`
  with `{goal:null}` when no child exists (`NO_SPAWN_REPLIES.goal_get`) so background reads
  never spawn a process — mutating goal ops must NEVER join that map (a fake success would
  silently no-op). A `goalGenerationRef` keeps a stale snapshot from clobbering a newer
  `goal_updated` frame applied mid-request.
- Background poll: the per-session SSE stream is only open while a run is in flight, so
  server-side goal changes (the agent's `goal` tool between turns, curl, a TUI on the same
  session) never reach an idle page as `goal_updated` frames. The hook polls the no-spawn
  `goal`/`get` read every 15 s while the tab is visible (`useAgentSession`, keyed on the
  open session) — that poll, not the frames, is what converges the bar on an idle session.
- Web `/goal <objective>` is PASSIVE by design: it sets the sessionStorage marker and sends
  the prefixed instruction — never an implicit native create. Composer attachments never
  bypass a prompt-composing web command: `ChatInput.handleSend` routes `/goal`/`/plan`/…
  with attached images through `onBuiltinCommand(msg, images)` so the hook sends the
  EXPANDED prompt with the images and sets its marker (the old gate skipped the command
  entirely, so the raw `/goal …` reached omp as literal text and no marker was set);
  non-prompt action built-ins keep the raw send with the attachments (never drop them).
  The tracker (continuation loop,
  budget) is armed only by the marker row's explicit "Track natively" control (`trackGoal`,
  `onTrackGoal`); an implicit create silently burned ~10k tokens/minutes on a passive
  wait-for-a-word rule before this split (regression test in `useAgentSession.rpc.test.mjs`).
- Native goal ≠ `activeGoal` (`lib/web-mode-state.ts`): the web marker tracks "this session
  was started with /goal" for the composer hint; the bar shows omp's authoritative tracked goal.

### Composer file uploads (`docs/specs/2026-11-02-file-uploads-design.md`)
- Images and text files go inline while they fit the inline budgets
  (`lib/image-attachments.ts`, `lib/chat-attachments.ts`); every other file,
  an image switched to **As file**, and anything over a budget is uploaded
  (2 GiB per file, 20 per message, `lib/upload-limits.ts`, browser-safe).
  The composer re-checks the inline budget per chip on every render, so an
  image's decoded size comes from `attachedImageBytes` (scanned once per
  image object), never a fresh base64 scan.
- Uploads land in a staging dir on the **session's host** (the daemon), not on
  main: a new chat has no session yet. The prompt command carries
  `uploads: [id]`; `runAgentCommand` (`lib/agent-command.ts`) attaches each
  through the host op `uploadAttach` (hard link into
  `<session dir>/local/uploads/`, never overwriting; copy on EXDEV) and appends
  the "Attached files" block with `local://` URL and absolute path. Ids stay
  registered until the prompt reaches omp, so a retried send reuses the attach.
  Attachment preparation uses the wrapper's pending-command protection too, so
  disconnect and idle cleanup cannot dispose a submitted prompt's session while
  a slow copy is still running. Later commands await the send fence before
  selecting/replacing the wrapper, so Stop and an Advisor change cannot overtake it;
  a command through any registry alias of the same wrapper (`getRpcSessionKeys`)
  waits too. The Attached files block can push a prompt past the host link's
  line cap: the transport then refuses it before queueing with 413
  `request_too_large`, and the uploads stay registered for a shorter resend.
- Bytes are forwarded, never re-encoded: the browser sends binary frames
  `[n][id][payload]` (≤ `pieceBytes`) as `LinkSender` blob units keyed
  `up:<id>`; `lib/browser-link.ts` accepts them only for uploads that link
  started and hands the same bytes to `forwardUploadFrame` (`lib/uploads.ts`) with
  that link's sink; frames are forwarded only while it is the upload's current
  sink, so a WS sender superseded by an HTTP resume or newer start is refused;
  `forwardUploadFrame` queues them as blob units on the host link (link v6; `hostVersion < 6`
  → 426 `host_upgrade_required` on a remote host, `host_restart_required` on
  `local`: an in-place upgrade keeps a running v4/v5 daemon, which is inside
  `[MIN, LINK]`, so "This machine" needs `ompweb-host` restarted). Blob units
  are outside both links' line windows; the worker's per-upload
  `UPLOAD_WINDOW_BYTES` credit, refilled by the daemon's `upload_ack`, is the
  flow control, and main enforces it: a frame putting `sent - received` over
  `UPLOAD_WINDOW_BYTES + pieceBytes` stops the upload with 429
  `upload_window_exceeded` (frames dropped until the next start; the socket
  stays open). Binary frames are not resent: after a browser-link drop or a
  web-server restart the worker re-sends `up_start {id, n, …}` (same id, `n` =
  a worker-wide increasing sequence) and continues from the host's `received` in
  the answer `up_ack {…, start: n}`. Each start has a fresh sink whose progress,
  completion and errors retain `start: n`, including messages already queued
  before a Retry. The worker ignores any mismatched generation before applying
  an ack or error. On main the latest concurrent start wins; earlier starts
  still answer their callers.
  Each host `uploadStart` also carries a fresh UUIDv4 `attempt`; the daemon
  echoes it on progress, completion and error `upload_ack`s. Main discards
  superseded-attempt acks even if they arrive after the newer start's reply.
  Receipt replay and a start of an already-attached upload both require a
  regular-file target; a missing or directory target gets `upload_missing`.
  Receipt publication is atomic, and start/attach/abort controls share one
  per-id queue so an abort cannot be undone by an earlier attach's receipt.
  A start that finds the upload aborted sends
  `uploadAbort` to the host and answers 404 `upload_missing`. A host-link drop
  fails each in-flight upload with 503 `host_offline`. `uploadFile`
  (`lib/event-stream.ts`) resumes 502/503/504 and HTTP network failures by
  itself (same id, back-off restarting after new bytes, chip shows
  "Reconnecting…") until an outage reaches 5 min, timed from its first
  failure; other failures, and a bfcache pagehide (410), show Retry.
  Back-off and in-flight retries share the remaining outage budget; their
  watchdog resets only when acknowledged bytes advance. Expiry aborts the
  HTTP request or sends tab-scoped `up_pause` to stop the worker without
  deleting staged bytes, then settles with `upload_stalled` so Retry is usable.
  Checks after waking and before applying an ack prevent expired work reviving.
  HTTP body-read network errors propagate to the retry classifier (only JSON
  syntax errors use the fallback body). Network `TypeError`s use the existing
  localized network-error explanation in upload chip tooltips.
- Limits on main: at most 32 unfinished uploads per owner (429
  `too_many_uploads`); an unfinished entry idle 10 min (no start, frame or ack)
  is dropped from the registry (a later `up_start` re-registers it). The worker
  fails an upload no start answer or ack advances for `UPLOAD_STALL_MS` (120 s)
  with 504 `upload_stalled` and forgets it without aborting it on the host, so
  the tab's automatic resume continues it. Page navigation settles pending
  WebSocket-upload promises before the worker's `bye`: a composer retained by
  bfcache shows Retry after restoration, not a permanently uploading chip. That
  failure (410) gives the chip a new upload id, so its Retry starts over and the
  old id's pending cancel (worker, HTTP DELETE or host) can never delete it.
  The daemon's `sweep` deletes staged files older than 24 h and aborts open uploads
  idle (no start/write) over 24 h (`STAGED_MAX_AGE_MS`): at start, on every
  `uploadStart`, and every hour (`UPLOAD_SWEEP_INTERVAL_MS`). It never rejects
  (a file it cannot delete is logged and tried again next sweep): a rejection
  from its timer would stop the daemon, and one before `uploadStart` would fail
  every new upload.
  Sent uploads expire by the `uploadRetentionDays` web setting (default 30, `null` = never; `lib/web-settings.ts`, spec U6): main sends it to each daemon with the op `setUploadRetention` at sync startup, on every hello and when the setting changes (an older daemon's 501 is ignored, no protocol bump; other live-link failures retry with capped backoff). The daemon sweeps at startup and every 24 h, deleting regular files older than that by mtime from `local/uploads/` of active and archived sessions, and from only its own namespace under Windows' `<tmp>/omp-local/<id>/uploads/`. It skips symlinked project, session, `local`, `uploads` and namespace directories as checked; concurrent directory swaps are outside this same-user threat model (U6). A running sweep re-reads the policy before unlink, so Never or a longer retention spares remaining files. `uploadAttach` stamps the hard link's mtime at attach time, or copies if stamping fails, so age counts from the send. Staged files keep the separate 24 h expiry and hourly sweep above.
  Only Windows fallback attachments use `local://uploads/<daemon namespace>/<name>`; `uploadOwnerNamespace` derives the namespace from the canonical agent-directory path. Copied session UUIDs cannot share cleanup ownership, and archival/deletion of session metadata does not disable cleanup. Legacy flat files and foreign namespaces are preserved; moving the agent directory leaves the old namespace untouched (U6). This namespace is provenance for retention, not an authentication capability.
  Retention also covers Files-panel uploads placed in those selected session-upload folders; workspace publication receipts do not exempt a destination from its folder's policy.
  Stamp the staged inode before publishing any hard link of it (attach and Files-panel publication), so a concurrent retention sweep cannot capture its old age and delete the newly sent file. If timestamping fails, publish only a fresh exclusive copy; never expose an unstamped hard link. The sweep's per-file `lstat`→`unlink` and every step that puts a file at a name (attach link/exclusive create, publication rename/link) run under `withUploadNameLock` (`lib/hosts/uploads.ts`), so an overwrite cannot land between a stale stat and its unlink. The lock is per daemon process; a different process writing the same folder is not covered.
  `uploadAttach` has a 10-minute op timeout (a 2 GiB EXDEV copy), not
  `opTimeoutMs`.
- Cancels are durable (spec U4 "Durable cancel"): the tab always hands
  `{op: "up_abort", id, host}` to the worker, which keeps it until the server
  has it (link line until acked and resent on a resync; in `sse` mode a
  `DELETE …?host=` with a 40 s deadline, retried until a 2xx or a 4xx other
  than 408/429). Main keeps an `uploadAbort` its host could not take (503/504)
  per host and resends it on that host's next hello (`onHostHello`). A Retry of
  the same id supersedes it on every layer: a new `uploadStart` drops a kept
  abort, an in-flight one that fails after the id is registered again is not
  kept, and the worker drops its own pending cancel on a new upload of the id.
  An id main does not register goes to the browser's `host`
  if known. All of it is in memory: the hourly sweep is the backstop.
- Error codes: composer uploads use `upload_id_conflict` (another upload has
  this id); `upload_conflict` stays the file manager's.
- SSE mode uses the same registry over HTTP (`/api/uploads`). `requestOwner(req)`
  (`lib/web-auth.ts`) still binds upload start, chunks and cancel to the original
  login, and still binds browser-link resume; it is not made stable across login.
  Attachment is also allowed by a server-issued, upload-specific completion proof
  in the same installation/auth scope and within the existing 24-hour lifetime.
  Main stores it privately before reporting completion; completion replays reuse
  it without renewing expiry. Never accept caller-supplied owners or receipts,
  and never send proofs to the daemon/omp, public outbox snapshots or logs.
- `uploadFile().promise` returns `{proof?}`. Finished chips/drafts retain the proof;
  Send/steer/follow-up pass the optional fourth `uploadProofs` argument through
  IndexedDB, keepalive and Background Sync. The server validates that authority
  and privately snapshots each upload's actual original owner for accepted
  dispatch, including mixed owners and main restarts. Host/session/file checks
  and submission fences remain. Legacy no-proof files remain original-owner-only.
- The live upload registry is in memory, but completed receipts/proofs are durable
  until their existing expiry. A main restart no longer loses a finished-but-unsent
  attachment. Switching chats aborts in-flight uploads; drafts keep only finished
  ones and their proofs (`sessionStorage`).

### Voice transcription jobs (`lib/stt-jobs.ts`, `/api/stt`, `hooks/useDictation.ts`)
- The browser never waits on the STT endpoint: `POST /api/stt` keeps the
  recording in memory and starts a job; the hook polls `GET /api/stt/[jobId]`
  (proxies with ~30s timeouts would otherwise return HTML 504s). Job failures
  are 200 payloads for the same reason.
- Jobs carry the composer scope (`draftKey`: session id, or `newChatDraftKey`:
  `new:<cwd>` here, `new:<hostId>:<cwd>` for a fresh chat on a remote host). The
  hook adopts the newest job for its scope on mount, focus, visibility and
  every 4s while visible and idle, so another browser can play (`/audio`),
  retry (`POST`) or discard it. Leaving the scope stops following without
  discarding.
- A finished job is delivered only by claim:
  `DELETE ?claim=<instance token>&owner=<tab token>` returns the text to the
  first claim token (repeatable with the same token); polls never carry text,
  and other composers see `gone` and stand down silently. A claim on an
  unfinished job is a no-op; a `DELETE` without `claim` discards and aborts
  the upstream request.
- Two tokens, never merged. The tab token (sessionStorage) identifies the
  job owner: it survives genuine-navigation composer remounts (a confirmed
  Edit identity move keeps the composer mounted), gets the 15s first claim,
  and alone gets the send/queue choice back. A duplicated tab copies it, so
  exclusivity comes from the claim token, which is per hook instance.
- The send/queue choice (`after`: send | steer | followup) is uploaded with
  the recording, kept on the job, and returned with the owner's claim. Never
  keep it only in component state: a session switch remounts the composer and
  loses it. A non-owner claim only inserts, since that composer holds its own
  draft and attachments.
- Store is per process (`globalThis` map) with caps (4 pending, 20 live) and
  TTLs; a server restart loses jobs, and the hook then re-uploads its local
  copy if it has one.
- Without `OMP_WEB_STT_ENDPOINT`, `OMP_WEB_STT_MODEL` names an omp STT model
  (e.g. `openai-codex/codex-transcribe`, the ChatGPT subscription) and jobs
  go through `lib/omp/auth-gateway.ts` as base64 JSON — so the gateway's 25MB
  body cap limits audio to 18MB there. omp-web never reads omp credentials.

### Notifications (`lib/notification-*.ts`, `public/sw.js`, Settings → Notifications)
- Detection runs on the server in `AgentSessionWrapper.handleFrame` (and
  `handleProcessExit` for crashes), so sessions no tab watches still notify.
  `createNotificationDetector()` only inspects top-level frames; subagent
  activity is wrapped in `subagent_*` frames and never notifies. "Completed"
  fires on `session_settled` (not `prompt_result`), so background work started
  by the prompt is done too; a failed or aborted last prompt suppresses it.
  Auto-approved tool confirmations return before the hook and never notify.
  omp sends `retry_fallback_applied` before the `auto_retry_start` of the same
  failure, so the detector holds a reason-less fallback until that frame.
  Failures also arrive as omp-web's own `prompt_error` (failed `response`) and
  `process_exit` frames; the detector reports one failure per run.
- A session omp moved to a new file keeps its old ids as `aliases` on the
  event, so a tab still showing an old id counts as viewing it.
- Presence and streams are separate on purpose. Presence: each tab reports
  `{clientId, deviceId, visible, sessionId}` to `/api/notifications/presence`
  (visibility/session change, input after idling, every 30 s while present;
  expires 60 s after receipt). `visible` means visible AND input within 3 min.
  `sessionId` is null while full-page Settings hides the chat. Streams: the
  tab's open SSE connections (`attachNotificationClient`), which reconnect and
  overlap independently of presence. `clientId` is per page load, `deviceId`
  per browser (`localStorage`). Reports carry a per-page `seq`; the server
  drops one older than the stored report (requests can arrive out of order).
  Prefs PUTs run one at a time and read the prefs when sent, for the same reason.
- Routing (`routeNotification`, unit-tested): a visible tab on the session
  drops the event everywhere (presence only, so a reconnecting stream cannot
  leak it); else if a visible tab with an open stream exists, `whenActive:
  "toast"` devices get a toast on their active tabs only; else push (subscribed
  devices) or in-page `showNotification` (tabs with an open stream).
- The server decides before pushing: iOS revokes push permission for pushes
  that display nothing, so `public/sw.js` always shows what it receives.
- Notifications have their own `notifications` channel (`clientId` = the
  tab's notification client id), opened by `useNotifications` in `AppShell`,
  so a tab stays reachable on every view, Settings included. A tab on
  Settings is visible, so it also counts as active.
- Prefs and push subscriptions are per device, in `localStorage` and mirrored to
  the SQLite notification store in omp-web's data dir
  (`lib/notification-store.ts`, server-only; mode 0600 because it also holds
  the VAPID private key; WAL with a busy timeout). It also keeps the
  notification history. An installed server and `npm run dev` sharing the agent
  dir share it safely; the first open imports and deletes the old
  `notifications.json`. Push text is
  rendered server-side in the device's locale. Browsers with saved settings (enabled or not) sync on load; never-configured browsers do not.
- A crash notifies "Run failed" while a run is live or while background work
  started by it has not settled yet (`unsettled`, cleared by `session_settled`).
- The Settings test button pushes through the server for subscribed devices
  (502 with the push service's answer on failure) and shows a local
  notification otherwise, or a toast where none are allowed.
- The in-app notification center (port of upstream PR #230 P2, storage in
  PR #254, top-bar bell from upstream 351237d7): on desktop the notification
  history opens from a **bell in the top bar** (unread badge + a floating
  popover, `NotificationBell`); on phones the workbench's Notifications tab
  carries it and the workbench toggle shows the badge.
  history (`lib/notification-history.ts`, a mirror of
  `/api/notifications/history`). `publishNotification` records every
  notification type some device has turned on (completed, input, error, model
  switch), whether or not any tab or push receives it, already read when a
  visible tab shows that session; the newest 100, so entries survive reloads
  and restarts and every device sees the same list — including pushes that
  arrived while no tab was open. Toasts are never stored and the `notify` host
  tool is NOT recorded: "Saved"-type toasts, update banners and `notify` calls
  stay out. The mirror loads on mount and when the tab becomes visible (read
  marks and removals from other devices), adds events this tab receives over
  SSE without a refetch, and reloads when the service worker reports a push it
  showed. Entries store the `NotificationEvent` and render in the viewer's
  language; `NotificationList.tsx` (`NotificationListView`) adds a toolbar
  (Mark all as read, Clear all) and per-entry dismiss. On desktop the bell
  carries the unread badge and its popover closes when a notification opens a
  session (every open — rows, toasts, worker clicks — goes through
  `OPEN_SESSION_EVENT`); on mobile unread entries badge the workbench toggle,
  which then opens that tab. Entries become read when the user closes the
  popover or leaves the tab (only the entries it showed), uses Mark all as
  read, or opens the notification from its toast or row; a reused id
  (`<sessionId>:<type>`) is unread again — it is a new notification. Mark-read,
  remove and clear update the list at once, then the server; a failed request
  reloads it. Unread rows show a leading accent dot and a bold title; read
  titles are dimmed (`--text-muted`).
- Listing on a device is the per-device `logToTab` notification pref
  (Settings → Notifications, default on; mirrored to the server with the other
  prefs but only ever read in the browser). The server records for every
  device, so this pref cannot gate recording; it is a VIEW switch
  (`setNotificationHistoryRecording()` in `lib/notification-history.ts`):
  while off, the tab, the bell popover, the unread counts and the bell/opener
  badges read as empty,
  recording continues server-side, loads and SSE deliveries keep filling the
  hidden mirror, and the entries reappear when it is turned back on (bulk
  read/clear operations while off act on the empty visible snapshot, i.e. are
  no-ops). `useNotifications` syncs the flag and keeps it current across this
  browser's tabs. Opening a notification from its toast still reads it.
- `/sw.js` and `/badge-96.png` are exempt from the password gate (`proxy.ts`):
  browsers re-fetch the worker for updates without the session cookie.
- Notification clicks survive an expired sign-in: `proxy.ts` sends `/?session=…`
  to `/login?next=/?session=…`, and `LoginForm` returns there (only `/?…`
  targets are accepted). The worker navigates non-app windows to the session
  URL; the app falls back to that URL when `/api/sessions` cannot be read.

### Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` and reuses one `AudioContext`.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.

### Text-to-speech read-aloud (`hooks/useSpeechSynthesis.tsx`, `lib/speech-sanitizer.ts`)
- Port of upstream f852ad0d + 995d9489. Browser `speechSynthesis` reads completed
  assistant replies; the button label is **Read** (tooltip/aria stay "Read aloud").
- `useSpeechSynthesis()` is the speech controller (module-level active-utterance
  ref + `TTS_STATE_EVENT`/`TTS_PREF_EVENT` window events keep several hook
  instances in sync — `ChatWindow` owns one behind `SpeechSynthesisProvider`,
  `SettingsConfig` mounts its own just for the settings). Message rows consume
  it through `useSpeechContext()`, which falls back to an inert
  (`isSupported: false`) state outside a provider — rows never mount a
  controller each and SSR renders stay clean.
- Autoplay must not read the transcript inside `onAgentEnd` (omp fires it in the
  same tick as the committing state update, so the ref-render is one turn
  behind): `wrappedOnAgentEnd` only sets `autoplayPendingRef` and the effect on
  `[messages, entryIds, streamState, agentRunning]` speaks from the render that
  carries the finished reply (`assistantSpeech()` prefers the live streaming
  message, else the last assistant row keyed by its entry id).
- Settings rows render disabled with a "Not supported in this browser" suffix
  instead of hiding when `speechSynthesis` is absent.

## omp Session File Format (v3)

Location: `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"title","v":1,"title":"...","source":"...","updatedAt":"...","pad":"   ..."}   ← fixed 256-byte slot
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"...","modelId":"...","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
```

- Line 1 is a fixed-width 256-byte padded title slot, rewritable in place.
  Old pi files may lack it — the `{"type":"session"}` header is then line 1.
- Entries form a tree via `(id, parentId)`. Additional entry types
  (`title_change`, `session_init`, `mode_change`, `ttsr_injection`, ...) must
  be tolerated by readers.
- Large payloads (images) are externalized to the content-addressed blob store
  at `~/.omp/agent/blobs` and referenced from entries.
- **`/skill:` first prompts** are stored as a `custom_message`
  (customType `skill-prompt`, display true) containing the invoked skill's
  full body plus the user's own text as a trailing `User: <prompt>` block —
  there is **no** `role:"user"` entry for the first turn. ompweb renders it
  as a user-style prompt bubble with a collapsible "Skill: \<name\>" badge
  (`SkillPromptView` in `components/MessageView.tsx`), so the session opens
  with the user's prompt instead of a wall of skill instructions.
- Session-list first messages for such sessions are recovered from that
  `User: ` trailer (`extractSkillPromptUser` in `lib/omp/session-files.ts`).
  It strips a web slash-command
  wrapper prefix ("/goal"/"/plan" send "Prefix:\n\n\<task>") and returns
  nothing when the trailer is missing (never the whole skill body, which
  would name the session after the skill).

`entryIds[]` in `SessionContext` is a parallel array to `messages[]` — maps each displayed message back to its `.jsonl` entry id, used for fork and navigate_tree calls.

---

## Design Tokens & UI Kit (`app/globals.css`, `components/ui/`)

Warm-paper (light) / warm-ember (dark) palettes; every text/background pair is
WCAG AA-verified (measured ratios noted in `globals.css` comments). Components
must consume these variables — no hardcoded colors.

```
color:  --bg --bg-panel --bg-hover --bg-selected --border --bg-subtle
        --text --text-muted --text-dim
        --accent --accent-strong --accent-hover   (links / filled buttons / hover)
        --user-bg --tool-bg
type:   --font-serif (display headings, class .display-serif)  --font-mono
shape:  --radius-control (8) --radius-card (12) --radius-modal (16)
depth:  --shadow-card --shadow-pop --shadow-modal
motion: --dur-fast (150ms) --dur-med (220ms) --dur-slow (320ms) --ease-out-warm
```

`components/ui/` holds the shared primitives (built on `@base-ui/react`):
`primitives.tsx` (Dialog/Tooltip/Collapsible), `field.tsx` (form fields +
ConfirmDialog), `toast.tsx` (`toast.success/error/info`, mounted in AppShell;
toasts are not stored — the Notifications tab lists the persisted server
history, see Notifications above). The `onClick` option makes the whole card the
action: a click outside its buttons, links and expandable text, ignoring drags
and text selection, or Enter on the focused card — there is no separate action
button; opening a session notification from its toast marks its history entry
read (`notificationHistory.markRead`).
Toasts and Notifications entries dismiss on a sideways touch/pen swipe
(base-ui's toast swipe; `NotificationRow` for the list) and carry
`data-swipe-dismiss`, which the mobile sidebar gesture skips.
`useDragClickGuard` swallows the click that ends any drag on them, judged by
the whole travel. `createSwipeTracker` cancels a swipe the finger turned back
(16px from its farthest point), as on Android; for toasts the release is
converted into the `pointercancel` base-ui treats as "snap back".
Icons come from `lucide-react` — do not add new inline SVGs. The command
palette (`components/CommandPalette.tsx`, ⌘K/Ctrl+K) is built on `cmdk`.
