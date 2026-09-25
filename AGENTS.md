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

---

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
  worktrees/route.ts              GET/POST/DELETE git worktrees

lib/
  omp/                 shared omp foundations (paths, CLI probe, RpcProcess)
  agent-client.ts      typed fetch helper for /api/agent commands
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
  skills-service.ts    pure-Node skill discovery mirroring omp's providers
  tool-presets.ts      PRESET_NONE/DEFAULT/FULL + getPresetFromTools()
  types.ts             shared TypeScript types
  normalize.ts         normalizeToolCalls() — field name mismatch between file format and our types
  worktree.ts          project/worktree resolution and git worktree operations

components/
  AppShell.tsx        layout + URL state + tab management
  SessionSidebar.tsx  session tree + FileExplorer
  ChatWindow.tsx      chat composition + completion sound wrapper
  ChatInput.tsx       input bar + model/thinking/tools/compact controls
  ComposerPanels.tsx  composer-attached todo + subagent panels (collapsible, live states)
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
  useDragDrop.ts           shared drag/drop state
  useIsMobile.ts           responsive breakpoint hook
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

### Two kinds of branching — don't confuse them
- **Fork** (Fork button on user message): creates a new independent `.jsonl` file. Shown as a child in the sidebar tree via `parentSession` header field.
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
- Live entries are cleared on `agent_start`, terminal `agent_end`, prompt
  send/settlement failure — a tool must never leak into the next run.

### Event protocol differences vs pi
omp emits no `prompt_done` / `prompt_error` / `queue_update` /
`compaction_start` / `compaction_end` events. Completion is `agent_end`
(`isTerminal !== false`), errors surface as failed RPC responses plus `notice`
events, and the queue length comes from `get_state.queuedMessageCount`.
New frame types (`turn_start/end`, `notice`, `todo_reminder`, ...) must be
handled or safely ignored.

### Running state SSE + reconciliation
- The sidebar listens to `/api/agent/running/events`, backed by `subscribeRunningSessions()` in `lib/rpc-manager.ts`, so running badges update without polling.
- `useAgentSession` still treats per-session SSE as primary for chat events, but while a run is active it periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed `agent_end` events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.

### Composer-attached panels (`components/ComposerPanels.tsx`)
- The live todo plan (`TodoList`) and the subagent roster live **pinned above
  the chat input**, not inside the scrollable message list. `ComposerPanels`
  renders both, each independently collapsible via its header row (`chevron`);
  panels start collapsed (headers always show live progress / running-summary).
  Subagent chips carry live state (pulsing dot while `started`, check/alert/ban
  for terminal states) fed by the same `subagent_lifecycle`/`subagent_progress`
  SSE frames; clicking a chip opens the transcript dialog. `TodoList` keeps a
  non-collapsible default (`collapsible` prop) for SSR tests.

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
- The raw backend-error ring keeps git read entries (the diagnostics report is a support artifact where git noise is informative) — do not "clean" them out of the ring.
- The routes skip `recordBackendError` for non-repo workspaces (`isNonRepositoryError`, `not_a_git_repository` code / "Not a Git repository" message) so a plain folder can never land an entry in the ring.
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

### Plugins and skills
- `/api/plugins` shells out to the user's `omp plugin` CLI (`list/install/uninstall/enable/disable/upgrade`, `--json` where available) — never the Bun-only SDK.
- `/api/skills` uses `lib/skills-service.ts`, a pure-Node scanner mirroring omp's discovery order: project `.omp/skills` (walk-up), `~/.omp/agent/skills`, then the `.claude` / `.agent(s)` / `.codex` / `.github` compat dirs and managed skills.
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `/api/skills/install` shells through `npx skills add ... --agent universal`, which installs into the ecosystem-standard `.agents/skills` dirs omp reads; project installs run with the selected cwd.

### Update notifications (`/api/omp-update`, `/api/app-update`)
- Automatic in-app self-updating has been removed in favor of explicit user notifications and manual terminal commands.
- `GET /api/app-update` queries the npm registry for `@Splinterjke/ompweb` updates, detects the install manager (`bun` vs `npm` via `detectInstallMethod`), and returns `updateAvailable` plus the exact terminal command (e.g. `npm install -g @Splinterjke/ompweb` or `bun add -g @Splinterjke/ompweb`).
- `POST /api/omp-update` (`action: "check"`) runs `omp update --check` and returns `updateAvailable` plus `updateCommand: "omp update"`.
- `POST /api/omp-update` (`action: "restart"`) restarts active OMP sessions after a manual CLI update.
- Notifications in `AppShell` and settings cards in `SettingsConfig` present the update notification alongside copyable terminal update commands.

### Auth and model config
- Auth flows go through RPC commands (`get_login_providers`, `login`) against the omp child process; credentials live in omp's `agent.db` (SQLite) which omp-web never touches directly.
- The Models panel reads and writes `models.yml` in the omp agent directory (`~/.omp/agent/models.yml`, `.yaml` fallback).
- API-key status endpoints must never return the raw key.

### Script schedulers — default seed (`lib/scheduler-store.ts`, `instrumentation.ts`)
- On boot, `ensureSeedSchedulers()` adds the repo's `ompweb-rebuild-restart.sh`
  to `~/.omp/agent/schedulers.json` as a **Manual launch** scheduler
  (`schedule: { kind: "manual" }`, 20 min timeout) if it isn't already there.
  This makes the rebuild workflow reachable from the "Script schedulers" panel
  without hand-entry. It's idempotent (skips when the entry or the script file
  is missing) and best-effort (a packaged install without the script is a no-op).
- Manual schedulers have `nextRunAt: null` — they never fire on the tick; the
  user triggers them via `POST /api/schedulers/[id]/run` (the panel's run button).
- `ensureSeedSchedulers` resolves the script from `process.cwd()` (the dev repo
  root or the `/opt/ompweb` install root), so it matches where the engine's
  `spawn` sets `cwd: path.dirname(script)`.

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
- Executors (`chat-event-actions-executors.ts`) never throw — every failure is recorded
  as a `lastRun` (`ok:false` + detail) so the UI can surface it. `scheduled` records
  `"scheduler busy"` when the target manual run is already running (not an error).
- Notification delivery is dual-path: per-session SSE (`chatEventPayload().emitToSession`,
  counts attached listeners) plus a globalThis bus (`chat-event-action-bus.ts`) relayed
  over the running-stream SSE (`agent/running/events`). `ok` is true only if at least one
  was delivered; the browser renders it via `AppShell` → `showBrowserNotification` and
  clicking selects the originating session.

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
