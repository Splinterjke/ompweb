# omp-web - Development Notes

## Quick Start

```bash
npm run dev   # port 30178
```

Typecheck: `node_modules/.bin/tsc --noEmit`  
Lint: `npm run lint`  
**Dev and build use separate distDirs** — `next dev` writes to `.next-dev/`
(`distDir: isDev ? ".next-dev" : undefined` in `next.config.ts`), so `next build`
and the dev server can run concurrently in the same repo. Older setups shared
`.next/`, where a live dev server rewriting `.next/dev/types/` during the build's
typecheck step caused TS1128 failures. `scripts/clean-dev-types.mjs` still sweeps
dev type dirs before builds as a safety net.

The dev server needs the `omp` binary installed (on `PATH`, or set `OMP_WEB_OMP_BIN`).
All live-agent features go through it; session browsing works without it.

## Testing a dev instance (auth + prerequisites)

Before you can hit the dev server's `/api/*` with `curl`, you need to clear the
auth gate. This is the single most common thing an agent gets wrong when smoke-
testing — read this before assuming an endpoint is broken.

### Web password gate (`OMP_WEB_PASSWORD`)

`proxy.ts` is a Next middleware that gates **all** `/api/*` requests behind a
session. When `OMP_WEB_PASSWORD` is set (non-empty), an unauthenticated
`/api/*` request gets `401 {"error":"Password required","code":"password_required"}`;
non-API paths get a 302 to `/login`.

The dev server is usually launched with **no** `OMP_WEB_PASSWORD` (empty → gate
off), so plain `curl http://127.0.0.1:30178/api/...` works. But if it's launched
with one (e.g. via the docker compose `OMP_WEB_PASSWORD=asdf1234`), you must
log in first.

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
  yet" by status alone) — if you get 401 on the login call, the password in
  the env is different from what you sent. Read the actual value:
  `tr '\0' '\n' < /proc/<next-server-pid>/environ | grep ^OMP_WEB_PASSWORD=`
  (the value lives in the *next-server* child's env, not the wrapper's, if you
  launched it manually; for the docker/deployed instance it's in the entrypoint
  env).
- To read a running server's configured password without guessing: inspect its
  `/proc/<pid>/environ`.
- Non-loopback hosts are allowed only if listed in `OMP_WEB_ALLOWED_HOSTS`
  (comma-separated). Loopback (`127.0.0.1`, `localhost`) is always allowed.

### Loopback detection (why remote clients can't spoof)

`proxy.ts` detects loopback via the socket peer IP, which the dev/production
launchers stamp at the HTTP boundary: `--require ./bin/request-peer-preload.js`
overwrites `x-ompweb-socket-peer` + `x-ompweb-socket-proof` (HMAC of the real
`remoteAddress` with a per-process secret) on every incoming request, so a
client cannot forge a "loopback" header. This means:

- **You can only exercise loopback-gated paths (e.g. the `/api/ui/refresh`
  exemption) from the machine running the server.** A remote `curl` is not
  loopback and will be denied.
- The preload is what makes `isLoopbackConnection()` trustworthy; without it
  (a bare `next dev` without the `--require`), loopback detection fails closed.

### Rust host daemon (`OMPWEB_HOST_BIN`)

The diagnostics panel's "Rust Host Daemon" card reflects
`hostClient.host.status()`, which checks **binary existence** at the resolved
path, **not** process liveness. The host boots **lazily** — on the first
`hostClient.*` call (e.g. `POST /api/ui/refresh`, or a session start). It will
not boot until something pokes it.

Resolution order (`lib/omp/host-bin.ts`):
1. `OMPWEB_HOST_BIN` (explicit; authoritative — a missing path is an error, no
   fallback).
2. Packaged desktop geometry `<exec>/../Resources/bin/ompweb-host`.
3. `vendor/ompweb-host/<plat>-<arch>/ompweb-host` under the package root / cwd /
   module dir.
4. `crates/target/debug/ompweb-host` (dev/CI).

For a dev-server smoke test, set `OMPWEB_HOST_BIN` to the prebuilt debug binary
(`crates/target/debug/ompweb-host`) so the host boots and the KPI shows
"运行中/Available". If cargo isn't installed, that binary may be absent — the
host then won't boot and the card shows "未就绪/Unavailable" (binary missing,
**not** the process being dead).
- The host daemon is **per Node process**: each ompweb server instance spawns
  its own `ompweb-host` child. Rebuilding the binary (`cargo build`) does NOT
  affect an already-running daemon — it keeps the old code in memory until it
  exits (30 s idle teardown) or is killed. To test a freshly built binary,
  start a **new** server instance (it will spawn a new daemon from the updated
  path) or use `OMPWEB_BACKEND=node` to bypass the Rust host entirely.

### Quick checklist before testing a dev instance

1. Confirm the port (dev = `30178`, `npm run start` = `30177`).
2. Check whether the server has `OMP_WEB_PASSWORD` set (gate on/off). If on,
   log in via `/api/web-auth/session` and keep the cookie jar.
3. For Rust-host features, confirm `OMPWEB_HOST_BIN` points at an existing
   binary, or that `crates/target/debug/ompweb-host` exists.
4. Remember the loopback exemption only works from the server's own machine.
5. The diagnostics route (`/api/diagnostics`) is where the Rust Host Daemon KPI
   and backend-error alerts are driven from — if it 500s, the whole panel shows
   a fallback even when the host is fine.
6. **Test env-var contamination**: `OMPWEB_HOST_BIN` and `OMP_WEB_PACKAGE_DIR`
   in the ambient shell (e.g. leaked from a dev-server launch) cause
   `host-bin.test.mjs` route-3 tests to fail because `resolveHostBin` falls
   through to `process.env` when a test doesn't inject an explicit `env`.
   Run the suite with `env -u OMPWEB_HOST_BIN -u OMP_WEB_PACKAGE_DIR node
   --experimental-strip-types --test …` for a clean result.

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

omp-web never imports `@oh-my-pi/*` or `@earendil-works/*` packages (they are
Bun-only and cannot run inside Node/Next). See `DESIGN.md` for the full porting
contract.

```
Browser                Next.js Server                    omp child process
  │                        │                                    │
  ├─ GET /api/sessions ────▶ reads ~/.omp/agent/sessions/       │
  ├─ GET /api/sessions/[id] reads .jsonl file directly          │
  ├─ GET /api/agent/running/events ───▶ running id SSE          │
  │                        │                                    │
  ├─ send message ─────────▶ POST /api/agent/[id]               │
  │                        │   startRpcSession() ── spawn ─────▶│ omp --mode rpc-ui
  │                        │   sendCommand({type:"prompt"}) ───▶│ (NDJSON stdio)
  │                        │                                    │
  ├─ SSE connect ──────────▶ GET /api/agent/[id]/events         │
  │                        │   onFrame() ◀── event frames ──────│
  │◀── data: {...} ─────────│                                    │
```

**Session browsing** (read-only): pure-Node parsing of omp session `.jsonl`
files via `lib/session-reader.ts` — no child process involved.  
**Sending a message**: `startRpcSession()` in `lib/rpc-manager.ts` spawns
`omp --mode rpc-ui` (one process per active session) through
`lib/omp/rpc-process.ts`.

Shared foundations in `lib/omp/`:

- `paths.ts` — Node port of omp's directory resolution (`~/.omp/agent`,
  profiles, XDG, session dir slugs).
- `omp-cli.ts` — locate/probe the installed `omp` binary (`resolveOmpBin`,
  `getOmpVersion`).
- `rpc-process.ts` — process + NDJSON protocol layer (`RpcProcess`).

---

## File Map

```
app/api/
  sessions/route.ts               GET  list all sessions
  sessions/[id]/route.ts          GET/PATCH/DELETE session
  sessions/[id]/context/route.ts  GET ?leafId= — context for a specific leaf
  sessions/[id]/export/route.ts   GET exported HTML for a session
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST any RPC command
  agent/[id]/events/route.ts      GET SSE stream
  agent/running/events/route.ts   GET SSE stream of currently-running session ids + `chat_event_action` frames
  agent/host-tools/events/route.ts  GET SSE stream of cross-session host tool calls (open_url, notify, open_file) for sessions no tab is watching
  chat-event-actions/route.ts     GET/POST named actions fired on chat events
  chat-event-actions/[id]/route.ts  GET/PATCH/DELETE a single action
  auth/**                         provider list, login/logout, API keys (via RPC)
  cwd/validate/route.ts           POST validate/select a cwd
  default-cwd/route.ts            POST create ~/omp-cwd-YYYYMMDD
  files/[...path]/route.ts        GET file contents for viewer
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
  web-settings/route.ts          GET/PUT server settings (auto-resume sessions)
  worktrees/route.ts              GET/POST/DELETE git worktrees

lib/
  omp/                 shared omp foundations (paths, CLI probe, RpcProcess)
  agent-client.ts      typed fetch helper for /api/agent commands
  btw.ts               /btw side-question records + pure frame/snapshot merge (order-safe)
  chat-event-action-types.ts  ChatEventType + ActionSpec union (notification/http/bash/scheduled)
  chat-event-action-store.ts  persistence (~/.omp/agent/chat-event-actions.json), validation, per-event cache
  chat-event-action-bus.ts  globalThis relay for `chat_event_action` frames (running-stream SSE)
  chat-event-actions-executors.ts  run each action type (never throws, records lastRun)
  chat-event-actions-dispatcher.ts  event → enabled actions, per-run dedupe
  file-access.ts       allowed file roots for /api/files and worktrees
  file-paths.ts        client/server path encoding helpers
  markdown.ts          shared markdown helpers
  npx.ts               npx runner used by skill install
  pi-types.ts          local structural types for agent/RPC objects
  project-ordering.ts  pure project sort/group/activity helpers (client + tests)
  project-registry.ts  on-disk managed-project registry (~/.omp/agent/projects.json)
  rpc-manager.ts       session registry + startRpcSession over RpcProcess
  scheduler-store.ts   script-scheduler persistence (~/.omp/agent/schedulers.json) + ensureSeedSchedulers()
  scheduler-engine.ts  in-process cron (globalThis ticker): fires due scripts, manual runs
  schedule.ts          ScheduleSpec (interval/daily/weekdays/weekly/cron/manual) + next-slot math
  scheduler-seed.test.mjs  seeds the rebuild script as a "Manual launch" scheduler on boot
  session-reader.ts    session .jsonl parsing + path cache + buildSessionContext
  session-resume.ts    mid-run session tracker (on-disk list) + resume prompt; resume orchestration lives in rpc-manager
  skills-service.ts    skill listing via `omp skill list --json`; pure-Node replica scan as fallback
  tool-presets.ts      PRESET_NONE/DEFAULT/FULL + getPresetFromTools()
  types.ts             shared TypeScript types
  normalize.ts         normalizeToolCalls() — field name mismatch between file format and our types
  navigation-history.ts  pure back/forward view-history stack + shortcut matcher (⌘[/⌘], Alt+←/→)
  worktree.ts          project/worktree resolution and git worktree operations
  web-settings.ts      omp-web server settings (autoResumeSessions) persistence, ~/.omp/agent/omp-web-settings.json

components/
  AppShell.tsx        layout + URL state + tab management
  SessionSidebar.tsx  session tree + FileExplorer
  ChatWindow.tsx      chat composition + completion sound wrapper
  SessionLoading.tsx  animated SVG letter-build + glowing trail for the session loading state
  ChatInput.tsx       input bar + model/thinking/tools/compact controls
  ComposerPanels.tsx  composer hub bars: /btw side question, git changes, todo plan, subagents (stack or row layout, per-bar visibility)
  BtwPanel.tsx        /btw side-question panel (stream, cancel, copy, follow-up) + history dialog
  TodoList.tsx        todo phase grid with preview/show-all (used by ComposerPanels)
  SubagentTranscriptDialog.tsx  task + final output summary dialog (wide, screen-adaptive)
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
  CommandPalette.tsx  ⌘K/Ctrl+K palette (cmdk): session switch, new session, theme
  ImageLightbox.tsx   click-to-preview lightbox for chat images (ClickableImage)
  BranchNavigator.tsx in-session branch switcher
  ChatMinimap.tsx     scroll minimap alongside the message list
  EventActionsPanel.tsx sidebar "Chat event actions" list (between Schedulers and Usage)
  EventActionModal.tsx create/edit chat-event action (event checkboxes + 4 action types)
  MarkdownBody.tsx    markdown renderer
  ModelsConfig.tsx    modal for models/auth configuration
  McpConfig.tsx       project MCP server editor (Settings → MCP tab)
  PluginsConfig.tsx   modal for installed plugins
  SkillsConfig.tsx    modal for loaded/search/installable skills
  FileExplorer.tsx    file tree inside sidebar
  FileViewer.tsx      file content in a tab
  TabBar.tsx          tab bar (Chat + open file tabs)
  ui/                 shared primitives: Dialog/Tooltip/Collapsible, fields, toast

hooks/
  useAgentSession.ts       messages + streaming + SSE + fork/navigate/reconciliation logic
  useAudio.ts              completion sound + browser AudioContext unlock
  useBtw.ts                /btw records/active panel/history dialog fed by btw_* SSE frames
  useDragDrop.ts           shared drag/drop state
  useIsMobile.ts           responsive breakpoint hook
  useNavigationHistory.ts  in-app back/forward stack (record/peek/commit/drop) for visited chat views
  usePrefersReducedMotion.ts OS reduce-motion preference (SMIL-safe)
  useTheme.ts              theme state (localStorage key "omp-theme")
```

---

## Key Design Decisions & Traps

### RPC session lifecycle (`lib/rpc-manager.ts`)
- One wrapper per session id, keyed in a `globalThis` registry.
- `globalThis` survives Next.js hot-reload; plain module-level Map does not.
- Idle sessions are disposed after a timeout; concurrent `startRpcSession()`
  calls must share a single start promise.
- Two cleanup backstops, both unref'd so they never hold the event loop:
  `IDLE_DESTROY_MS` (10 min) and `DISCONNECT_DESTROY_MS`
  (`OMP_WEB_DISCONNECT_DESTROY_MS`, 2 min, `0` disables). The shorter one only
  fires once a session has been genuinely abandoned — no `onEvent` listener, no
  run in flight, no startup handshake, no unanswered `send()`. The last
  `onEvent` detach *starts* that window rather than exposing the last frame's,
  so a reload reattaching seconds later does not 409. Both are fed by
  `resetIdleTimer()`, the single activity choke point for `send()` and every
  child frame: adding a new call path must route activity through it.

### Cross-session host tools and the ask dialog (`lib/rpc-manager.ts`, `/api/agent/host-tools/events`)
- Agent-callable host tools (`open_url`, `notify`, `open_file`) are registered per session via `set_host_tools`. While a tab is viewing the session, `host_tool_call` frames go to that session's own SSE stream and the tab answers with `host_tool_result`. When **no** tab views the session (the user switched sessions mid-run), the call is broadcast to *every* open omp-web tab through `subscribeHostToolCalls()` + the `agent/host-tools/events` SSE; each tab executes the tool and sends a `host_tool_result`, and the server settles the call on the first one received (`pendingHostTools.delete`, so later duplicates are no-ops).
- Calls routed to other tabs are flagged `webCrossSession` in `pendingHostTools`. When the last other tab leaves (`subscribeHostToolCalls` unsubscribe with an empty set), only the cross calls are settled via `rejectCrossSessionHostTools()` (`which: "cross"`) — the session's own outstanding calls are untouched; when the session's last listener detaches, only the own calls are rejected.
- Full-page Settings hides the chat, so its session counts as *not viewed* (`viewing = call.sessionId === selectedSession?.id && !settingsTab` in `AppShell`) — opens from it go through the confirm queue like any cross-session open.
- URL opens from a session the tab is **not** viewing always go through the `pendingOpens` confirm queue (`ConfirmDialog` in `AppShell`). The "Open agent links without asking" setting only auto-opens links from the viewed session (`!crossSession && openUrlAutomatically`).
- The multi-question `ask` dialog is opted into on spawn **and** respawn with `set_ask_dialog` (bounded like `get_state`, so a child that never answers cannot stall startup); older omp rejects the command and the per-question select/editor fallback keeps working. Pending `ask` requests only accept their `answers` payload or a cancel — `isAskAnswers()` shape-checks it in `extension_ui_response`, so a replayed reconnect response cannot drop them with a stale/malformed payload.

### Session moves (omp >= 18.5 ownership) and title generation
- Only the first omp process to write a session file owns it; a non-owner moves
  to a sibling file with a new id on its first write and emits a
  `notice` with `source: "session-persistence"`. `handleFrame` answers it with
  `followSessionMove()`: the pending flag makes the next `applyIdentity` re-key
  as the same conversation (stream/run state kept, **old id kept as a registry
  alias**, new id registered via `onIdentityChange({keepOldId})`). Genuine
  switches (branch/new/switch) re-key through `refreshIdentityAfterSessionChange`
  and still drop the old key — a move is the only implicit re-key.
  `startRpcSession` also reuses any live wrapper reporting the requested session
  file instead of spawning a second `--resume` child (which would fork again).
  `onDestroy` removes every key that points at the wrapper.
- `POST /api/sessions/[id]/auto-name` asks omp to generate the title
  (`AgentSessionWrapper.generateTitle()`: native `generate_title`, else
  argument-less `/rename`, never while a run is in flight). Only when omp cannot
  does it fall back to the stored/derived title (`generated:false`), saved
  through the live process when there is one.

### Two kinds of branching — don't confuse them
- **Fork** ("Fork a new session from this point" button, `messageView.newSessionTitle`, on user and assistant messages; only offered while the session is idle — ChatWindow gates it on `!sessionBusy && !isNew`): creates a new independent `.jsonl` file via omp's `branch` RPC. Shown as a child in the sidebar tree via `parentSession` header field. `branch` only takes a user entry and keeps the history *before* it, so `lib/chat-fork.ts` maps rows: a user prompt forks at itself and its returned text prefills the fork's composer (edit-and-resend, text only — attached images are not restored); an assistant reply forks at the next user prompt so the reply is kept; the newest reply falls back to its own prompt with the prefill. Rows that would edit the very first prompt (an empty fork) offer no fork.
- **In-session branch** (Continue button / BranchNavigator): navigates the entry tree within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

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
- `tool_execution_update` is coalesced per tool call at display rate in
  `lib/message-update-coalescer.ts` (chatty commands emit ~10-100+ frames/s).
  `message_end` drops the pending `message_update` (the committed message
  supersedes it) but must NOT drop buffered tool updates.
- The same fold runs SERVER-SIDE in `rpc-manager.ts` (`frameCoalescer`, the
  shared `lib/message-update-coalescer.ts`): `emit` pushes every frame
  through it, so subscribers — SSE and internal alike — receive at most one
  `message_update` / `tool_execution_update` per display window (~20/s
  instead of 100+), each still a FULL partial. Order is unchanged (any other
  frame flushes the fold first); `restart` and `destroyAndWait` reset it.
  omp's `set_event_filter` delta mode is deliberately NOT used: it drops the
  accumulated snapshots, which would break latest-wins folding and force the
  wrapper to re-accumulate provider deltas — the stdio hop it saves is local
  and already the cheap one.
- Live entries are cleared on `agent_start`, terminal `agent_end`, prompt
  send/settlement failure — a tool must never leak into the next run.

### Event protocol differences vs pi
omp emits no `prompt_done` / `prompt_error` / `compaction_start` /
`compaction_end` events. Completion is `agent_end` (`isTerminal !== false`),
errors surface as failed RPC responses plus `notice` events.
New frame types (`turn_start/end`, `notice`, `todo_reminder`, ...) must be
handled or safely ignored.

### Queued messages are omp-owned
The queue panel renders omp's snapshot only: `get_state.queuedMessages` on
load/reconcile/stream open and live `queue_update` frames. Never track chips
client-side — every client viewing the session must show the same queue.
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
  `lib/omp/session-files.ts` and `extract_skill_prompt_user` in
  `crates/ompweb-host/src/session_scan.rs` (Rust is the default scan path — keep
  the two in parity). Rules: no `"User: "` marker → no first message (NEVER
  fall back to the whole skill body); a leading web-slash-command wrapper line
  (`"Prefix:"` + blank line, e.g. `/goal`'s "Work toward this goal for the rest
  of the session:") is stripped so the session reads as the task itself.

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

### Running state SSE + reconciliation
- The sidebar listens to `/api/agent/running/events`, backed by `subscribeRunningSessions()` in `lib/rpc-manager.ts`, so running badges update without polling.
- `useAgentSession` still treats per-session SSE as primary for chat events, but while a run is active it periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed `agent_end` events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.

### External session detection (`lib/session-watcher.ts`, `/api/sessions/[id]/state`)
- When ompweb restarts mid-run, the old `omp --mode rpc-ui` child survives (it is a child of the Rust host daemon, not the server). The new server detects such "externally held" sessions by scanning `/proc` for `omp` processes with `--resume <file>` on the command line, or — for host-spawned children whose cmdline has no file — with a session file held open (fd scan). Web-owned children (direct children of this node process or of the host daemon) are excluded by PPid, NOT by the RPC registry: after a restart a session can hold a freshly restored idle RPC while a stale previous-server child still owns the file.
- `GET /api/sessions/[id]/state` reports `external: true` when the file had a recent write (90 s `EXTERNAL_ACTIVITY_WINDOW_MS`) or a live holder has a turn in flight. "Turn in flight" = the last committed `message` entry is a user/toolResult (model generating) or an assistant with a pending toolCall. Idle holders (a terminal waiting for input, a leftover child after its turn finished) end on a final assistant message and must not keep the session "running" forever. A holder whose file has been quiet for `STALE_HOLDER_MS` (5 min, mirrors the client's `EXTERNAL_RUN_END_SILENCE_MS`) is treated as stalled (hung tool, crashed API call, orphaned child) and dropped by the `/proc` scan — otherwise a dead-end process would keep the session "running" forever; a live run re-announces itself on its next file write and the badge returns.
- Client (`useAgentSession` `enterExternalMode`): external sessions render as running (Stop button, "running in an external omp terminal" notice), never attach a per-session RPC stream or registry reconcile, and a 10 s poller reclaims to idle once the file is quiet and the committed tail is final. Stop/send/steer/compact are rejected with the same notice — the web server has no RPC channel to the external process, so it must be stopped at its source (the terminal). The session-file watcher re-enters external mode on the next write (which also reloads via `loadContext(sid, null, true)` so an open pre-compaction view survives external writes).
- The session-file watcher uses per-directory non-recursive inotify watches (one per project dir, lazily added with a one-shot resync). Node's recursive `fs.watch` lstats every directory entry on folder events, which raises an uncaught EIO on WSL2/9p (dentry race on transient `.jsonl.lock` files) and killed the server. `instrumentation.ts` additionally suppresses exactly those errors.
- **inotify is silent on 9p/drvfs mounts** (WSL2 with the agent dir on a Windows drive, e.g. `/root/.omp` → `C:\`): no events at all, so external sessions never updated in real time there. The watcher therefore also runs a **polling fallback** (`pollForChanges()`, exported for tests): a 2 s stat-based sweep over known session files feeding the same `pendingPaths` → `flush` → listeners pipeline (size baselines shared with inotify via `lastSizeByPath`, `pendingPaths` dedupes both sources), plus a 15 s directory rescan that discovers new `.jsonl` files. On native filesystems the sweep is a cheap no-op once inotify has delivered the event.

### Auto-resume after a restart (`lib/session-resume.ts`, `lib/web-settings.ts`)
- ON by default (`autoResumeSessions` in `~/.omp/agent/omp-web-settings.json`, toggle in
  Settings → System & Updates, served by `/api/web-settings`). Replaces the older
  SIGTERM-snapshot restore. While on, `notifyRunningChange()` keeps
  `~/.omp/agent/omp-web-interrupted-sessions.json` in the agent dir listing sessions
  that are mid-run.
- A session leaves the list when its run ends normally (process still alive), or
  `EXIT_GRACE_MS` (2 s) after its process dies — a service stop signals every process
  at once, so a child can die just before the shutdown handler runs;
  `markShuttingDown()` (the registry cleanup hook, fired from `instrumentation.ts`)
  freezes the list so those deaths still count as interrupted, while a crash with
  omp-web still up is dropped after the window.
- On boot, `instrumentation.ts` calls `resumeInterruptedSessions()` (fire-and-forget,
  must never block boot): each interrupted session is re-spawned and prompted with the
  side-effect-aware recovery prompt ("The omp-web server restarted while your previous
  turn was active… Do not repeat completed side effects…").
- Only session ids + the `--advisor` flag are stored; paths are re-resolved on resume,
  and invalid ids are dropped. The tracker claims the previous run's list on first use
  in the process (`readLeftover`), so this run's first write can never clobber it before
  resume consumes it.
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
- "Process details" groups key their React `key` on the anchor entry id (`process-group-<entryId>`) — never on the message index or the final-assistant index — because the group grows as new tool calls commit mid-turn and index-based keys remount it, silently resetting the user's expanded state. Expansion state lives in `CommittedTranscript.processExpanded` keyed by anchor id, so it survives remounts and virtual-window recycling. An in-flight turn renders as the visible live tail, not a collapsed group.

### Composer-attached hub bars (`components/ComposerPanels.tsx`)
- The live todo plan (`TodoList`), the subagent roster and the git changes
  bar (`GitChangesBar`) live **pinned above the chat input**, not inside the
  scrollable message list. `ComposerPanels` renders each as an independently
  collapsible bar (header row with chevron); bars start collapsed (headers
  always show live progress / running-summary).
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
  `SessionSidebar`) places the change counts in the sidebar workspace
  header — inline chip on the name row, a second line under the name, or
  hidden (hidden workspaces are not polled).
- Subagent chips carry live state (pulsing dot while `started`, check/alert/ban
  for terminal states) fed by the same `subagent_lifecycle`/`subagent_progress`
  SSE frames; clicking a chip opens the transcript dialog. Non-running
  subagents (terminal or history) nest under a collapsible `Completed (N)`
  group inside the hub, re-collapsing on every mount (not persisted).
  `TodoList` keeps a non-collapsible default (`collapsible` prop) for SSR tests.

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

### Worktrees and project grouping
- `lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches that to each `SessionInfo` so all worktrees for one repo are grouped together in the sidebar.
- Worktree operations are served by `/api/worktrees` and guarded by the same allowed-root rules as `/api/files`.
- New worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused; otherwise `git worktree add -b` creates the branch.
- Removing a dirty worktree returns `409` with `{ dirty: true }` so the UI can ask before retrying with `force`.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.

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
- The client sorts the merged list by most-recently-added (registration
  order), then by path for session-discovered projects
  (`lib/project-ordering.ts`); the order deliberately does NOT depend on
  session activity, so project rows never jump around while sessions refresh.
  Expanded project paths live
  in `localStorage` (`omp-web:expanded-projects`), defaulting to only the
  active/restored project expanded, and stale keys are pruned against the
  current project list (only after the first project fetch — an empty
  still-loading list must never wipe storage).
- Each project's session tree is capped at 5 roots with a show-more toggle;
  project rows are cards matching the session items' height/margins/accent
  treatment, and the active project's worktree selector renders directly
  below its row.

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
- `/api/files` is intentionally not a general filesystem browser. Allowed roots come from session cwds, their resolved project roots, `~/omp-cwd-*`, and roots explicitly added with `allowFileRoot()`.
- `/api/cwd/validate`, `/api/default-cwd`, and `/api/worktrees` call `allowFileRoot()` when they make a new location browsable.

### Session list caching — new sessions must appear immediately
- `listAllSessions()` (sidebar, command palette) is cached twice: a 30s TTL
  list cache in `lib/session-reader.ts` plus an mtime-keyed directory walk in
  `lib/omp/session-files.ts` (`listSessionFiles`).
- The walk cache keys on the **sessions root** mtime. On Windows/NTFS a new
  `.jsonl` inside an existing project subdirectory does NOT bump the root
  mtime, so the walk stays stale indefinitely.
- `invalidateSessionListCache()` (fired on `agent_end`, `session_info_update`,
  compaction, renames) must therefore ALSO clear the walk cache via
  `invalidateSessionFileListCache()` — never add a session-mutation path that
  forgets this. Regression test: `session-reader.test.mjs`.

### Git health and background polling
- Read-only git failures (`git_status_failed`, `git_branches_failed`, `git_diff_failed`) are fired automatically by background polling (composer bar, Git tab, sidebar badges all poll `/api/git/status` every 5 s) and their failure is always visible at the point of use (empty bar, inline panel error). They therefore MUST NOT degrade app health or appear in the diagnostics error list — `lib/git-nonrepo.ts` `filterBenignGitEntries()` is applied in both `healthOf` and the BackendDiagnostics views so the badge and the list can never disagree. Write operations (checkout/commit/push) are explicit user actions and still degrade.
- The pollers' `git diff/status` children refresh the index stat-cache and briefly hold `.git/index.lock`, so index-writing commands (`git commit`, `reset`, `add`, `read-tree`) can fail transiently with "index.lock: File exists" while a dev server is serving this repo. It is NOT a stale lock: retry (a short sequence rarely collides twice), and never delete the lock while a live git child exists (the pollers appear under the next-server pid). A `set -e` multi-step git sequence stops mid-sequence on a collision with the next step's tree already staged — inspect `git log`/`git status`/`git write-tree` and finish only the remaining commits, never re-run the whole script.
- The raw backend-error ring keeps git read entries (the diagnostics report is a support artifact where git noise is informative) — do not "clean" them out of the ring.
- The routes skip `recordBackendError` for non-repo workspaces (`isNonRepositoryError`, `not_a_git_repository` code / "Not a Git repository" message) so a plain folder can never land an entry in the ring.
- Single-file diff (`/api/git/diff`, Rust `diff_inner` / Node `getGitFileDiff`) classifies the file with a **scoped** `git status --porcelain=v1 -z --untracked-files=all -- ':(literal)<path>'` (~250 ms) instead of a full-tree status scan (2.6–13 s on a 3 GB repo), which made every file click in the Git tab feel like the diff would never load. The scoped result is authoritative except for index status `A` (staged new file) — only a full scan can pair a rename target with its original path — so both implementations fall back to the full scan in that one case. Keep both in sync; `lib/git-parity.test.mjs` (staged rename case) pins the parity.
- Client git pollers (`useGitStatus`, `useGitStats`, `GitChangesPanel`) carry an in-flight guard: never stack a new poll round while the previous one is still running — a slow repository outlives the 5 s interval and stacked rounds saturate the host and turn every git call into a timeout.
- Host side: the Rust `git.status` handler runs its four post-status calls (branch/upstream/counts/diff) concurrently (each on its own `thread::spawn`, joined via a `join_git` helper in `git_service.rs`), and `rust-rpc-process.ts` routes every `git.*` method over an isolated IPC connection (not just `git.push`) so a slow git call can never block the shared control channel. `ipc_server.rs` `MAX_CONNECTIONS` must stay ≥ shared control + one per in-flight git.* request (the UI polls up to 13 cwds).

### Chat scroll-follow
- `useAgentSession` follows the conversation: the effect depends on both
  `messages` (boundaries) and `streamState` (every token batch) and throttles
  to one `requestAnimationFrame` while a run is active (`followScrollFrameRef`).
- A manual scroll-up sets `completionScrollAllowedRef = false` and disables
  following until the next prompt; `scrollUserMsgToTop` handles the
  pending-scroll after sending.
- Programmatic smooth scrolling must respect `prefers-reduced-motion`
  (`usePrefersReducedMotion` in `hooks/usePrefersReducedMotion.ts` — also the
  only way to stop SVG SMIL animations, which CSS cannot).

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

### Update notifications (`/api/omp-update`, `/api/app-update`)
- Automatic in-app self-updating has been removed in favor of explicit user notifications and manual terminal commands.
- `GET /api/app-update` queries the npm registry for `@Splinterjke/ompweb` updates, detects the install manager (`bun` vs `npm` via `detectInstallMethod`), and returns `updateAvailable` plus the exact terminal command (e.g. `npm install -g @Splinterjke/ompweb` or `bun add -g @Splinterjke/ompweb`).
- `POST /api/omp-update` (`action: "check"`) runs `omp update --check` and returns `updateAvailable` plus `updateCommand: "omp update"`.
- `POST /api/omp-update` (`action: "update", stream: true`) runs the real `omp update` as an NDJSON stream (`{type:"out"}` frames + a final `{type:"done", exitCode}`). The stream **must** always terminate with the `done` frame AND `controller.close()` in the route's `finally`/success path — the client's reader loop in `SettingsConfig.runOmpUpdate` exits only on stream close, which is what releases the "Updating" button (`setUpdatingOmp(false)` in `finally`). A stream that never closes leaves the button spinning forever (regression: the close was missing, so the button stuck).
- The "OMP update available" toast in `AppShell` (id tracked in `ompUpdateToastIdRef`) auto-closes via `closeOmpUpdateToast` when the update flow succeeds: `SettingsConfig` receives the `onOmpUpdateSucceeded` prop (wired in `AppShell`) and fires it in the `runOmpUpdate` success branch alongside `onOmpUpdateAvailabilityChange(false)`.
- `POST /api/omp-update` (`action: "restart"`) restarts active OMP sessions after a manual CLI update.
- Notifications in `AppShell` and settings cards in `SettingsConfig` present the update notification alongside copyable terminal update commands.

### Auth and model config
- Auth flows go through RPC commands (`get_login_providers`, `login`) against the omp child process; credentials live in omp's `agent.db` (SQLite) which omp-web never touches directly.
- The Models panel reads and writes `models.yml` in the omp agent directory (`~/.omp/agent/models.yml`, `.yaml` fallback).
- API-key status endpoints must never return the raw key.

### Automation tasks — script + prompt schedulers (`lib/scheduler-store.ts`, `lib/scheduler-engine.ts`, `/api/schedulers`)
- The sidebar "Automation tasks" panel (renamed from "Script schedulers") has two
  tabs: **Scheduled scripts** (terminal icon) and **Scheduled prompts** (chat icon).
  Entries share one store, `~/.omp/agent/schedulers.json`, and are distinguished by
  `kind: "script" | "prompt"` (absent = script, backward compatible).
- **Script entries** (unchanged behavior): `{ name, kind, script, args[], schedule,
  enabled, timeoutMs }` — runs the script via bash (`.sh/.bash/.zsh`) or directly
  (executable bit required).
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
- **Default seed** (`ensureSeedSchedulers`, `instrumentation.ts`): the repo's
  `ompweb-rebuild-restart.sh` is added at boot as a **Manual launch** scheduler
  (`schedule: { kind: "manual" }`, 20 min timeout) if not already present —
  idempotent and best-effort (a packaged install without the script is a no-op).
  triggers them via `POST /api/schedulers/[id]/run` (the panel's run button).
  `ensureSeedSchedulers` resolves the script from `process.cwd()` (the dev repo
  root or the `/opt/ompweb` install root), matching the engine's
  `spawn` cwd (`path.dirname(script)`).
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
  over the running-stream SSE (`agent/running/events`). `ok` is true only if at least one
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
  the prefixed instruction — never an implicit native create. The tracker (continuation loop,
  budget) is armed only by the marker row's explicit "Track natively" control (`trackGoal`,
  `onTrackGoal`); an implicit create silently burned ~10k tokens/minutes on a passive
  wait-for-a-word rule before this split (regression test in `useAgentSession.rpc.test.mjs`).
- Native goal ≠ `activeGoal` (`lib/web-mode-state.ts`): the web marker tracks "this session
  was started with /goal" for the composer hint; the bar shows omp's authoritative tracked goal.

### Voice transcription jobs (`lib/stt-jobs.ts`, `/api/stt`, `hooks/useDictation.ts`)
- The browser never waits on the STT endpoint: `POST /api/stt` keeps the
  recording in memory and starts a job; the hook polls `GET /api/stt/[jobId]`
  (proxies with ~30s timeouts would otherwise return HTML 504s). Job failures
  are 200 payloads for the same reason.
- Jobs carry the composer scope (`draftKey`: session id or `new:<cwd>`). The
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
  job owner: it survives the composer remounting (`AppShell` keys
  `ChatWindow` by session), gets the 15s first claim, and alone gets the
  send/queue choice back. A duplicated tab copies it, so exclusivity comes
  from the claim token, which is per hook instance.
- The send/queue choice (`after`: send | steer | followup) is uploaded with
  the recording, kept on the job, and returned with the owner's claim. Never
  keep it only in component state: a session switch remounts the composer and
  loses it. A non-owner claim only inserts, since that composer holds its own
  draft and attachments.
- Store is per process (`globalThis` map) with caps (4 pending, 20 live) and
  TTLs; a server restart loses jobs, and the hook then re-uploads its local
  copy if it has one.

### Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` and reuses one `AudioContext`.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.

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
  `User: ` trailer (`extractSkillPromptUser` in `lib/omp/session-files.ts`,
  mirrored by `extract_skill_prompt_user` in `crates/ompweb-host/src/
  session_scan.rs` — keep the two in sync). Both strip a web slash-command
  wrapper prefix ("/goal"/"/plan" send "Prefix:\n\n\<task>") and return
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
ConfirmDialog), `toast.tsx` (`toast.success/error/info`, mounted in AppShell).
Icons come from `lucide-react` — do not add new inline SVGs. The command
palette (`components/CommandPalette.tsx`, ⌘K/Ctrl+K) is built on `cmdk`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
