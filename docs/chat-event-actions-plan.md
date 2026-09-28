# Chat Event Actions — Implementation Plan

A new resizable sidebar section **"Chat event actions"** (below **Scheduled scripts**, above
**Usage**) where users define named actions that fire on chat lifecycle events.
Looks and behaves like the `Scheduled scripts` section (same header, resize handle, card
list, add/edit modal, toasts, confirm dialog).

---

## 1. Where it lives: **omp-web (Next.js server + client), NOT the Rust host**

Decision up front, with rationale:

| Candidate | Verdict | Why |
|---|---|---|
| **Next.js server (`lib/` + `app/api/`)** | ✅ **Yes** | All agent frames flow through `lib/rpc-manager.ts` (`handleFrame`, `lib/rpc-manager.ts:458`): `agent_start`, `agent_end`, `message_end`, `subagent_lifecycle`, and the synthesized `prompt_error` are already interpreted there. This is the natural trigger point. Storage + execution (http/bash/scheduled-script) belong next to the existing scheduler engine (`lib/scheduler-engine.ts`, `lib/scheduler-store.ts`). |
| **Rust host (`crates/ompweb-host`)** | ❌ No | The host serves file/git/settings/device/PTY services for the *desktop* geometry. It sees none of the per-session NDJSON agent frames; pumping chat events into it would add a second event bus and a second execution path for nothing. |
| **Browser only** | ❌ No (except notifications) | http/bash/scheduled-script actions must work even when no tab is open (headless runs). Only *browser notification* actions are inherently browser-side; the server dispatches them as an SSE frame the client renders. |
| **omp hooks (`.omp/hooks/pre|post`)** | ❌ No (see §4) | Runs inside the omp child process; can't reach the browser, duplicates the frame pipeline, and lacks subagent/thinking events. |

Shape (mirrors the schedulers feature end-to-end):

```
Browser                          Next.js Server                        omp child
  │  EventActionsPanel           │  chat-action-store.json              │
  ├─ CRUD ─────────────────────▶ │  /api/chat-event-actions*            │
  │                              │  dispatcher (lib/) ◀── handleFrame ──┤ frames
  ├─ SSE: chat_event_action ──── │  executors: http/bash/scheduled ─────┼──▶ spawn
  │  (notification actions)      │  broadcast frame on session/running  │
  └─ showNotification()          │                                      │
```

---

## 2. Data model & storage

New file `~/.omp/agent/chat-event-actions.json` (same agent dir as `schedulers.json`,
resolved via `lib/omp/paths.ts`; atomic temp-file + rename write, exactly like
`lib/scheduler-store.ts`).

```ts
// lib/chat-event-action-types.ts
export type ChatEventType =
  | "thinking_completed"
  | "assistant_text"        // intermediate text response (assistant message, text block)
  | "subagent_completed"
  | "user_prompt_sent"
  | "conversation_completed"
  | "conversation_interrupted"
  | "provider_api_error";

export type ActionSpec =
  | { type: "notification"; title?: string; message?: string }
  | { type: "http";
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
      url: string;
      body?: string;
      bodyContentType?: "json" | "xml" | "text";   // only for POST/PUT
      headers?: string }                             // one "Name: value" per line
  | { type: "bash"; scriptPath?: string; scriptText?: string } // at least one
  | { type: "scheduled"; schedulerId: string };      // id from schedulers.json

export interface ChatEventAction {
  id: string;                 // uuid
  name: string;
  events: ChatEventType[];    // >= 1, multi-select
  enabled: boolean;
  action: ActionSpec;
  createdAt: string;          // ISO
  updatedAt: string;          // ISO
  lastRun?: { at: string; ok: boolean; detail?: string };
}
```

Store API (in `lib/chat-event-action-store.ts`): `list()`, `get(id)`, `create(input)`,
`patch(id, subset)`, `remove(id)`, plus `recordRun(id, result)` and
`loadActionsForEvent(type)` (pre-filtered, cached, invalidated on mutation).

### Event → source-frame mapping (concrete, verifiable in code)

All trigger points are in `lib/rpc-manager.ts` `handleFrame` (or the `send()` command path),
so every event works headless, for any open or closed tab.

| Chat event | Source in rpc-manager / frames |
|---|---|
| `user_prompt_sent` | `agent_start` frame (`handleFrame` case at line 477 — fires once per submitted prompt). |
| `conversation_completed` | Terminal `agent_end` (`isTerminal !== false`, case at line 498). Same signal AppShell already uses for the built-in completion notification (`app/AppShell.tsx:979`), which also catches the `handleProcessExit` synthetic `agent_end` (line 454). |
| `conversation_interrupted` | The `abort` / `abort_and_prompt` RPC command going out through `rpc-manager.send()` (client sends these from `useAgentSession.handleAbort` / `handleInterruptAndReply`). Mark interrupt in-flight in the manager and dispatch when the command is accepted. |
| `provider_api_error` | The existing synthesized `prompt_error` (failed unsolicited `response` for `prompt`, case at line 531–547), plus `notice` frames with `level: "error"` — take whichever arrives first, dedupe per run. `auto_retry_start` also carries `errorMessage` but is a retry, not a failure — do **not** trigger on it. |
| `thinking_completed` | `message_end` frame whose message contains a completed `thinking` content block. |
| `assistant_text` | `message_end` frame for an assistant message containing a `text` content block (this is the per-turn "intermediate text" — the final turn's text also fires it, which is intended). |
| `subagent_completed` | `subagent_lifecycle` frame with a terminal status. The client already parses these (`parseSubagentLifecycle` in `hooks/useAgentSession.ts:2469`); the server gets the same raw frame — parse `payload` defensively there too. |

**Validation step (task 3):** confirm the exact content-block shape on `message_end`
(`type: "thinking" | "text"`) by inspecting one real session `.jsonl` / frame capture before
implementing the discriminator; adjust the check if blocks are shaped differently.

---

## 3. Server implementation tasks

### Task 1 — Store + types
- `lib/chat-event-action-types.ts` (model above, plus `CHAT_EVENT_TYPES` constant array —
  single source of truth for the modal's event list and i18n keys).
- `lib/chat-event-action-store.ts`: CRUD + atomic write + `lastRun` recording;
  idempotent seed: none (unlike `ensureSeedSchedulers` — no default actions).
- Test: `lib/chat-event-action-store.test.mjs` (jiti pattern, like
  `lib/browser-notifications.test.mjs`): CRUD round-trip, atomic write on corrupt file,
  `loadActionsForEvent` caching/invalidation.

### Task 2 — API routes (mirror `/api/schedulers`)
- `app/api/chat-event-actions/route.ts` — `GET` list, `POST` create.
- `app/api/chat-event-actions/[id]/route.ts` — `GET` / `PATCH` (any subset, re-validated) / `DELETE`.
- Validation rules (return 400 with stable `code`, like the scheduler routes):
  - `name` non-empty; `events` non-empty subset of `CHAT_EVENT_TYPES`.
  - `http`: `url` must parse as `http(s)://`; method in the allowed set; if POST/PUT,
    `bodyContentType` one of `json|xml|text`.
  - `bash`: `scriptPath` or `scriptText` required; if `scriptPath`, reuse the scheduler's
    path validation logic (exists + regular file, `.sh` via bash else must be executable —
    factor it out of `app/api/schedulers/validate/route.ts` into a shared `lib/schedule-validate.ts`).
  - `scheduled`: `schedulerId` must exist in `schedulers.json` (400 `unknown_scheduler` if not).
- Client facade (doc-01 contract): add `ChatEventActionClient` to `lib/client/types.ts`,
  implement `HttpChatEventActionClient` in `lib/client/http-sse-adapter.ts`, add fixture
  stub in `lib/client/fixture-adapter.ts` (next to the schedulers fixture at line 205),
  register on the `OmpwebClient` surface.

### Task 3 — Event dispatcher + frame wiring
- `lib/chat-event-actions-dispatcher.ts`:
  ```ts
  export function dispatchChatEvent(type: ChatEventType, payload: { sessionId: string; [k: string]: unknown }): void
  ```
  - Loads enabled actions matching `type`, fires each executor **fire-and-forget**
    (never blocks frame handling); one action's failure must not affect others.
  - Writes `lastRun` per action (ok/ok + detail tail, capped like the scheduler's
    `OUTPUT_TAIL_MAX`).
- Wire calls into `lib/rpc-manager.ts` `handleFrame` per the §2 table:
  `agent_start`, terminal `agent_end`, `message_end` (thinking vs text discriminator),
  `subagent_lifecycle` (terminal statuses), `prompt_error`; and into the `send()` path
  for `abort`/`abort_and_prompt` commands (interrupted).
  - Keep it one line per case (`dispatchChatEvent(...) ??` no-op) — the dispatcher is
    best-effort and must never throw into the frame loop (wrap internally in try/catch).
- Test: dispatcher unit test with a fake store + fake executors: correct actions fire for
  each event type, disabled actions skipped, multi-event actions fire once per event.

### Task 4 — Action executors
`lib/chat-event-actions-executors.ts` (one function per action type):
- **`http`**: `fetch(url, { method, headers, body })` — parse `headers` string into
  an object (`Name: value` per line, skip blank/malformed lines, first-wins on dup keys);
  `bodyContentType` sets `Content-Type` only if the user didn't set one explicitly.
  10 s timeout (`AbortSignal.timeout`). Record status + body tail in `lastRun.detail`.
- **`bash`**: if `scriptPath` → spawn it (same spawn-options logic as
  `scheduler-engine.ts:226` — `.sh` via `bash`, else direct exec); if `scriptText` →
  write to a temp file (mkstemp under the agent dir, delete after) and run via `bash`.
  60 s timeout + kill-grace, capture stdout/stderr tails (reuse `capTail`).
- **`scheduled`**: call `triggerManualRun(schedulerId)` from `lib/scheduler-engine.ts` —
  reuses serial-run semantics, timeout, and the run history (the action run shows up in
  the Scheduled scripts panel, which is desirable). 409-equivalent ("already running")
  is recorded as `ok: false, detail: "scheduler busy"`, not an error.
- **`notification`**: broadcast an SSE frame
  `{ type: "chat_event_action", actionId, title, message }` on the session's event stream
  (and the running-sessions stream as a catch-all for sessions with no attached tab).
  If no client is attached, record `ok: false, detail: "no browser attached"` — the
  browser is the only place a browser notification can render.
  - Default title/message when the user left them blank: reuse the existing completion
    strings (`appShell.sessionComplete` / `appShell.taskFinished` equivalents — server-side
    defaults: session name + "Task complete").

### Task 5 — i18n
- Add `chatActions.*` keys to the existing i18n files (section title, empty state,
  add/edit titles, event names — 7 of them, action type names, field labels,
  validation errors, toast strings). Copy the structure of the `schedulers.*` keys.

---

## 4. Hooks (`hooks-docs.md`) — assessment

Read in full. Conclusion: **useful as a reference, not as the implementation vehicle.**

- omp hooks are TS modules loaded *inside the omp child process* (`.omp/hooks/pre|post`,
  `--hook` flag, `extensions` in `config.yml`). They subscribe to omp's internal event bus
  (`agent_start`, `turn_end`, `message_end`, `session_stop`, …) and can block/transform
  tool calls.
- Why it can't be the mechanism here:
  1. **No browser reach.** A hook has no route to the omp-web browser; it could `fetch`
     the loopback API, but the auth gate (session cookie, `proxy.ts`) and the
     socket-peer HMAC preload make that fragile and ugly.
  2. **Missing events.** The hook event list has no subagent events and no
     thinking-completed event — two of our seven events would still require the client
     pipeline. Two pipelines = one feature, two places to maintain.
  3. **Trust surface.** Hooks "execute as your user" with full session access; auto-running
     user-configured actions is fine in the omp-web server (which already spawns bash for
     schedulers), but it would widen the trusted-code surface into the agent process.
  4. **Lifecycle.** Hooks require a session restart to load; omp-web actions should be
     hot-editable (save → applies to the next event), like schedulers.
- What we *do* take from it: the event-name vocabulary (naming consistency for
  `agent_start`/`agent_end`/`message_end` in the plan) and the 30 s handler-budget idea
  (our executors get explicit timeouts: 10 s http, 60 s bash — see Task 4).
- Documented as a future alternative: if users later want **agent-process-level** triggers
  (e.g. react to `tool_call` before execution), that's the hook path — out of scope here.

---

## 5. Client implementation tasks

### Task 6 — `components/EventActionsPanel.tsx` (mirror `SchedulersPanel.tsx`)
- Copy the SchedulersPanel skeleton: `Sidebar-section-header` with icon (use `Zap` or
  `Bell` from lucide-react — no inline SVG per the UI kit rules), count badge,
  `+` button, `SectionChevron`, `SeparatorHandle`, status-dot card rows, expandable
  detail, `IconButton` action row, `ConfirmDialog` delete.
- Differences from schedulers: no run-history polling (actions fire on demand) —
  the detail row shows **event list + last-run status** instead of next-run/relTime.
  No 5 s poll; refresh on open + after CRUD.
- Props: identical to SchedulersPanel (`open/onOpenChange/height/resize/headerRef/anyDragging`).

### Task 7 — `components/EventActionModal.tsx` (mirror `SchedulerModal.tsx`)
Layout per the spec — 1st line name, 2nd line event selection, 3rd line action,
then conditional controls:
1. **Name** — text `Field` (required).
2. **Events** — checkbox group of the 7 `ChatEventType`s (labels from i18n), rendered as
   a wrap-flex grid of 2 columns. (Checkbox group over a multi-select dropdown:
   the section is narrow and 7 items fit; matches the "checkboxes group" option in the
   spec and avoids a custom multi-select control. Keep the group in the modal only.)
3. **Action** — `<select>` with the 4 action types.
4. Conditional:
   - **Browser notification**: optional `title` input + optional `message` textarea
     (placeholder explains defaults are used when blank).
   - **HTTP request**: `method` select (GET/POST/PUT/PATCH/DELETE/HEAD) + `url` input;
     when method is POST/PUT: a button group (3 `radio`-style toggle buttons) for
     `json | xml | text`, a `body` textarea, and an optional `headers` textarea
     (placeholder: `Content-Type: application/json`, one header per line).
   - **Bash script**: optional `scriptPath` input (live-validated like
     SchedulerModal's `validateScript` flow, reusing the factored validation endpoint)
     + optional `scriptText` textarea (at least one required; both → path wins,
     noted in helper text).
   - **Scheduled script**: `select` populated from `client.schedulers.list()`
     (existing call — no new endpoint), showing name + human schedule.
- Save → `client.chatActions.create/patch`; validation errors from the route surface as
  `toast.error` with the mapped i18n key (same `errorText` pattern as SchedulerModal).

### Task 8 — Sidebar wiring in `components/SessionSidebar.tsx`
- New state: `eventActionsOpen` (localStorage `omp-web:event-actions-panel-open`,
  default closed), `eventActionsHeight` (`omp-web:event-actions-section-height`,
  `readStoredSectionHeight`), `eventActionsHeaderRef`.
- Resize partner chain (the existing adjacent-transfer model in
  `hooks/useSectionResize.ts`):
  - `eventActionsPartner` = schedOpen ? schedSectionPartner : (explorerRendered ?
    explorerSectionPartner : flexPartner) — same pattern as `usagePartner` (line 753).
  - `usagePartner` becomes: eventActionsOpen ? eventActionsSectionPartner : (current chain).
  - Add `eventActionsResize` to the `anyDragging` OR-chain (line 765).
- Insert `<EventActionsPanel …/>` between `<SchedulersPanel …/>` (line 2210) and
  `<UsageSidebarPanel …/>` (line 2211).

### Task 9 — Browser notification client handler
- Generalize `lib/browser-notifications.ts`: extract a `showBrowserNotification(title,
  body, onClick?, env?)` core; `showCompletionNotification` becomes a thin wrapper
  (keep its name/behavior — existing test `lib/browser-notifications.test.mjs` must
  pass unchanged).
- In `AppShell.tsx` (where the existing completion notification is wired, ~line 978):
  subscribe to the SSE `chat_event_action` frame (it arrives on the running-sessions
  stream) and call the generalized `showBrowserNotification` with `onClick` = select
  the originating session.
- **Permission**: request `Notification.permission` when the user first saves a
  notification-typed action (client-side, one `requestPermission()` call; the existing
  completion-notification flow already handles granted/default/blocked — reuse it).
- **Interaction with the built-in completion notification (open decision → default):**
  a user who adds a notification action for `conversation_completed` will get *two*
  browser notifications (the built-in one in AppShell + the action's). Default: keep the
  built-in (safety net) and document it in the modal helper text. Do **not** add
  suppression logic in v1 — it couples the two features and the built-in is the
  fallback when the server is unreachable for the SSE frame. Revisit only if users
  report the double-fire.

---

## 6. Verification

1. `node_modules/.bin/tsc --noEmit` + `npm run lint` after each task.
2. Unit tests (node `--test`, jiti): store CRUD/validation, dispatcher mapping
   (fake frames → expected action calls), header-line parser, executor edge cases
   (busy scheduler, http timeout, bash temp-file cleanup).
3. Smoke test on the dev server (`npm run dev`, port 30178, loopback per AGENTS.md):
   - create each of the 4 action types via the UI; confirm `chat-event-actions.json`
     on disk has the right shape;
   - fire a real prompt in a session and watch: `user_prompt_sent` (http action →
     `curl -X POST localhost:PORT` log), `assistant_text` (per turn),
     `subagent_completed` (run a task), `conversation_completed` (browser
     notification + http), `conversation_interrupted` (click stop → action fires),
     `provider_api_error` (point a model at a dead endpoint);
   - lastRun rows update in the panel; disabled actions don't fire;
   - resize: drag the new section's top divider; verify it transfers from the
     Schedulers section and the chain still conserves column height; reopen the page
     and confirm persisted height/open state.
4. Do NOT run any existing scheduled scripts (per session rule) — test the
   `scheduled` action type against a throwaway scheduler entry created *for the test*
   (e.g. `echo hi`) and delete it afterwards.

## 7. Follow-up housekeeping (final phase)

- `AGENTS.md`: add a "Chat event actions" entry under Architecture/File Map mirroring
  the scheduler entries (files, store location, dispatcher wiring rule — *never add a
  frame case that forgets a `dispatchChatEvent` when it matches a chat event*).
- Delete any throwaway test scheduler/script created during smoke testing.
