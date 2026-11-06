import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { existsSync, readFileSync } from "node:fs";

// React ships `act` only in its development build; force NODE_ENV before any
// React module loads so these tests work regardless of the environment's
// default (production builds throw "act(...) is not supported").
process.env.NODE_ENV = "test";
const { act, cleanup, fireEvent, render, renderHook, within } = await import("@testing-library/react/pure.js");
const React = (await import("react")).default;

// Port of the upstream behavioral harness `hooks/useAgentSession.rpc.test.mjs`
// (upstream 45b346ef) for this repo's monolithic hooks/useAgentSession.ts:
// the chat state machine driven through a controllable fake EventSource +
// fetch router via React Testing Library — connection, streaming, reconcile,
// send — not source-string checks.
//
// Adaptations from the upstream scaffolding (the local hook structurally
// lacks the mechanisms those parts drove):
// - The Edit fixtures at the end of this file attach the real
//   AgentSessionWrapper to a fake process and serve branch contexts from
//   world.views; the older blocks predate that machinery and never touch it.
// - No boundary=1 route: the local send path never pre-reads the session
//   file (upstream's snapshotRunEntries has no local counterpart), so the
//   session-file 404 that upstream #183 handled in the send path lives in
//   the hydration read here.
// - GET /api/agent/<id> answers 404 for ids the fake world does not know.
//   Upstream's stub answered 200 for ANY unknown id, which upstream's own
//   a6ebcc7e review calls out as unfaithful ("the real route resolves the
//   id against the on-disk file whenever no wrapper is alive"); this router
//   models the real app/api/agent/[id]/route.ts behavior instead.
// - Toast stub alias dropped: the local jiti config transpiles JSX
//   (hooks/useBtw.test.mjs pattern), and the ported blocks never toast. The
//   remote-host blocks at the end do, so they spy on the real `toast` object
//   the hook imports instead of a `mock.module` alias (unavailable here).
//
// Skipped upstream blocks (already landed locally without this harness —
// see the port notes): the queue-mirror suite (queue snapshot/cancel/Stop
// withdrawal — covered by the local queue port), the #167 unknown-command
// blocks (stateful send-warning in handleSend; the pure predicates are
// pinned by hooks/useAgentSession-commands.test.mjs), btw/fork/catch-up
// suites (mechanisms absent or ported differently here).

// Native `import()` throughout (bun's module registry): the hook loads natively, and jiti keeps its own cache, so
// anything imported through jiti lands on a SECOND copy of every module — the wrapped `toast`, the draft store and
// i18n the harness reads would be different objects than the ones the hook mutates (the identity checks below prove it).
const { useAgentSession, runHostTool } = await import("./useAgentSession.ts");
// The real notification history mirror: recording is server-side now (`publishNotification`), so
// the browser-side notify host tool must never touch it; no alias stub, same instance as the hook's import.
const { notificationHistory } = await import("@/lib/notification-history");
const { MessageView } = await import("@/components/MessageView");
const { ChatWindow } = await import("@/components/ChatWindow");
const { translate } = await import("@/lib/i18n");
const { AgentSessionWrapper } = await import("@/lib/rpc-manager");
const { SESSION_EDIT_COMMAND, SESSION_EDIT_RESPONSE_PREFIX } = await import("@/lib/omp/session-edit-extension.mjs");

// The remote-host blocks below assert on toasts. Upstream spies through bun's
// `mock.module`, which this harness has no equivalent of, so the real `toast`
// object the hook imports is wrapped in place; calls land as [kind, title].
const { toast } = await import("@/components/ui/toast");
const { publishSessionsChanged } = await import("@/lib/session-change-bus");
const toastCalls = [];
for (const kind of ["success", "error", "info"]) {
  toast[kind] = (title) => { toastCalls.push([kind, title]); };
}

// ---------------------------------------------------------------------------
// Fake shared-worker event streams + fetch router
// ---------------------------------------------------------------------------
/** One stream the hook opened through lib/event-stream.ts, as the worker sees it. */
class FakeStream {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  constructor(port, id, channel) {
    this.port = port;
    this.id = id;
    this.channel = channel;
    this.readyState = FakeStream.CONNECTING;
    this.closedByCaller = false;
    (channel.kind === "running" ? world.runningStreams : world.esInstances).push(this);
  }
  deliver(message) {
    this.port.onmessage?.({ data: { id: this.id, ...message } });
  }
  open() {
    if (this.closedByCaller) return;
    this.readyState = FakeStream.OPEN;
    this.deliver({ type: "open" });
    // Like the server's session channel, the `connected` frame carries the stream cursor this stream continues.
    const sid = this.channel?.sessionId;
    const web = sid ? world.streamWeb.get(sid) ?? { streamId: `stream-${sid}`, sequence: 0 } : undefined;
    this.deliver({ type: "message", data: JSON.stringify({ type: "connected", ...(web ? { web } : {}) }) });
    void dispatchOutbox();
  }
  emit(event) {
    if (this.closedByCaller) return;
    if (event.type === "agent_start") this.running = true;
    else if (event.type === "agent_end" && event.isTerminal !== false) this.running = false;
    // The session channel stamps every frame with its transport sequence (lib/event-stream-hub.ts): the
    // coalescer orders deltas against it, so the fake stream must stamp exactly like the hub does.
    const sid = this.channel?.sessionId;
    if (sid) {
      const previous = world.streamWeb.get(sid) ?? { streamId: `stream-${sid}`, sequence: 0 };
      event = { ...event, web: event.web ?? { ...previous, sequence: previous.sequence + 1 } };
      world.streamWeb.set(sid, event.web);
    }
    this.deliver({ type: "message", data: JSON.stringify(event) });
  }
  failFatal() {
    // Fatal subscription error (unmanaged wrapper): CLOSED + onerror.
    if (this.closedByCaller) return;
    this.readyState = FakeStream.CLOSED;
    this.deliver({ type: "error", readyState: FakeStream.CLOSED });
  }
}

/** The port of the worker the tab's transport started; tests flip its transport. */
let workerPort = null;

/** Speaks the tab<->worker protocol of lib/event-stream-worker.ts. */
class FakeSharedWorker {
  constructor() {
    const streams = new Map();
    let announced = false;
    this.port = {
      onmessage: null,
      start() {},
      postMessage: (message) => {
        // The default transport is the browser link: answer the tab's first word (its `wake("init")`) with the
        // transport the worker's hello carries, so commands ride the worker like they do with a live link.
        // A command in SSE mode would come back { cmd, http: true } and the tab would POST it itself.
        if (!announced) {
          announced = true;
          this.port.onmessage?.({ data: { transport: "ws" } });
        }
        if (message.op === "open") {
          streams.set(message.id, new FakeStream(this.port, message.id, message.channel));
        } else if (message.op === "close") {
          const stream = streams.get(message.id);
          if (!stream) return;
          stream.closedByCaller = true;
          stream.readyState = FakeStream.CLOSED;
        } else if (message.op === "cmd") {
          void answerCommand(this.port, message);
        } else if (message.op === "outbox_add") {
          // The worker's IndexedDB commit, then the server's dispatcher
          // (lib/message-outbox.ts) once omp is observed. The add's answer
          // lands with the commit; `world.holdAdd` defers both so a test
          // can exercise an uncommitted entry (`world.lastAdd()` commits).
          world.lastOutboxAdd = message;
          const commit = () => {
            world.outbox.push(message.entry);
            this.port.onmessage?.({ data: { outbox: world.outbox.map((entry) => ({ ...entry, state: "sending" })) } });
            void dispatchOutbox();
          };
          if (world.holdAdd) {
            world.lastAdd = () => {
              world.lastAdd = null;
              commit();
              this.port.onmessage?.({ data: { outboxAdded: message.n } });
            };
            return;
          }
          const acked = () => {
            commit();
            this.port.onmessage?.({ data: { outboxAdded: message.n } });
          };
          if (world.outboxCommit) world.outboxCommit(acked);
          else acked();
        } else if (message.op === "outbox_drop") {
          const commit = (error) => {
            if (!error) {
              world.outbox = world.outbox.filter((entry) => entry.id !== message.id);
              this.port.onmessage?.({ data: { outbox: world.outbox.map((entry) => ({ ...entry, state: entry.state ?? "sending" })) } });
            }
            this.port.onmessage?.({ data: { outboxDropped: message.n, ...(error ? { error } : {}) } });
          };
          if (world.outboxDrop) world.outboxDrop(commit);
          else commit();
        } else if (message.op === "metric") {
          // Sampled telemetry: acknowledged silently, like the worker does.
        }
      },
    };
    workerPort = this.port;
  }
}

/** A command over the session socket: `world.socketAnswer` may answer it as the worker would (e.g. transport_lost), else the agent route does. */
async function answerCommand(port, { n, sessionId, advisor, body }) {
  let answer = await world.socketAnswer?.(JSON.parse(body));
  if (!answer) {
    const res = await fetchStub(`/api/agent/${encodeURIComponent(sessionId)}${advisor ? "?advisor=1" : ""}`, { method: "POST", body });
    answer = { status: res.status, body: await res.json() };
  }
  port.onmessage?.({ data: { cmd: n, recvAt: null, repliedAt: null, attempts: 1, deduped: false, behindBytes: 0, ...answer } });
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function jsonResponse(status, value) {
  return { ok: status >= 200 && status < 300, status, json: async () => value };
}

// Backend snapshot the router serves. Tests mutate these between phases.
const world = {
  esInstances: [],
  runningStreams: [],
  calls: [],
  holds: [], // { match(method, url, body), produce: () => Promise<{ status, value }> }
  sessions: new Map(), // sid -> { leafId, messages, entryIds } served by /api/sessions/<id>
  agents: new Map(), // sid -> { running, state } served by /api/agent/<id> (the live RPC world)
  views: new Map(), // `${sid}:${leafId}:false` -> branch context served by /api/sessions/<id>/context
  nativeHistories: new Map(), // sid -> isolated, parent-linked native history fixture
  wrappers: new Map(), // sid -> live AgentSessionWrapper attached by a test
  streams: new Map(), // sid -> last wrapper event bridged onto that session's observers
  streamWeb: new Map(), // sid -> the fake stream's last web cursor { streamId, sequence } (hub-style stamping)
  btwHistory: new Map(), // sid -> BtwRecord[] served by get_btw_history
  // #403 outbox: the worker's IndexedDB ledger, the dispatcher's gates and
  // the last add (shape {op, n, entry}) the fake worker saw.
  outbox: [],
  outboxHold: false,
  outboxCommit: null,
  outboxDrop: null,
  lastOutboxAdd: null,
  /** Commit the last un-ACKed add, as the worker's IndexedDB write would. */
  lastAdd: null,
  /** Keep adds un-ACKed (uncommitted-entry tests). */
  holdAdd: false,
  /** The entry the fake dispatcher is delivering (kept in the ledger, like
   * the server's `delivering` state keeps the worker's copy). */
  outboxInflight: null,
  /** GET /state answers the host-outage 503 whose body carries the held
   * entries (`serverOutboxFor(sid)`, else this raw list). */
  hostOffline: false,
  serverOutboxFor: null,
};

/** The web server's dispatcher (lib/message-outbox.ts), as the harness sees
 * it: each held entry goes, oldest first, as the omp command its mode maps
 * to once the session's stream is open (`world.outboxHold` keeps them held). */
async function dispatchOutbox(withoutTab = false) {
  while (!world.outboxHold) {
    const entry = world.outbox.find((held) => held !== world.outboxInflight);
    if (!entry) return;
    const stream = world.esInstances.findLast(
      (es) => es.channel?.sessionId === entry.sessionId && es.readyState === FakeStream.OPEN && !es.closedByCaller,
    );
    if (!stream && !withoutTab) return;
    // The browser copy leaves the ledger only when the delivery settles
    // (the worker deletes the entry on the dispatcher's accepted answer);
    // while the command is in flight it stays listed, state "delivering".
    world.outboxInflight = entry;
    workerPort?.onmessage?.({ data: { outbox: world.outbox.map((held) => (held === entry ? { ...held, state: "delivering" } : { ...held, state: "sending" })) } });
    const running = stream?.running === true;
    const slash = running && entry.message.startsWith("/");
    const type = slash || (entry.mode === "prompt" && !running) ? "prompt" : entry.mode === "steer" && running ? "steer" : "follow_up";
    const body = {
      type,
      message: entry.message,
      ...(slash ? { streamingBehavior: entry.mode === "steer" ? "steer" : "followUp" } : {}),
      ...(entry.images ? { images: entry.images } : {}),
      ...(entry.uploads ? { uploads: entry.uploads } : {}),
      ...(entry.uploadProofs ? { uploadProofs: entry.uploadProofs } : {}),
      ...(entry.scope ? { scope: entry.scope } : {}),
    };
    const res = await fetchStub(`/api/agent/${encodeURIComponent(entry.sessionId)}`, { method: "POST", body: JSON.stringify(body) });
    if (res.ok) {
      world.outbox = world.outbox.filter((held) => held !== entry);
      world.outboxInflight = null;
      continue;
    }
    // The dispatcher keeps the entry as permanently failed and stops the
    // session's queue (the client hears it on `outbox_update`).
    const failed = { ...entry, state: "failed", error: `HTTP ${res.status}` };
    world.outbox = world.outbox.map((held) => (held === entry ? failed : held));
    world.outboxInflight = null;
    stream?.emit({ type: "outbox_update", entries: [failed], settledIds: [] });
    break;
  }
}

async function fetchStub(url, init = {}) {
  const method = (init.method ?? "GET").toUpperCase();
  const u = String(url);
  const body = typeof init.body === "string" ? safeParse(init.body) : null;
  world.calls.push({ method, url: u, body });

  for (let i = 0; i < world.holds.length; i++) {
    if (world.holds[i].match(method, u, body)) {
      const h = world.holds.splice(i, 1)[0];
      const { status = 200, value } = await h.produce();
      return jsonResponse(status, value);
    }
  }

  let m;
  if ((m = u.match(/\/api\/sessions\/([^/?#]+)\/state/))) {
    const a = world.agents.get(decodeURIComponent(m[1])) ?? { running: false, state: {} };
    return jsonResponse(200, { running: a.running, state: a.state });
  }
  if (/\/api\/sessions\/[^/?#]+\/subagents/.test(u)) {
    return jsonResponse(200, { subagents: [] });
  }
  if ((m = u.match(/\/api\/sessions\/([^/?#]+)\/context/)) && method === "GET") {
    const sid = decodeURIComponent(m[1]);
    const f = world.sessions.get(sid);
    if (!f) return jsonResponse(404, {});
    const leaf = decodeURIComponent(u.match(/[?&]leafId=([^&]*)/)?.[1] ?? "");
    const view = leaf ? world.views.get(`${sid}:${leaf}:false`) : { ...f, leafId: f.leafId };
    if (!view) return jsonResponse(404, {});
    return jsonResponse(200, {
      leafId: view.leafId,
      context: { messages: view.messages, entryIds: view.entryIds, todoPhases: [] },
    });
  }
  if ((m = u.match(/\/api\/sessions\/([^/?#]+)/)) && method === "GET") {
    const sid = decodeURIComponent(m[1]);
    const f = world.sessions.get(sid);
    if (!f) return jsonResponse(404, {});
    return jsonResponse(200, {
      sessionId: sid, filePath: f.filePath ?? "/fixture/session.jsonl", tree: f.tree ?? [],
      leafId: f.leafId,
      context: { todoPhases: [], thinkingLevel: "off", model: null, ...f },
    });
  }
  if (/^\/api\/models/.test(u)) {
    return jsonResponse(200, { models: {}, modelList: [], defaultModel: null });
  }
  if ((m = u.match(/\/api\/agent\/([^/?#]+)/))) {
    const sid = decodeURIComponent(m[1]);
    // Exception (spec O2): the outbox scope is the INSTALLATION's — the real
    // route answers it for any id, even one it cannot resolve.
    if (body?.type === "outbox_scope") {
      return jsonResponse(200, { success: true, data: { scope: "harness-scope" } });
    }
    if (method === "GET") {
      // Faithful to the real route: an id with neither a live wrapper nor an
      // on-disk file is not found (a6ebcc7e review; the stub here keeps the
      // live wrapper in world.agents, so an unknown id means both are gone).
      // Exception (spec O2): the outbox scope is the INSTALLATION's — the
      // real route answers it without resolving the session.
      const a = world.agents.get(sid);
      if (world.hostOffline) {
        // The real route's host outage answer (O2): a 503 whose body still
        // carries this session's held messages.
        return jsonResponse(503, {
          error: "Build box is offline", code: "host_offline", hostOffline: true,
          outbox: world.serverOutboxFor?.(sid) ?? world.hostOffline.body ?? [],
        });
      }
      if (!a) return jsonResponse(404, { error: "Session not found", code: "session_not_found" });
      return jsonResponse(200, { running: a.running, state: a.state });
    }
    if (method === "POST") {
      // Faithful to the real route: an id with neither a live wrapper nor an
      // on-disk session file 404s; an id whose file exists cold-spawns a
      // wrapper, which the canned acknowledgement stands in for.
      if (!world.agents.has(sid) && !world.sessions.has(sid)) {
        return jsonResponse(404, { error: "Session not found", code: "session_not_found" });
      }
      // A mounted native-history fixture answers Edit and prompts itself, so
      // the fixtures drive the real hook through a real branch-rewinding
      // boundary instead of the canned `{}` acknowledgement.
      const nativeHistory = world.nativeHistories.get(sid);
      if (nativeHistory && ["edit_message", "prompt"].includes(body?.type)) return nativeHistory.command(body);
      if (body?.type === "get_subagents") {
        return jsonResponse(200, { success: true, data: { subagents: [] } });
      }
      if (body?.type === "get_btw_history") {
        return jsonResponse(200, { success: true, data: { records: world.btwHistory.get(sid) ?? [] } });
      }
      // omp before abort_and_restore_queue rejects it (its real wording), which keeps the
      // per-entry withdrawal tests on their fallback path; tests of the atomic
      // path set what omp hands back.
      if (body?.type === "abort_and_restore_queue") {
        return world.abortRestoreQueue
          ? jsonResponse(200, { success: true, data: world.abortRestoreQueue })
          : jsonResponse(400, { error: "Unknown command: abort_and_restore_queue", code: "rpc_command_failed" });
      }
      return jsonResponse(200, { success: true, data: {} });
    }
  }
  return jsonResponse(404, {});
}

// Keep real DOM event targets and storage; only browser state and network
// boundaries need doubles. Hidden tabs use the coalescer's 50ms timer.
let visibilityState = "hidden";
const overrides = [
  [globalThis, "SharedWorker", { value: FakeSharedWorker }],
  [globalThis, "fetch", { value: fetchStub }],
  [globalThis, "ResizeObserver", { value: class { observe() {} unobserve() {} disconnect() {} } }],
  [window.HTMLElement.prototype, "scrollIntoView", { value() {} }],
  [document, "hidden", { get: () => visibilityState === "hidden" }],
  [document, "visibilityState", { get: () => visibilityState }],
  [window, "matchMedia", {
    value: (media) => Object.assign(new window.EventTarget(), { matches: false, media }),
  }],
].map(([target, key, replacement]) => ({
  target, key, replacement, original: Object.getOwnPropertyDescriptor(target, key),
}));

beforeEach(() => {
  visibilityState = "hidden";
  localStorage.clear();
  sessionStorage.clear();
  for (const { target, key, replacement } of overrides) {
    Object.defineProperty(target, key, { configurable: true, ...replacement });
  }
});

afterEach(() => {
  try {
    cleanup();
  } finally {
    for (const { target, key, original } of overrides) {
      if (original) Object.defineProperty(target, key, original);
      else delete globalThis[key];
    }
    localStorage.clear();
    sessionStorage.clear();
  }
});

// Edit only opens a confirm dialog; the edit starts from its confirm button.
async function confirmEdit(view, button) {
  await act(async () => { fireEvent.click(button); });
  await act(async () => { fireEvent.click(view.getByRole("button", { name: translate("messageView.editFromHere") })); });
}
// Wrappers built directly need an online host: this machine's, as its daemon answers, minus spawning.
const onlineHost = {
  id: "local",
  label: "This machine",
  sessionOps: {},
  status: () => "online",
  onStatus: () => () => {},
  spawnRpc: async () => { throw new Error("this test never spawns"); },
  sessionFileExists: async (path) => existsSync(path),
  invalidateSessionLists() {},
  autoApproveExtension: () => false,
};
// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run pending timers/microtasks inside act so state updates are flushed. */
async function settle(ms = 120) {
  await act(async () => {
    await sleep(ms);
  });
}

function sessionInfo(sid) {
  return {
    id: sid,
    path: "",
    cwd: "/workspace",
    name: `session ${sid}`,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "loaded question",
  };
}

async function mountSession(sid, onAgentEnd, options = {}, strictMode = false) {
  const session = sid === null ? null : sessionInfo(sid);
  const { result, unmount } = renderHook(() => useAgentSession({
    session, newSessionCwd: null, ...(onAgentEnd ? { onAgentEnd } : {}), ...options,
  }), { reactStrictMode: strictMode });
  await settle(); // hydration: loadSession + /state + models + subagents
  return {
    unmount,
    get latest() {
      return result.current;
    },
  };
}

function lastEs() {
  return world.esInstances[world.esInstances.length - 1];
}

function callsTo(method, urlPart) {
  return world.calls.filter((c) => c.method === method && c.url.includes(urlPart));
}

function resetWorld() {
  world.esInstances.length = 0;
  world.runningStreams.length = 0;
  world.calls.length = 0;
  world.holds.length = 0;
  world.sessions.clear();
  world.agents.clear();
  world.views.clear();
  world.nativeHistories.clear();
  world.wrappers.clear();
  world.streams.clear();
  world.streamWeb.clear();
  world.btwHistory.clear();
  world.abortRestoreQueue = null;
  world.outbox.length = 0;
  world.outboxHold = false;
  world.outboxCommit = null;
  world.outboxDrop = null;
  world.lastOutboxAdd = null;
  world.lastAdd = null;
  world.holdAdd = false;
  world.hostOffline = false;
  world.serverOutboxFor = null;
  world.outboxInflight = null;
  sessionStorage.clear();
}

function primeSession(sid, messages) {
  world.sessions.set(sid, {
    leafId: String(messages.length),
    messages,
    entryIds: messages.map((_, i) => `e${i}`),
  });
  world.agents.set(sid, { running: false, state: {} });
}

/** Rewrite an existing world session's transcript (same shape as primeSession). */
function saveSession(sid, messages, entryIds = messages.map((_, i) => `e${i}`)) {
  world.sessions.set(sid, { leafId: String(messages.length), messages, entryIds });
}

const userMsg = (id, text) => ({ role: "user", id, content: text, timestamp: 1 });
const assistantMsg = (id, text) => ({
  role: "assistant",
  id,
  provider: "test",
  model: "test-model",
  content: [{ type: "text", text }],
});

/** The worker's accepted-add handling: the entry leaves the browser ledger
 * and the tab hears the `stored` event (the merge keeps the bubble until a
 * snapshot settles the id). */
function fakeStoreDrop(id) {
  const entry = world.outbox.find((held) => held.id === id);
  if (!entry) return;
  world.outbox = world.outbox.filter((held) => held.id !== id);
  workerPort?.onmessage?.({ data: { outbox: world.outbox.map((held) => ({ ...held, state: "sending" })) } });
  workerPort?.onmessage?.({
    data: { outboxStored: { ...entry, mode: entry.mode ?? "prompt", state: "held", createdAt: entry.createdAt ?? 1 } },
  });
}

/** Mount + hydrate, then hold a prompt (#403: the send goes to the worker's
 * outbox, the server's dispatcher delivers it once this view's stream is
 * open) and start the run from omp's own `agent_start`. Returns the ES. */
async function startRun(sid, message, strictMode = false, options = {}) {
  const w = await mountSession(sid, undefined, options, strictMode);
  assert.equal(w.latest.loading, false, "hydration must complete");
  assert.equal(w.latest.agentRunning, false);

  let sendPromise;
  await act(async () => {
    sendPromise = w.latest.handleSend(message);
    await sleep(30); // the hold awaits its IndexedDB commit
  });
  const es = lastEs();
  assert.ok(es, "a held message opens an event stream");
  assert.deepEqual(es.channel, { kind: "session", sessionId: sid });
  await act(async () => {
    es.open(); // the dispatcher sees the session observed → the entry goes
    assert.deepEqual(await sendPromise, { status: "accepted" });
    await sleep(30); // the dispatcher's POST settles
  });
  // The dispatcher delivers the held entry as the prompt command; the
  // browser copy leaves the held list with the worker's stored event.
  await settle(60);
  assert.equal(callsTo("POST", "/api/agent/").some((c) => c.body?.type === "prompt" && c.body?.message === message), true, "prompt command must be sent");
  if (world.lastOutboxAdd) fakeStoreDrop(world.lastOutboxAdd.entry.id);
  await act(async () => {
    es.emit({ type: "agent_start" });
    await Promise.resolve();
  });
  assert.equal(w.latest.agentRunning, true, "omp's agent_start starts the run");
  return { w, es };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Port of upstream 2152c67e: a session whose only prompts were local slash
// commands never started an agent run, so omp wrote no session file: the
// session-file reads 404 while the live RPC wrapper answers normally.
// Adaptation: upstream applied the 404 tolerance inside its pre-send
// boundary read (snapshotRunEntries); the local send path performs no such
// read, so the 404 tolerance belongs to the hydration read. The send
// assertions are unchanged; the hydration assertion is STRENGTHENED (never
// weakened): hydration must not merely stop spinning but resolve the
// session through the live RPC world — the local stand-in for upstream's
// "hydration completes without a file" actually completing.
test("send tolerates a missing session file (local-only slash commands) and still dispatches", async () => {
  resetWorld();
  world.agents.set("fileless", { running: false, state: {} });
  const w = await mountSession("fileless");
  assert.equal(w.latest.loading, false, "hydration completes without a file");
  assert.equal(w.latest.agentRunning, false);
  assert.notEqual(w.latest.data, null, "hydration must resolve the session through the live RPC world, not bail on the 404");

  let sendPromise;
  await act(async () => {
    sendPromise = w.latest.handleSend("hello after skill");
    await sleep(30);
  });
  const es = lastEs();
  await act(async () => {
    es.open();
    await sendPromise;
    await settle(60); // the dispatcher's POST settles
  });
  assert.equal(
    callsTo("POST", "/api/agent/fileless").some((c) => c.body?.type === "prompt" && c.body?.message === "hello after skill"),
    true,
    "prompt must be dispatched despite the boundary 404",
  );
  assert.equal(w.latest.agentRunning, false, "the run state comes from omp's frames, not from the click");
  assert.equal(w.latest.heldMessages.length, 1, "the held bubble shows until the delivery settles");
  assert.equal(w.latest.notices.length, 0, "no failed-send notice");
});

// Second half of the 2152c67e port: on a session whose file route 404s while
// a wrapper is genuinely mid-run, hydration must restore the live run from
// the RPC world. Before the tolerance, the 404 bailed hydration before the
// state read, leaving a live run rendered as an idle, empty transcript.
test("a 404 session file with a live wrapper mid-run hydrates the run from the RPC world", async () => {
  resetWorld();
  // No session file (never written, or unreadable — the file route 404s
  // both), while /api/agent answers the live wrapper state.
  world.agents.set("corrupt-midrun", { running: true, state: { isStreaming: true, isPromptRunning: false } });
  const w = await mountSession("corrupt-midrun");
  assert.equal(w.latest.loading, false, "hydration completes without a file");
  assert.equal(w.latest.agentRunning, true, "the live run must be restored, not shown idle");
  assert.ok(
    world.esInstances.some((e) => e.channel.kind === "session" && e.channel.sessionId === "corrupt-midrun"),
    "the observer stream must attach to the restored run",
  );
});

// Port of upstream a6ebcc7e (REVIEW #165): on THIS repo's server a fileless
// session with a live wrapper already gets a synthesized empty transcript
// from the file route (app/api/sessions/[id]/route.ts:174-209 — the local
// equivalent of upstream aa617860), modeled here by the hold. Upstream's
// own note applies: this already dispatches on the unfixed client; it pins
// that the guarantee cannot regress.
test("REVIEW #165: a fileless LIVE session already gets an empty baseline, so main dispatches", async () => {
  resetWorld();
  world.agents.set("fileless-live", { running: true, state: { isStreaming: false, isPromptRunning: false } });
  world.holds.push({
    // The local route answers the session GET itself (upstream answered
    // the boundary read); same semantics: live wrapper vouches, empty
    // baseline, no 404.
    match: (method, url) => method === "GET" && url.startsWith("/api/sessions/fileless-live?"),
    produce: async () => ({
      status: 200,
      value: {
        sessionId: "fileless-live", filePath: "", tree: [], leafId: null,
        context: { messages: [], entryIds: [], todoPhases: [], thinkingLevel: "off", model: null },
      },
    }),
  });
  const w = await mountSession("fileless-live");
  assert.equal(w.latest.loading, false);

  let sendPromise;
  await act(async () => {
    sendPromise = w.latest.handleSend("hello after skill");
    await sleep(30);
  });
  const es = lastEs();
  await act(async () => {
    es.open();
    await sendPromise;
  });
  assert.equal(
    callsTo("POST", "/api/agent/fileless-live").some((c) => c.body?.type === "prompt" && c.body?.message === "hello after skill"),
    true,
    "unfixed main already dispatches when the live wrapper answers the baseline",
  );
  assert.equal(w.latest.notices.length, 0, "no failed-send notice");
  assert.equal(w.latest.agentRunning, false, "#403: the run state waits for omp's agent_start");
});

// Port of upstream a6ebcc7e (guardrail): a vanished session with neither a
// wrapper nor a file must still fail loudly — the fileless tolerance must
// not swallow a real error. The faithful GET /api/agent 404 for unknown ids
// makes the hydration probe bail exactly like the real route.
test("a vanished session's permanent outbox refusal remains a failed held bubble, not a recovered composer draft", async () => {
  resetWorld();
  primeSession("gone", [userMsg("u0", "q")]);
  const w = await mountSession("gone");
  await act(async () => { assert.deepEqual(await w.latest.handleSend("anyone there?"), { status: "accepted" }); });
  const entry = world.outbox[0];
  await act(() => workerPort.onmessage({ data: { outbox: [] } }));
  await act(() => lastEs().emit({ type: "outbox_update", entries: [{ ...entry, mode: "prompt", state: "failed", error: "Session not found", createdAt: entry.createdAt }] }));
  assert.equal(w.latest.agentRunning, false);
  assert.equal(w.latest.heldMessages[0].state, "failed");
  assert.equal(w.latest.heldMessages[0].error, "Session not found");
  assert.deepEqual(w.latest.notices, [], "the held bubble owns permanent delivery errors");
  w.unmount();
});

// Guardrail: a session that exists on disk still dispatches through the
// outbox even when its file route 404s — see the 404-wrapper test below.
// Port of upstream a6ebcc7e (REVIEW #183): an EXISTING but unresolvable
// session file 404s the file route while the wrapper still takes commands —
// aborting the send there loses the message. Adaptation: the boundary hold
// is dropped because the local send performs no boundary read; the file
// 404 is modeled by the absent sessions entry (router 404s
// /api/sessions/corrupt like the malformed-file route).
test("REVIEW a 404 session read on a live wrapper (unreadable file / wrapper died) still dispatches", async (t) => {
  resetWorld();
  world.agents.set("corrupt", { running: true, state: { isStreaming: false, isPromptRunning: false } });
  const w = await mountSession("corrupt");
  let sendPromise;
  await act(async () => {
    sendPromise = w.latest.handleSend("keep talking");
    await sleep(30);
  });
  const es = lastEs();
  await act(async () => {
    es.open();
    await sendPromise;
  });
  assert.equal(
    callsTo("POST", "/api/agent/corrupt").some((c) => c.body?.type === "prompt" && c.body?.message === "keep talking"),
    true,
    "the prompt must be dispatched despite the boundary 404",
  );
  assert.equal(w.latest.notices.length, 0, "no failed-send notice");
  t.diagnostic("session-file 404 tolerated on a live wrapper");
});

// Port of upstream e0304060 (#187): reconcileAgentState applied
// state.contextUsage only on its idle branch, so a genuinely busy poll
// threw away valid usage and the ring filled in only from the terminal
// snapshot. Continuing an old conversation shows it: the transcript has no
// live usage until the new request runs, so the ring sat empty for the
// whole generation. (Locally the 2s live sampler is the primary ring
// source; within this test window it never fires, which is exactly the
// exposure this reconcile poll covers — it is the only sub-2s reader of
// /api/agent mid-run.)
test("ISSUE #187 the context ring fills mid-run while the agent is still streaming", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startRun("s1", "q1");
  await act(async () => {
    es.emit({ type: "agent_start" });
    es.emit({ type: "message_update", message: assistantMsg("a1", "streaming") });
    await Promise.resolve();
  });
  await settle(90);
  assert.ok(!w.latest.contextUsage, "a continued conversation starts with no live usage");

  // The server has real usage while the run is genuinely busy — it used to
  // be dropped, so the ring stayed blank until the run ended.
  world.holds.push({
    match: (method, url) => method === "GET" && url.includes("/api/agent/s1"),
    produce: () => ({
      status: 200,
      value: { running: true, state: { isStreaming: true, contextUsage: { percent: 42, contextWindow: 200000, tokens: 84000 } } },
    }),
  });
  await act(async () => {
    es.emit({ type: "todo_reminder" }); // triggers the mid-run reconcile poll
    await sleep(30);
  });
  await settle();
  assert.deepEqual(w.latest.contextUsage, { percent: 42, contextWindow: 200000, tokens: 84000 });
  assert.equal(w.latest.agentRunning, true, "applying usage must not finish a busy run");
});

// The merged goal bar is ONE surface: a live native goal and the web /goal
// marker share the themed row, so dropping the native goal must also clear
// the marker — otherwise the row falls back to the plain "Goal active" line
// and the goal appears undroppable.
test("dropping a native goal clears the web /goal marker for that session", async () => {
  resetWorld();
  const sid = "goal-drop";
  primeSession(sid, [userMsg("u1", "question")]);
  const marker = JSON.stringify({ objective: "Ship the fix", startedAt: Date.now() - 60_000 });
  sessionStorage.setItem(`omp-web:goal:${sid}`, marker);
  sessionStorage.setItem("omp-web:goal:other-session", JSON.stringify({ objective: "Another goal", startedAt: Date.now() }));

  const w = await mountSession(sid);
  assert.ok(w.latest.activeGoal, "the marker must hydrate the web goal on mount");

  await act(async () => {
    await w.latest.sendGoalCommand("drop");
  });
  const dropCall = callsTo("POST", "/api/agent/").find((c) => c.body?.type === "goal" && c.body?.op === "drop");
  assert.ok(dropCall, "the drop command must reach the wrapper");
  assert.equal(sessionStorage.getItem(`omp-web:goal:${sid}`), null, "the marker must be cleared with the native goal");
  assert.equal(w.latest.activeGoal, null, "the row must not linger on the dropped goal");
  assert.ok(sessionStorage.getItem("omp-web:goal:other-session"), "only the dropped session's marker may be cleared");
});
// Web /goal stays PASSIVE: sending it must never arm the native tracker —
// an implicit create armed omp's continuation loop silently, which burned
// ~10k tokens in seconds on a passive "wait for a trigger word" rule. The
// native create goes out only when the user presses the marker row's
// explicit "Track natively" control (trackGoal).
test("web /goal stays passive; only trackGoal arms the native tracker", async () => {
  resetWorld();
  const sid = "goal-passive";
  primeSession(sid, [userMsg("u1", "start")]);
  const w = await mountSession(sid);

  // Same handshake as startRun: the send waits for the stream to connect,
  // which only settles when the fake EventSource is opened.
  let builtinPromise;
  await act(async () => {
    builtinPromise = w.latest.handleBuiltinSlashCommand("/goal answer ok to ко");
    await sleep(30); // let the pre-connect get_state POST settle
  });
  await act(async () => {
    lastEs()?.open(); // connect settles → prompt POST fires
    const result = await builtinPromise;
    assert.equal(result.handled, true);
  });
  assert.equal(w.latest.activeGoal?.objective, "answer ok to ко", "the web marker must be set");
  const promptCall = callsTo("POST", "/api/agent/").find((c) => c.body?.type === "prompt");
  assert.ok(promptCall, "the /goal prompt must be sent");
  assert.ok(promptCall.body.message.includes("answer ok to ко"), "the objective must reach the prompt");
  assert.equal(
    callsTo("POST", "/api/agent/").some((c) => c.body?.type === "goal" && c.body?.op === "create"),
    false,
    "sending /goal must not arm the tracker — no implicit create (the mount read is fine)",
  );

  await act(async () => {
    await w.latest.trackGoal();
  });
  const createCall = callsTo("POST", "/api/agent/").find((c) => c.body?.type === "goal" && c.body?.op === "create");
  assert.ok(createCall, "the explicit track action must send goal create");
  assert.equal(createCall.body.objective, "answer ok to ко", "the tracked objective is the marker objective");
});

// The `/goal` marker is set by the builtin handler, so a `/goal …` typed
// with attached files must come through here (ChatInput routes it) and the
// expanded prompt must carry the images — the bug was the attachment path
// skipping the handler altogether, leaving both the marker and the
// instruction missing.
test("web /goal with attachments sends the prompt with the images and sets the marker", async () => {
  resetWorld();
  const sid = "goal-attachments";
  primeSession(sid, [userMsg("u1", "start")]);
  const w = await mountSession(sid);

  const images = [{ data: "ZGF0YQ==", mimeType: "image/png", previewUrl: "blob:preview" }];
  let builtinPromise;
  await act(async () => {
    builtinPromise = w.latest.handleBuiltinSlashCommand("/goal review the diagram", images);
    await sleep(30);
  });
  await act(async () => {
    lastEs()?.open();
    const result = await builtinPromise;
    assert.equal(result.handled, true);
  });
  assert.equal(w.latest.activeGoal?.objective, "review the diagram", "the web marker must be set even with attachments");
  const promptCall = callsTo("POST", "/api/agent/").find((c) => c.body?.type === "prompt");
  assert.ok(promptCall, "the /goal prompt must be sent");
  assert.ok(promptCall.body.message.includes("review the diagram"));
  assert.deepEqual(promptCall.body.images, [{ type: "image", data: "ZGF0YQ==", mimeType: "image/png" }], "the attachments must ride the expanded prompt");
});

test("upload ids ride the prompt and follow-up bodies; a files-only prompt is sent", async () => {
  resetWorld();
  primeSession("uploads", [userMsg("u0", "q")]);
  const id = "0f0e0d0c-0b0a-4908-8706-050403020100";
  const w = await mountSession("uploads");
  let sending;
  await act(async () => {
    sending = w.latest.handleSend("", undefined, [id]);
    await sleep(30);
  });
  await act(async () => {
    lastEs().open();
    await sending;
  });
  const prompt = callsTo("POST", "/api/agent/").find((call) => call.body?.type === "prompt");
  assert.deepEqual(prompt?.body.uploads, [id]);
  await act(async () => { await w.latest.handleFollowUp("and this", undefined, [id]); });
  assert.deepEqual(callsTo("POST", "/api/agent/").find((call) => call.body?.type === "follow_up")?.body.uploads, [id]);
});

test("a shell-queued outbox prompt and steer use queue_update without a phantom turn or reply notice", async () => {
  resetWorld();
  primeSession("bash-queue", [userMsg("u0", "q")]);
  // The agent route answers a prompt/steer with this while a `!` shell command
  // owns the session (see lib/rpc-manager.ts queueWhileShellRunning).
  const queuedReply = { success: true, data: { queued: true, queue: "followUp", reason: "shellRunning" } };
  const holdReply = () => world.holds.push({
    match: (method, _url, body) => method === "POST" && (body?.type === "prompt" || body?.type === "steer"),
    produce: () => Promise.resolve({ value: queuedReply }),
  });
  holdReply();
  holdReply();
  const w = await mountSession("bash-queue");
  let sending;
  await act(async () => {
    sending = w.latest.handleSend("after the shell finishes");
    await sleep(30);
  });
  await act(async () => { lastEs()?.open(); await sending; await settle(60); });
  assert.equal((await sending).status, "accepted");
  assert.equal(w.latest.agentRunning, false, "no turn started behind the shell command");
  assert.deepEqual(
    w.latest.messages.filter((message) => message.role === "user").map((message) => message.content),
    ["q"],
    "the text lives in omp's queue, not in a transcript bubble",
  );
  assert.deepEqual(w.latest.notices, [], "the dispatcher reply never creates a tab-owned queue notice");
  await act(async () => { await w.latest.handleSteer("steer instead"); await settle(30); });
  await act(() => lastEs().emit({ type: "queue_update", steering: [], followUp: ["after the shell finishes", "steer instead"] }));
  assert.deepEqual(w.latest.queuedMessages, { steering: [], followUp: ["after the shell finishes", "steer instead"] });
  assert.deepEqual(w.latest.notices, []);
});


test("Stop takes queued input back through omp in one step, including a steer the snapshot missed", async () => {
  const { getDraft, clearDraft } = await import("@/lib/draft-store");
  resetWorld();
  clearDraft("abort-atomic");
  primeSession("abort-atomic", [userMsg("u0", "loaded question")]);
  const { w } = await startRun("abort-atomic", "hello agent");
  world.abortRestoreQueue = {
    steering: [{ text: "steer the snapshot missed" }, { text: "[Image]" }],
    followUp: [
      { text: "later follow-up", images: [{ type: "image", data: "x", mimeType: "image/png" }] },
      { text: "[Image]", images: [{ type: "image", data: "y", mimeType: "image/webp" }] },
    ],
  };

  await act(async () => { await w.latest.handleAbort(); });

  const commands = world.calls.map((c) => c.body?.type).filter(Boolean);
  assert.equal(commands.filter((type) => type === "abort_and_restore_queue").length, 1);
  assert.equal(commands.includes("abort"), false, "omp's own abort already stopped the run");
  assert.equal(commands.includes("remove_queued_message"), false);
  assert.equal(getDraft("abort-atomic")?.value, "steer the snapshot missed\n\n[Image]\n\nlater follow-up", "only an image-only message's label is dropped");
  assert.deepEqual(getDraft("abort-atomic")?.images, [{ data: "x", mimeType: "image/png" }, { data: "y", mimeType: "image/webp" }]);
  assert.deepEqual(w.latest.notices, []);
  clearDraft("abort-atomic");
});

const isAtomicStop = (method, _url, body) => method === "POST" && body?.type === "abort_and_restore_queue";

test("a failed atomic Stop is retried once and restores what omp still held", async () => {
  const { getDraft, clearDraft } = await import("@/lib/draft-store");
  resetWorld();
  clearDraft("abort-atomic-retry");
  primeSession("abort-atomic-retry", [userMsg("u0", "loaded question")]);
  const { w } = await startRun("abort-atomic-retry", "hello agent");
  world.holds.push({ match: isAtomicStop, produce: async () => ({ status: 502, value: { error: "Bad Gateway" } }) });
  world.abortRestoreQueue = { steering: [{ text: "retry me" }], followUp: [] };

  await act(async () => { await w.latest.handleAbort(); });

  const commands = world.calls.map((c) => c.body?.type).filter(Boolean);
  assert.equal(commands.filter((type) => type === "abort_and_restore_queue").length, 2);
  assert.equal(commands.includes("abort"), false, "a failure is not mistaken for an omp without the command");
  assert.equal(commands.includes("remove_queued_message"), false);
  assert.equal(getDraft("abort-atomic-retry")?.value, "retry me");
  assert.deepEqual(w.latest.notices, []);
  clearDraft("abort-atomic-retry");
});

test("an atomic Stop whose texts were lost with a failed response warns", async () => {
  resetWorld();
  primeSession("abort-atomic-lost", [userMsg("u0", "loaded question")]);
  const { w } = await startRun("abort-atomic-lost", "hello agent");
  // omp withdrew and aborted, but the answer never arrived; the queue is empty now.
  world.holds.push({ match: isAtomicStop, produce: async () => ({ status: 502, value: { error: "Bad Gateway" } }) });
  world.abortRestoreQueue = { steering: [], followUp: [] };

  await act(async () => { await w.latest.handleAbort(); });

  assert.equal(world.calls.some((c) => c.body?.type === "abort"), false);
  assert.deepEqual(w.latest.notices.map((n) => n.type), ["warning"]);
});

test("a failed atomic Stop never retries into a run started after the click", async () => {
  resetWorld();
  primeSession("abort-atomic-fenced", [userMsg("u0", "loaded question")]);
  const { w, es } = await startRun("abort-atomic-fenced", "hello agent");
  let release;
  world.holds.push({ match: isAtomicStop, produce: () => new Promise((resolve) => { release = resolve; }) });
  world.abortRestoreQueue = { steering: [], followUp: [] };
  let stop;
  await act(async () => { stop = w.latest.handleAbort(); });
  await act(async () => {
    es.emit({ type: "message_end", message: assistantMsg("a1", "answer") });
    es.emit({ type: "agent_end", isTerminal: true });
  });
  await settle();
  let sending;
  await act(async () => { sending = w.latest.handleSend("next prompt"); await sleep(30); });
  await act(async () => { lastEs().open(); await sending; });
  await act(async () => {
    release({ status: 502, value: { error: "Bad Gateway" } });
    await stop;
  });

  assert.equal(world.calls.some((c) => c.body?.type === "prompt" && c.body?.message === "next prompt"), true);
  assert.equal(world.calls.filter((c) => c.body?.type === "abort_and_restore_queue").length, 1, "no retry into the new run");
  assert.equal(world.calls.some((c) => c.body?.type === "abort"), false, "nor a fallback abort");
});

test("overlapping Stops share one atomic withdrawal; an image-only entry does not come back as text", async () => {
  const { getDraft, clearDraft } = await import("@/lib/draft-store");
  resetWorld();
  clearDraft("abort-atomic-twice");
  primeSession("abort-atomic-twice", [userMsg("u0", "loaded question")]);
  const { w } = await startRun("abort-atomic-twice", "hello agent");
  world.abortRestoreQueue = {
    steering: [{ text: "[Image]", images: [{ type: "image", data: "x", mimeType: "image/png" }] }],
    followUp: [{ text: "words" }],
  };

  await act(async () => { await Promise.all([w.latest.handleAbort(), w.latest.handleAbort()]); });

  assert.equal(world.calls.filter((c) => c.body?.type === "abort_and_restore_queue").length, 1);
  assert.equal(getDraft("abort-atomic-twice")?.value, "words");
  clearDraft("abort-atomic-twice");
});

// 453ea585: image-returning remove_queued_message (can1357/oh-my-pi#14179).
// Edit restores these images; only { data, mimeType } entries survive.
test("removeQueuedMessage resolves to the removed message's filtered images", async () => {
  resetWorld();
  primeSession("queued-edit", [userMsg("u0", "loaded question")]);
  const { w } = await startRun("queued-edit", "hello agent");
  await act(async () => {
    lastEs().emit({ type: "queue_update", steering: [], followUp: ["target"] });
  });
  world.holds.push({
    match: (method, _url, body) => method === "POST" && body?.type === "remove_queued_message",
    produce: async () => ({
      status: 200,
      value: { success: true, data: { removed: true, images: [{ type: "image", data: "AAAA", mimeType: "image/png" }, { bogus: true }] } },
    }),
  });
  let cancellation;
  await act(async () => { cancellation = w.latest.removeQueuedMessage("target", "followUp"); });
  await act(async () => {
    assert.deepEqual(await cancellation, [{ data: "AAAA", mimeType: "image/png" }], "malformed entries are dropped");
  });
});

// ---------------------------------------------------------------------------
// Slow toggle + provider usage-limit badge (port of upstream 892399be).
// ---------------------------------------------------------------------------

const SLOW_MODEL = { provider: "anthropic", id: "claude-test" };
const SLOW_STATE = { stage: "low_priority", resetsAtSec: 1770000000, allowanceLeftPercent: 62 };

test("opening a session past its Claude usage limit shows the badge, and an idle /slow off clears it", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  world.agents.set("s1", { running: false, state: { model: SLOW_MODEL, usageLimit: SLOW_STATE } });
  const { w, es } = await startRun("s1", "q1");
  assert.deepEqual(w.latest.usageLimit, SLOW_STATE, "opening past the limit shows the badge");

  // End the run with the limit still breached: the badge survives the run.
  await act(async () => { es.emit({ type: "agent_end", isTerminal: true }); });
  await settle(300);
  assert.deepEqual(w.latest.usageLimit, SLOW_STATE, "an ending run without /slow off keeps the badge");

  // Idle slash refresh (prompt_result with agentInvoked:false): /slow off
  // changes session state without a run, and the re-read must clear the badge.
  world.agents.set("s1", { running: false, state: { model: SLOW_MODEL } });
  await act(async () => { es.emit({ type: "prompt_result", agentInvoked: false }); });
  await settle();
  assert.equal(w.latest.usageLimit, undefined, "the idle slash refresh clears the badge");
});

test("an outbox message survives unmount and is dispatched without its tab", async () => {
  resetWorld();
  primeSession("connecting-unmount", [userMsg("u0", "q")]);
  const w = await mountSession("connecting-unmount");
  let sending;
  await act(async () => {
    sending = w.latest.handleSend("switched chats mid-send");
    await sleep(30);
  });
  const source = lastEs();
  assert.ok(source, "the held message opens an observer, but delivery does not wait for it");
  let result;
  await act(async () => {
    w.unmount();
    result = await sending;
  });
  assert.equal(source.closedByCaller, true);
  assert.equal(result.status, "accepted");
  assert.equal(world.outbox[0]?.message, "switched chats mid-send", "the worker retains the message after its tab unmounts");
  await dispatchOutbox(true);
  assert.deepEqual(world.outbox, []);
  assert.equal(world.calls.filter((call) => call.body?.type === "prompt").length, 1);
  assert.equal(world.esInstances.length, 1, "no observer is opened for the unmounted chat");
  for (const type of ["set_host_tools", "set_host_uri_schemes", "get_subagents"]) {
    assert.equal(world.calls.some((call) => call.body?.type === type), false, `no ${type} for the unmounted chat`);
  }
});

test("a failed observer connection leaves the accepted message held in the outbox", async () => {
  resetWorld();
  primeSession("connecting-fails", [userMsg("u0", "q")]);
  const w = await mountSession("connecting-fails");
  let sending;
  await act(async () => {
    sending = w.latest.handleSend("stays held");
    await sleep(30);
  });
  let result;
  await act(async () => {
    lastEs().failFatal();
    result = await sending;
  });
  assert.equal(result.status, "accepted");
  assert.equal(world.outbox[0]?.message, "stays held");
  assert.deepEqual(w.latest.notices, []);
  assert.equal(world.calls.some((call) => call.body?.type === "prompt"), false, "a closed observer dispatches nothing");
  w.unmount();
});

// The prompt half of this teardown guard is upstream's "an outbox message
// survives unmount and is dispatched without its tab" (ported above): a held
// send owns no startup RPC anymore. The side question still starts its
// wrapper through `get_state`, so that path keeps the fence.
test("unmount during btw RPC startup cannot create an observer after teardown", async (t) => {
  resetWorld();
  const sid = "startup-unmount-btw";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  let release;
  t.after(() => release?.());
  world.holds.push({
    match: (method, url, body) => method === "POST" && url === `/api/agent/${sid}` && body?.type === "get_state",
    produce: () => new Promise((resolve) => { release = () => resolve({ value: { success: true, data: {} } }); }),
  });
  let pending;
  await act(async () => {
    pending = w.latest.askBtw("must stay unasked");
    await sleep(20);
  });
  assert.equal(typeof release, "function", "the supported startup RPC must be awaiting its response");
  assert.equal(world.esInstances.length, 0, "startup has not yet acquired its observer");
  let result;
  await act(async () => {
    w.unmount();
    release();
    result = await pending;
  });
  // (renderHook's unmount already completed the root's cleanup here.)
  assert.equal(world.esInstances.length, 0, "a late RPC response cannot create an observer its owner cannot close");
  assert.equal(result, false);
  // A side question has no UI left to answer into.
  assert.equal(world.calls.some((call) => call.body?.type === "btw"), false);
});

/** Mount + hydrate, start the run, and stream one assistant delta. */
async function startStreamingRun(sid) {
  const { w, es } = await startRun(sid, "q1");
  await act(async () => {
    es.emit({ type: "agent_start" });
    es.emit({ type: "message_update", message: assistantMsg("a1", "streaming") });
    await Promise.resolve();
  });
  await settle(90);
  assert.equal(w.latest.agentRunning, true);
  return { w, es };
}

test("the usage-limit badge appears mid-run and clears when the run ends without it", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startStreamingRun("s1");
  world.agents.set("s1", { running: true, state: { isStreaming: true, model: SLOW_MODEL, usageLimit: SLOW_STATE } });
  // The in-run sample ticks every 2s; wait for it rather than a fixed sleep.
  // (Identity wait becomes a deep compare: the stub round-trips JSON.)
  for (let waited = 0; JSON.stringify(w.latest.usageLimit) !== JSON.stringify(SLOW_STATE) && waited < 5000; waited += 250) await settle(250);
  assert.deepEqual(w.latest.usageLimit, SLOW_STATE);

  primeSession("s1", [userMsg("u0", "q"), assistantMsg("a1", "done")]);
  world.agents.set("s1", { running: false, state: { model: SLOW_MODEL } });
  await act(async () => { es.emit({ type: "agent_end", isTerminal: true }); });
  await settle();
  assert.equal(w.latest.usageLimit, undefined);
});

test("the Slow toggle follows omp's per-model state and is cleared by a switch to an unsupported model", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  world.agents.set("s1", { running: true, state: { isStreaming: true, model: SLOW_MODEL, slowModeSupported: true, slowModeEnabled: true } });
  const w = await mountSession("s1");
  assert.equal(w.latest.slowModeSupported, true);
  assert.equal(w.latest.slowModeEnabled, true);

  // A model without /slow reports supported:false and omits enabled; the
  // persisted Claude setting may still be on, but it must not show as pressed.
  world.agents.set("s1", { running: true, state: { model: { provider: "openrouter", id: "other" }, slowModeSupported: false } });
  await act(async () => { lastEs().emit({ type: "model_changed" }); });
  await settle();
  assert.equal(w.latest.slowModeSupported, false);
  assert.equal(w.latest.slowModeEnabled, false);
});

/** Mounts s1 with Slow at `enabled`, answers the next set_slow_mode with `answer`, and parks the follow-up state refresh so only the command's answer can move the toggle. */
async function mountSlowToggle(enabled, answer) {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  world.agents.set("s1", { running: true, state: { model: SLOW_MODEL, slowModeSupported: true, slowModeEnabled: enabled, slowModeScope: "global" } });
  const w = await mountSession("s1");
  assert.equal(w.latest.slowModeEnabled, enabled);
  world.holds.push({
    match: (method, _url, body) => method === "POST" && body?.type === "set_slow_mode",
    produce: async () => answer,
  });
  world.holds.push({
    match: (method, url) => method === "GET" && url === "/api/sessions/s1/state",
    produce: () => new Promise(() => {}),
  });
  return w;
}

for (const enabled of [false, true]) {
  test(`turning Slow ${enabled ? "on" : "off"} sends set_slow_mode and applies omp's answer`, async () => {
    const w = await mountSlowToggle(!enabled, { value: { success: true, data: { enabled } } });
    const posted = world.calls.length;
    await act(async () => { await w.latest.handleSlowModeChange(enabled); });
    const command = world.calls.slice(posted).find((call) => call.body?.type === "set_slow_mode");
    assert.deepEqual(command?.body, { type: "set_slow_mode", enabled });
    assert.equal(w.latest.slowModeEnabled, enabled);
    assert.deepEqual(w.latest.notices, []);
  });
}

test("a refused set_slow_mode leaves the toggle as it was and shows omp's error", async () => {
  const refusal = "Slow mode is unavailable for the current model.";
  const w = await mountSlowToggle(false, { status: 400, value: { error: refusal } });
  await act(async () => { await w.latest.handleSlowModeChange(true); });
  assert.equal(w.latest.slowModeEnabled, false);
  assert.deepEqual(w.latest.notices.map((n) => [n.type, n.message]), [["error", refusal]]);
});

test("the Slow scope follows omp's state and clears with support", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  world.agents.set("s1", { running: true, state: { isStreaming: true, model: SLOW_MODEL, slowModeSupported: true, slowModeEnabled: false, slowModeScope: "global" } });
  const w = await mountSession("s1");
  assert.equal(w.latest.slowModeScope, "global");

  world.agents.set("s1", { running: true, state: { model: { provider: "openai", id: "gpt-test" }, slowModeSupported: true, slowModeEnabled: false, slowModeScope: "session" } });
  await act(async () => { lastEs().emit({ type: "model_changed" }); });
  await settle();
  assert.equal(w.latest.slowModeScope, "session");

  world.agents.set("s1", { running: true, state: { model: { provider: "openrouter", id: "other" }, slowModeSupported: false } });
  await act(async () => { lastEs().emit({ type: "model_changed" }); });
  await settle();
  assert.equal(w.latest.slowModeScope, undefined);
});

// ---------------------------------------------------------------------------
// Skill startup diagnostics (port of upstream 631be73e).
// Adaptations: the local harness attaches an EventSource during mount only
// for a running/streaming session (the Slow-toggle pattern), so states that
// later receive emitted frames carry isStreaming:true; the fresh-chat tests
// register their created id in world.agents because this router is faithful
// to the real route and 404s POSTs for unknown ids.
// ---------------------------------------------------------------------------

const btwRecord = (overrides = {}) => ({
  id: "b1", leafId: null, question: "what is 2+2", answer: "", status: "running", createdAt: 1, updatedAt: 1, ...overrides,
});

function holdBtwCommand(type, produce) {
  world.holds.push({ match: (method, _url, body) => method === "POST" && body?.type === type, produce });
}

function skillDiagnosticsSnapshot(showStartupDiagnostics, name = "review") {
  return {
    cwd: "/workspace",
    showStartupDiagnostics,
    diagnostics: [{
      name,
      reason: "source-order",
      skills: [
        { name, filePath: `/workspace/.agents/skills/${name}/SKILL.md`, source: "project" },
        { name, filePath: `/home/me/.agents/skills/${name}/SKILL.md`, source: "user", pluginName: "shared" },
      ],
      duplicates: [{
        skill: { name, filePath: `/mirror/.agents/skills/${name}/SKILL.md`, source: "custom" },
        retained: { name, filePath: `/workspace/.agents/skills/${name}/SKILL.md`, source: "project" },
      }],
    }],
  };
}

test("skill diagnostics hydrate from state and follow defensive live updates", async () => {
  resetWorld();
  primeSession("skill-state", [userMsg("u0", "q")]);
  const initial = skillDiagnosticsSnapshot(true);
  world.agents.set("skill-state", {
    running: true,
    state: {
      isStreaming: true,
      skillDiagnostics: {
        ...initial,
        diagnostics: [{
          ...initial.diagnostics[0],
          skills: initial.diagnostics[0].skills.map((skill) => ({ ...skill, body: "private" })),
          privateDiagnostic: true,
        }],
        privateSnapshot: true,
      },
    },
  });

  const w = await mountSession("skill-state");
  assert.deepEqual(w.latest.skillDiagnostics, initial, "get_state hydration recovers a startup frame emitted before SSE attached");

  const updated = skillDiagnosticsSnapshot(false, "deploy");
  await act(() => lastEs().emit({
    type: "skill_diagnostics_update",
    data: { ...updated, containRoot: "/private" },
  }));
  assert.deepEqual(w.latest.skillDiagnostics, updated);

  await act(() => lastEs().emit({
    type: "skill_diagnostics_update",
    data: { cwd: "/workspace", showStartupDiagnostics: true, diagnostics: "none" },
  }));
  assert.equal(w.latest.skillDiagnostics, null, "malformed data is unsupported, not a fabricated clean result");

  const recovered = skillDiagnosticsSnapshot(true, "recovered");
  world.agents.set("skill-state", { running: true, state: { isStreaming: true, skillDiagnostics: recovered } });
  await act(async () => {
    lastEs().open();
    await sleep(30);
  });
  assert.deepEqual(w.latest.skillDiagnostics, recovered, "stream attachment reconciles an update emitted before SSE attached");
});

/** Start the startup-diagnostics setter with its POST held. `respond` answers the held POST; `saving` is the hook's promise. */
async function startHeldSkillSetter(w, sid, enabled) {
  let respond;
  world.holds.push({
    match: (method, url, body) => method === "POST" && url.includes(`/api/agent/${sid}`) && body?.type === "set_skill_startup_diagnostics",
    produce: () => new Promise((resolve) => { respond = (data) => resolve({ value: { success: true, data } }); }),
  });
  let saving;
  await act(async () => {
    saving = w.latest.setSkillStartupDiagnostics(enabled);
    await sleep(20);
  });
  // The test awaits `saving` itself; this only keeps a failed assertion from leaving an unhandled rejection behind.
  saving.catch(() => {});
  return { saving, respond: (data) => respond(data) };
}

test("the startup diagnostics setter publishes OMP's effective snapshot and rejects unsupported replies", async () => {
  resetWorld();
  primeSession("skill-actions", [userMsg("u0", "q")]);
  const on = skillDiagnosticsSnapshot(true);
  const off = skillDiagnosticsSnapshot(false);
  world.agents.set("skill-actions", { running: false, state: { skillDiagnostics: on } });
  const w = await mountSession("skill-actions");
  assert.deepEqual(w.latest.skillDiagnostics, on);

  world.holds.push({
    match: (method, url, body) => method === "POST" && url.includes("/api/agent/skill-actions") && body?.type === "set_skill_startup_diagnostics",
    produce: async () => ({ value: { success: true, data: off } }),
  });
  let disabled;
  await act(async () => {
    disabled = await w.latest.setSkillStartupDiagnostics(false);
  });
  assert.deepEqual(disabled, off);
  assert.deepEqual(w.latest.skillDiagnostics, off, "the effective snapshot replaces the previous one");

  world.holds.push({
    match: (method, url, body) => method === "POST" && url.includes("/api/agent/skill-actions") && body?.type === "set_skill_startup_diagnostics",
    produce: async () => ({ value: { success: true, data: off } }),
  });
  let overridden;
  await act(async () => {
    overridden = await w.latest.setSkillStartupDiagnostics(true);
  });
  assert.deepEqual(overridden, off, "an override that keeps the setting off is returned as the effective value, not the requested one");
  assert.deepEqual(w.latest.skillDiagnostics, off);

  world.holds.push({
    match: (method, url, body) => method === "POST" && url.includes("/api/agent/skill-actions") && body?.type === "set_skill_startup_diagnostics",
    produce: async () => ({ value: { success: true, data: { cwd: "/workspace", showStartupDiagnostics: false, diagnostics: null } } }),
  });
  await assert.rejects(() => w.latest.setSkillStartupDiagnostics(false), /skill diagnostics/i);
  assert.deepEqual(w.latest.skillDiagnostics, off, "a malformed response cannot erase the last supported snapshot");
  await assert.rejects(() => w.latest.setSkillStartupDiagnostics("false"), /boolean/i);
});

test("the startup diagnostics setter does not start an empty chat and rejects stale session responses", async () => {
  resetWorld();
  const empty = await mountSession(null);
  const callsBefore = world.calls.length;
  await assert.rejects(() => empty.latest.setSkillStartupDiagnostics(false), /active session/i);
  assert.equal(world.calls.length, callsBefore, "no active session means no lazy child-start request");

  primeSession("old-skills", [userMsg("u0", "old")]);
  const old = await mountSession("old-skills");
  const held = await startHeldSkillSetter(old, "old-skills", false);
  old.unmount();

  primeSession("current-skills", [userMsg("u0", "current")]);
  const current = await mountSession("current-skills");
  held.respond(skillDiagnosticsSnapshot(false, "stale"));
  await assert.rejects(held.saving, /stale/i);
  assert.equal(current.latest.skillDiagnostics, null, "the previous chat cannot update the selected chat");
});

test("a saved setting whose own update frame beats the HTTP response resolves to the saved snapshot", async () => {
  resetWorld();
  primeSession("skill-own-frame", [userMsg("u0", "q")]);
  const enabled = skillDiagnosticsSnapshot(true, "own-frame");
  world.agents.set("skill-own-frame", { running: true, state: { isStreaming: true, skillDiagnostics: enabled } });
  const w = await mountSession("skill-own-frame");
  assert.deepEqual(w.latest.skillDiagnostics, enabled);

  const { saving, respond } = await startHeldSkillSetter(w, "skill-own-frame", false);
  const saved = skillDiagnosticsSnapshot(false, "own-frame");
  try {
    // OMP emits the update frame before it answers the command.
    await act(() => lastEs().emit({ type: "skill_diagnostics_update", data: saved }));
    assert.deepEqual(w.latest.skillDiagnostics, saved);
  } finally {
    respond(saved);
  }
  let result;
  await act(async () => {
    result = await saving;
  });
  assert.deepEqual(result, saved, "the control reports the saved setting instead of a stale failure");
  assert.deepEqual(w.latest.skillDiagnostics, saved);
});

test("a setter response overtaken by a newer update returns the current snapshot without rolling it back", async () => {
  resetWorld();
  primeSession("skill-newer-frame", [userMsg("u0", "q")]);
  world.agents.set("skill-newer-frame", { running: true, state: { isStreaming: true, skillDiagnostics: skillDiagnosticsSnapshot(true, "before") } });
  const w = await mountSession("skill-newer-frame");

  const { saving, respond } = await startHeldSkillSetter(w, "skill-newer-frame", false);
  const newer = skillDiagnosticsSnapshot(false, "after-reload");
  try {
    await act(() => lastEs().emit({ type: "skill_diagnostics_update", data: newer }));
  } finally {
    respond(skillDiagnosticsSnapshot(false, "answered-before-reload"));
  }
  let result;
  await act(async () => {
    result = await saving;
  });
  assert.deepEqual(result, newer);
  assert.deepEqual(w.latest.skillDiagnostics, newer, "the older response never replaces a newer update");
});

test("a state snapshot requested before a newer skill update cannot overwrite it when it resolves late", async () => {
  resetWorld();
  primeSession("skill-order", [userMsg("u0", "q")]);
  world.agents.set("skill-order", { running: true, state: { isStreaming: true, skillDiagnostics: skillDiagnosticsSnapshot(true, "startup") } });
  const w = await mountSession("skill-order");

  let release;
  world.holds.push({
    match: (method, url) => method === "GET" && url === "/api/agent/skill-order",
    produce: () => new Promise((resolve) => {
      release = () => resolve({ value: { running: true, state: { skillDiagnostics: skillDiagnosticsSnapshot(true, "stale-state") } } });
    }),
  });
  const newer = skillDiagnosticsSnapshot(false, "newer-update");
  try {
    await act(async () => {
      lastEs().open(); // stream attachment requests an authoritative state snapshot
      await sleep(20);
    });
    assert.ok(release, "precondition: the snapshot request is still in flight");
    await act(() => lastEs().emit({ type: "skill_diagnostics_update", data: newer }));
    assert.deepEqual(w.latest.skillDiagnostics, newer);
  } finally {
    release?.();
  }
  await act(async () => {
    await sleep(30);
  });
  assert.deepEqual(w.latest.skillDiagnostics, newer, "the late older snapshot is dropped");
});

test("a fresh chat hydrates and follows skill diagnostics after slash discovery creates its runtime", async () => {
  resetWorld();
  const startup = skillDiagnosticsSnapshot(true, "fresh-startup");
  world.holds.push({
    match: (method, url) => method === "POST" && url === "/api/agent/new",
    produce: async () => ({ value: { sessionId: "fresh-skills" } }),
  });
  world.agents.set("fresh-skills", { running: true, state: { skillDiagnostics: startup } });
  const w = await mountSession(null, undefined, { newSessionCwd: "/workspace" });
  assert.equal(w.latest.skillDiagnostics, null, "an empty new-chat page has no runtime or diagnostics");
  assert.deepEqual(world.esInstances, [], "mounting an empty new chat must not attach a stream");

  await act(async () => { await w.latest.loadSlashCommands(); });
  const es = lastEs();
  assert.deepEqual(es?.channel, { kind: "session", sessionId: "fresh-skills" }, "the created runtime must be observed before its first prompt");
  await act(async () => {
    es.open();
    await sleep(30);
  });
  assert.deepEqual(w.latest.skillDiagnostics, startup, "the startup frame emitted before attachment is recovered from state");

  const updated = skillDiagnosticsSnapshot(false, "fresh-updated");
  await act(() => es.emit({ type: "skill_diagnostics_update", data: updated }));
  assert.deepEqual(w.latest.skillDiagnostics, updated, "live diagnostics follow the created runtime");
  assert.equal(callsTo("POST", "/api/agent/fresh-skills").some((call) => call.body?.type === "prompt"), false, "discovery never starts a model run");
  w.unmount();
});

test("a fresh chat runtime created after unmount cannot attach or apply skill diagnostics", async () => {
  resetWorld();
  let release;
  world.holds.push({
    match: (method, url) => method === "POST" && url === "/api/agent/new",
    produce: () => new Promise((resolve) => { release = () => resolve({ value: { sessionId: "stale-fresh" } }); }),
  });
  world.agents.set("stale-fresh", { running: true, state: { skillDiagnostics: skillDiagnosticsSnapshot(true, "stale-fresh") } });
  const w = await mountSession(null, undefined, { newSessionCwd: "/workspace" });
  let discovery;
  await act(async () => {
    discovery = w.latest.loadSlashCommands();
    await sleep(20);
    w.unmount();
  });
  await act(async () => {
    release();
    await discovery;
    await sleep(30);
  });
  assert.deepEqual(world.esInstances, [], "a stale create must not leak an event stream");
  assert.equal(callsTo("GET", "/api/agent/stale-fresh").length, 0, "a stale create must not request diagnostics for a switched chat");
  assert.equal(w.latest.skillDiagnostics, null);
});

test("a fresh chat's first prompt attaches one event stream instead of an observer plus its own", async () => {
  resetWorld();
  world.holds.push({
    match: (method, url) => method === "POST" && url === "/api/agent/new",
    produce: async () => ({ value: { sessionId: "fresh-send" } }),
  });
  world.agents.set("fresh-send", { running: true, state: {} });
  const w = await mountSession(null, undefined, { newSessionCwd: "/workspace", onSessionCreated: () => {} });
  let sent;
  await act(async () => {
    sent = w.latest.handleSend("first prompt");
    await sleep(30); // create the runtime and attach the prompt's stream
  });
  const streamsBeforeOpen = world.esInstances.length;
  let delivered;
  // Settle the send before asserting, so a failed assertion leaves no run behind.
  await act(async () => {
    lastEs().open();
    delivered = await sent;
  });
  w.unmount();
  assert.equal(delivered.status, "accepted");
  assert.equal(streamsBeforeOpen, 1, "the prompt owns the only stream");
  assert.equal(world.esInstances.length, 1);
  assert.equal(callsTo("POST", "/api/agent/fresh-send").some((call) => call.body?.type === "prompt"), true);
});

test("a fresh chat's /btw question attaches one event stream instead of an observer plus its own", async () => {
  resetWorld();
  world.holds.push({
    match: (method, url) => method === "POST" && url === "/api/agent/new",
    produce: async () => ({ value: { sessionId: "fresh-btw" } }),
  });
  world.agents.set("fresh-btw", { running: true, state: {} });
  holdBtwCommand("btw", async () => ({ value: { success: true, data: { record: btwRecord() } } }));
  const w = await mountSession(null, undefined, { newSessionCwd: "/workspace", onSessionCreated: () => {} });
  let asked;
  await act(async () => {
    asked = w.latest.handleBuiltinSlashCommand("/btw what is 2+2");
    await sleep(30); // create the runtime and attach the question's stream
  });
  const streamsBeforeOpen = world.esInstances.length;
  let result;
  // Settle the question before asserting, so a failed assertion leaves no request behind.
  await act(async () => {
    lastEs().open();
    result = await asked;
  });
  w.unmount();
  assert.deepEqual(result, { handled: true });
  assert.equal(streamsBeforeOpen, 1, "the question owns the only stream");
  assert.equal(world.esInstances.length, 1);
});

test("the notify host tool stays out of the Notifications tab, which lists only server-recorded notification types", async () => {
  const result = await runHostTool("notify", { title: "Build done", message: "All green" }, { openUrl: () => "" });
  assert.deepEqual(result, { text: "Notification shown", isError: false });
  // Only `publishNotification` records; the notify host tool shows an OS notification and nothing else.
  assert.deepEqual(notificationHistory.get(), []);
});

test("an open_file local:// call asks the server for the calling session's file and opens the absolute path it names", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  world.holds.push({
    match: (method, url) => method === "GET" && url.includes("/api/sessions/s1/local-file"),
    produce: async () => ({ value: { path: "/sessions/s1/local/note.md" } }),
  });
  const opened = [];
  const { es } = await startRun("s1", "q1", false, { onOpenFile: (path, name, sessionId) => { opened.push([path, name, sessionId]); } });
  await act(async () => {
    es.emit({ type: "host_tool_call", id: "h1", toolCallId: "c1", toolName: "open_file", arguments: { path: "local://note.md" } });
    await sleep(60);
  });

  const lookups = callsTo("GET", "/api/sessions/s1/local-file");
  assert.equal(lookups.length, 1, "one lookup, for the session that asked");
  assert.equal(new URL(lookups[0].url, "http://localhost").searchParams.get("uri"), "local://note.md");
  assert.deepEqual(opened, [["/sessions/s1/local/note.md", "note.md", { sessionId: "s1", hostId: "local", cwd: "/workspace" }]]);
  const answer = callsTo("POST", "/api/agent/s1").find((call) => call.body?.type === "host_tool_result");
  assert.deepEqual([answer?.body.id, answer?.body.isError, answer?.body.result.content[0].text], ["h1", false, "Opened local://note.md"]);
});

test("an open_file local:// tab is owned by the session the server resolved, while the answer goes to the caller", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  world.holds.push({
    match: (method, url) => method === "GET" && url.includes("/api/sessions/s1/local-file"),
    produce: async () => ({ value: { path: "/tmp/omp-local/s1-moved/note.md", sessionId: "s1-moved" } }),
  });
  const opened = [];
  const { es } = await startRun("s1", "q1", false, { onOpenFile: (...args) => { opened.push(args); } });
  await act(async () => {
    es.emit({ type: "host_tool_call", id: "owned", toolName: "open_file", arguments: { path: "local://note.md" } });
    await sleep(60);
  });
  assert.deepEqual(opened, [["/tmp/omp-local/s1-moved/note.md", "note.md", { sessionId: "s1-moved", hostId: "local", cwd: "/workspace" }]]);
  const answer = callsTo("POST", "/api/agent/s1").find((call) => call.body?.type === "host_tool_result");
  assert.deepEqual([answer?.body.id, answer?.body.isError], ["owned", false], "the caller still gets the answer");
});

test("a lookup pending when the chat's stream dies is withdrawn, not answered or opened later", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  let release;
  world.holds.push({
    match: (method, url) => method === "GET" && url.includes("/api/sessions/s1/local-file"),
    produce: () => new Promise(resolve => { release = () => resolve({ value: { path: "/sessions/s1/local/note.md" } }); }),
  });
  const opened = [];
  const { es } = await startRun("s1", "q1", false, { onOpenFile: (...args) => { opened.push(args); } });
  await act(async () => {
    es.emit({ type: "host_tool_call", id: "dropped", toolName: "open_file", arguments: { path: "local://note.md" } });
    await sleep(10);
  });
  assert.equal(typeof release, "function", "the lookup is pending");
  // The stream closed for good, so the tab withdrew its own pending lookup; the answer the server never got reaches no one.
  await act(async () => { es.failFatal(); });
  await act(async () => { release(); await settle(); });
  assert.deepEqual(opened, [], "no tab opens for a call the server already settled");
  const answer = callsTo("POST", "/api/agent/s1").find(call => call.body?.type === "host_tool_result" && call.body.id === "dropped");
  assert.equal(answer, undefined, "no late result for an already-rejected call");
});

test("an open_file local:// call whose lookup fails answers the agent with that error and opens nothing", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const lookupError = "File not found in this session's local:// directory";
  world.holds.push({
    match: (method, url) => method === "GET" && url.includes("/api/sessions/s1/local-file"),
    produce: async () => ({ status: 404, value: { error: lookupError, code: "file_not_found" } }),
  });
  const opened = [];
  const { es } = await startRun("s1", "q1", false, { onOpenFile: (path, name, sessionId) => { opened.push([path, name, sessionId]); } });
  await act(async () => {
    es.emit({ type: "host_tool_call", id: "h2", toolCallId: "c2", toolName: "open_file", arguments: { path: "local://absent.md" } });
    await sleep(60);
  });

  assert.deepEqual(opened, [], "no tab opens for a file that is not there");
  const answer = callsTo("POST", "/api/agent/s1").find((call) => call.body?.type === "host_tool_result");
  assert.deepEqual([answer?.body.id, answer?.body.isError, answer?.body.result.content[0].text], ["h2", true, lookupError]);
});

test("canceling a pending file open leaves other requests and a later run untouched", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  let release;
  world.holds.push({
    match: (method, url) => method === "GET" && url.includes("/api/sessions/s1/local-file"),
    produce: () => new Promise(resolve => { release = () => resolve({ value: { path: "/sessions/s1/local/canceled.md" } }); }),
  });
  const opened = [];
  const { w, es } = await startRun("s1", "q1", false, { onOpenFile: (...args) => { opened.push(args); } });
  await act(async () => {
    es.emit({ type: "host_tool_call", id: "canceled-open", toolName: "open_file", arguments: { path: "local://canceled.md" } });
    await sleep(10);
  });
  assert.equal(typeof release, "function");
  await act(async () => {
    es.emit({ type: "host_tool_cancel", targetId: "canceled-open" });
    es.emit({ type: "host_tool_call", id: "other-open", toolName: "open_file", arguments: { path: "/workspace/other.md" } });
    es.emit({ type: "agent_start" });
    release();
    await settle();
  });
  assert.deepEqual(opened, [["/workspace/other.md", "other.md", { sessionId: "s1", hostId: "local", cwd: "/workspace" }]]);
  assert.equal(w.latest.agentRunning, true);
  const answers = callsTo("POST", "/api/agent/s1").filter(call => call.body?.type === "host_tool_result");
  assert.ok(answers.some(call => call.body.id === "other-open" && !call.body.isError));
  assert.ok(!answers.some(call => call.body.id === "canceled-open"), "a withdrawn request is not answered later");
});

test("a delayed local-file lookup cannot open a tab after its chat unmounts", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  primeSession("s2", [userMsg("u0", "another chat")]);
  let release;
  world.holds.push({
    match: (method, url) => method === "GET" && url.includes("/api/sessions/s1/local-file"),
    produce: () => new Promise(resolve => { release = () => resolve({ value: { path: "/sessions/s1/local/note.md" } }); }),
  });
  const opened = [];
  const { w, es } = await startRun("s1", "q1", false, { onOpenFile: (...args) => { opened.push(args); } });
  await act(async () => {
    es.emit({ type: "host_tool_call", id: "late-open", toolName: "open_file", arguments: { path: "local://note.md" } });
    await sleep(10);
  });
  assert.equal(typeof release, "function", "the original session's lookup is pending");
  await act(async () => { w.unmount(); });
  await mountSession("s2");
  await act(async () => { release(); await settle(); });
  assert.deepEqual(opened, [], "the previous chat cannot take over the new view");
  const answer = callsTo("POST", "/api/agent/s1").find(call => call.body?.type === "host_tool_result");
  assert.equal(answer, undefined, "leaving the chat must not send a late callback that could restart its child");
});

test("a delayed local-file lookup keeps the identity its call arrived under across an Edit move", async (t) => {
  resetWorld();
  const sid = "file-open-before-move";
  const target = `${sid}-owned`;
  const native = primeEditableHistory(sid);
  native.moveTo = target;
  await attachEditableWrapper(t, native);
  const opened = [];
  const w = await mountEditableSession(sid, { onOpenFile: (...args) => { opened.push(args); } });
  // This fork attaches a session's stream with a run, so one turn happens before the tab can be sent a host tool call.
  await act(async () => { fireEvent.change(w.view.getByRole("textbox"), { target: { value: "one turn" } }); });
  let send;
  await act(async () => { fireEvent.click(w.view.getByRole("button", { name: "Submit replacement" })); send = w.sending; });
  await until(() => world.esInstances.some((stream) => stream.channel?.sessionId === sid), "the send attaches the session stream");
  const es = lastEs();
  await act(async () => { es.open(); await send; });
  // The agent asks to open a session artifact and the lookup hangs; then the run ends.
  let release;
  world.holds.push({
    match: (method, url) => method === "GET" && url.includes(`/api/sessions/${sid}/local-file`),
    produce: () => new Promise(resolve => { release = () => resolve({ value: { path: `/sessions/${target}/local/note.md` } }); }),
  });
  await act(async () => {
    es.emit({ type: "host_tool_call", id: "moved-open", toolName: "open_file", arguments: { path: "local://note.md" } });
    await sleep(10);
  });
  assert.equal(typeof release, "function", "the lookup is pending");
  await act(async () => { es.emit({ type: "agent_end", isTerminal: true }); await settle(); });
  // Idle again, the conversation is edited, and the Edit relocates it to a new id.
  await act(async () => { assert.equal(await w.latest.handleEdit("entry-u2", "U2-original"), true); });
  await until(() => w.latest.sessionIdRef.current === target, "the confirmed Edit moves the conversation to the new id");
  await act(async () => { release(); await settle(); });
  assert.deepEqual(opened, [[`/sessions/${target}/local/note.md`, "note.md", { sessionId: sid, hostId: "local", cwd: "/workspace" }]], "the late open carries the identity the call arrived under");
  const answer = callsTo("POST", `/api/agent/${sid}`).find(call => call.body?.type === "host_tool_result");
  assert.equal(answer?.body.isError, false);
});

test("a reconcile tick during the cold-send window keeps the optimistic bubble and the running state", async () => {
  resetWorld();
  const sid = "cold-send-race";
  primeSession(sid, [userMsg("u1", "loaded question"), assistantMsg("a1", "loaded answer")]);
  const w = await mountSession(sid);
  assert.equal(w.latest.loading, false);
  assert.equal(w.latest.agentRunning, false);

  // Send on an existing session whose wrapper is idle and whose stream is
  // closed: the send awaits the stream attach, and while it waits the
  // server legitimately reports NOT running — the prompt has not been
  // dispatched yet. The recovery-net reconcile must not read that as a
  // lost run: before the fix it erased the optimistic user bubble and the
  // running state until the spawn landed (the "prompt disappears" symptom).
  let sendPromise;
  await act(async () => {
    sendPromise = w.latest.handleSend("second question");
    await sleep(30); // optimistic bubble minted; EventSource not opened yet
  });
  const es = lastEs();
  assert.ok(es, "an EventSource must have been created");

  await act(async () => {
    window.dispatchEvent(new Event("online")); // immediate reconcile trigger
    await sleep(30);
  });
  // #403: the send is browser-held while its stream connects; a reconcile
  // tick during that window must keep the held bubble and start no run.
  const held = w.latest.heldMessages;
  assert.equal(held.length, 1, "the held bubble survives the reconcile tick");
  assert.equal(held[0].message, "second question");
  assert.equal(w.latest.agentRunning, false, "the run state waits for omp's frames");

  // The normal flow still converges: the dispatcher delivers, omp echoes.
  await act(async () => {
    es.open();
    await sendPromise;
    await settle(60);
  });
  assert.equal(callsTo("POST", "/api/agent/").some((c) => c.body?.type === "prompt" && c.body?.message === "second question"), true, "the held prompt is dispatched");
  assert.equal(w.latest.agentRunning, false, "dispatch alone starts no run");
  await act(async () => {
    es.emit({ type: "agent_start" });
    es.emit({ type: "message_end", message: { role: "user", content: "second question" } });
  });
  const userRows = w.latest.messages.filter((m) => m.role === "user");
  assert.equal(userRows.length, 2, "omp's echo lands the prompt exactly once");
  await act(async () => {
    es.emit({ type: "outbox_update", entries: [], settledIds: [held[0].id] });
  });
  assert.deepEqual(w.latest.heldMessages, [], "the settle snapshot retires the held bubble");
  await act(async () => {
    es.emit({ type: "agent_end", isTerminal: true });
  });
  assert.equal(w.latest.agentRunning, false);
  w.unmount();
});
test("a failed model switch is shown as a notice instead of failing silently (#277)", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  Object.assign(world.sessions.get("s1"), { model: { provider: "test", modelId: "old-model" }, thinkingLevel: "low" });
  const w = await mountSession("s1");
  assert.equal(w.latest.displayModel.modelId, "old-model");
  world.holds.push({
    match: (method, _url, body) => method === "POST" && body?.type === "set_model",
    produce: async () => ({
      status: 500,
      value: { error: "omp exited (code 1, signal none): error: Could not restore model test/old-model" },
    }),
  });
  await act(async () => { await w.latest.handleModelChange("test", "chosen-model"); });
  await settle();
  assert.equal(w.latest.displayModel.modelId, "old-model", "a failed switch must not claim the new model");
  assert.equal(w.latest.notices.at(-1)?.type, "error");
  assert.match(w.latest.notices.at(-1)?.message ?? "", /Could not restore model/);
});

// ---------------------------------------------------------------------------
// Edit (rewind-and-resend) fixtures — port of upstream f7d4066e's
// `Edit rewinds and resends…`, `cancelled and failed Edits…` and
// `native Edit relocation…` blocks.
// Adaptations: drafts are image-only on this client (no `files` sidecar);
// wrapper events are the web events themselves (no `.web` indirection); the
// wrapper is built with this repo's five-argument constructor. The upstream
// root-ownership machinery (TestRoot/ownRoot + teardown leak assertions) is
// dropped together with the unmount-race blocks that motivated it.
// ---------------------------------------------------------------------------

/** Poll a condition with act() drains so React state can settle. */
async function until(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) assert.fail(`timed out: ${message}`);
    await act(async () => { await sleep(10); });
  }
}

// A native boundary, not an Edit callback double: active context follows parent
// links in the persisted JSONL, and prompts consume that context independently
// of what the hook happens to render. Metadata leaves never become model text.
function primeEditableHistory(originalSid, messages = [
  userMsg("u1", "U1"), assistantMsg("a1", "A1"),
  userMsg("u2", "U2-original"), assistantMsg("a2", "A2-original"),
  userMsg("u3", "U3-original"), assistantMsg("a3", "A3-original"),
]) {
  let sid = originalSid;
  let filePath = `/fixture/${sid}.jsonl`;
  const header = { type: "session", version: 3, id: sid, cwd: "/workspace", timestamp: "2026-01-01T00:00:00.000Z" };
  let entries = messages.map((message, index) => ({
    type: "message", id: `entry-${message.id}`,
    parentId: index === 0 ? null : `entry-${messages[index - 1].id}`,
    timestamp: header.timestamp, message: structuredClone(message),
  }));
  let jsonl;
  const persistedFiles = new Map();
  let editGate = Promise.resolve();
  let editReplyGate = Promise.resolve();
  let promptGate = Promise.resolve();

  function context(leafId = entries.at(-1)?.id ?? null) {
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const branch = [];
    for (let entry = byId.get(leafId); entry; entry = byId.get(entry.parentId)) branch.push(entry);
    const messageEntries = branch.reverse().filter((entry) => entry.type === "message");
    return { leafId, entryIds: messageEntries.map((entry) => entry.id), messages: structuredClone(messageEntries.map((entry) => entry.message)) };
  }

  function persist() {
    jsonl = [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    persistedFiles.set(filePath, jsonl);
    const nodes = new Map(entries.map((entry) => [entry.id, { entry: structuredClone(entry), children: [] }]));
    const roots = [];
    for (const entry of entries) {
      const parent = nodes.get(entry.parentId);
      (parent ? parent.children : roots).push(nodes.get(entry.id));
      world.views.set(`${sid}:${entry.id}:false`, context(entry.id));
    }
    world.sessions.set(sid, { ...context(), filePath, tree: roots });
  }

  const native = {
    get sessionId() { return sid; },
    get filePath() { return filePath; },
    edits: [], prompts: [], editOutcome: "success", moveTo: null, onMove: null,
    persistedFiles,
    get jsonl() { return jsonl; },
    get entries() { return structuredClone(entries); },
    get leafId() { return entries.at(-1)?.id ?? null; },
    holdEdit() {
      let release;
      editGate = new Promise((resolve) => { release = resolve; });
      return release;
    },
    holdEditReply() {
      let release;
      editReplyGate = new Promise((resolve) => { release = resolve; });
      return release;
    },
    holdPrompt() {
      let release;
      promptGate = new Promise((resolve) => { release = resolve; });
      return release;
    },
    reopen() {
      const [persistedHeader, ...persistedEntries] = jsonl.trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(persistedHeader.id, sid, "reopening must retain the persisted session identity");
      entries = persistedEntries;
      persist();
      world.agents.set(sid, { running: false, state: {} });
    },
    async command(body) {
      if (body.type === "edit_message") {
        const target = entries.find((entry) => entry.id === body.entryId);
        assert.equal(target?.type, "message", "Edit must address a persisted entry, not message.id");
        assert.equal(target.message.role, "user", "native Edit only accepts user entries");
        native.edits.push(body.entryId);
        await editGate;
        let response;
        if (native.editOutcome === "error" || native.editOutcome === "persistence-error") {
          response = jsonResponse(400, { error: native.editOutcome === "persistence-error"
            ? "Could not append session file: disk full" : "Native history navigation failed" });
        } else if (native.editOutcome === "cancelled") {
          response = jsonResponse(200, {
            success: true, data: { cancelled: true, sessionId: sid, leafId: native.leafId },
          });
        } else {
          if (native.moveTo && native.moveTo !== sid) {
            const previousId = sid;
            sid = native.moveTo;
            filePath = `/fixture/${sid}.jsonl`;
            header.id = sid;
            world.nativeHistories.set(sid, native);
            world.agents.set(sid, world.agents.get(previousId));
            native.onMove?.(previousId, sid);
          }
          entries.push({
            type: "custom", customType: "omp-web-history-navigation", id: `edit-marker-${native.edits.length}`,
            parentId: target.parentId, timestamp: header.timestamp, data: { entryId: target.id },
          });
          persist();
          response = jsonResponse(200, { success: true, data: { cancelled: false, sessionId: sid, leafId: native.leafId } });
        }
        // The native change and its SSE can precede this client's HTTP reply.
        await editReplyGate;
        return response;
      }
      await promptGate;
      const number = native.prompts.length + 1;
      entries.push({
        type: "message", id: `entry-replacement-${number}`, parentId: native.leafId, timestamp: header.timestamp,
        message: userMsg(`replacement-${number}`, body.message),
      });
      persist();
      native.prompts.push({ sessionId: sid, filePath, ...context() });
      world.agents.set(sid, { running: true, state: { isStreaming: true, isPromptRunning: true } });
      return jsonResponse(200, { success: true, data: null });
    },
    completePrompt(stream) {
      assert.equal(stream.channel.sessionId, sid);
      const number = native.prompts.length;
      const message = assistantMsg(`revised-answer-${number}`, "A2-revised");
      entries.push({ type: "message", id: `entry-revised-answer-${number}`, parentId: native.leafId, timestamp: header.timestamp, message });
      persist();
      world.agents.set(sid, { running: false, state: { isStreaming: false, isPromptRunning: false } });
      stream.emit({ type: "agent_start" });
      stream.emit({ type: "message_end", message });
      stream.emit({ type: "agent_end", isTerminal: true });
    },
  };
  persist();
  world.nativeHistories.set(sid, native);
  world.agents.set(sid, { running: false, state: {} });
  return native;
}

// Exercise the real server identity registry callback and Edit helper protocol.
// Only the native process/file boundary is controlled; history frames originate
// in AgentSessionWrapper, not from a second simulated edit implementation.
async function attachEditableWrapper(t, native, { holdHistory = false } = {}) {
  const listeners = new Set();
  const historyFrames = [];
  const identityChanges = [];
  let protocolNegotiated = false;
  const emitNative = (frame) => { for (const listener of [...listeners]) listener(frame); };
  const wrapper = new AgentSessionWrapper({
    isAlive: true,
    async waitReady() { return { type: "ready", protocolVersion: 2 }; },
    async negotiateProtocol() { protocolNegotiated = true; },
    onFrame(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async sendCommand(command) {
      assert.equal(protocolNegotiated, true, "commands must wait for readiness and protocol negotiation");
      if (command.type === "get_state") return {
        sessionId: native.sessionId, sessionFile: native.filePath,
        isStreaming: world.agents.get(native.sessionId)?.state?.isStreaming ?? false,
        isCompacting: false, isSettled: true, hasPendingAsyncWork: false, queuedMessageCount: 0,
      };
      if (command.type === "get_available_commands") return { commands: [{ name: SESSION_EDIT_COMMAND, source: "extension" }] };
      if (command.type === "prompt" && command.message.startsWith(`/${SESSION_EDIT_COMMAND} `)) {
        const request = JSON.parse(command.message.slice(SESSION_EDIT_COMMAND.length + 2));
        const response = await native.command({ type: "edit_message", entryId: request.entryId });
        const value = await response.json();
        if (native.editOutcome === "persistence-error") {
          emitNative({ type: "notice", source: "session-persistence", level: "error", message: value.error });
        }
        emitNative({ type: "extension_ui_request", method: "notify", message: SESSION_EDIT_RESPONSE_PREFIX + JSON.stringify({
          requestId: request.requestId, ...(response.ok ? value.data : { error: value.error }),
        }) });
        return { agentInvoked: false };
      }
      if (command.type === "prompt") { await native.command(command); return { agentInvoked: true }; }
      return {};
    },
    sendFrame() {},
    async dispose() { listeners.clear(); },
  }, process.cwd(), null, false, native.sessionId, undefined, onlineHost);
  t.after(() => wrapper.destroyAndWait());
  native.onMove = () => emitNative({ type: "notice", source: "session-persistence", level: "warning", message: "Session moved to a sibling file because another process owns the original" });
  wrapper.onIdentityChange((oldId, newId, options) => {
    identityChanges.push({ oldId, newId, keepOldId: options?.keepOldId });
    if (!options?.keepOldId) world.wrappers.delete(oldId);
    world.wrappers.set(newId, wrapper);
  });
  wrapper.onEvent((event) => {
    for (const [id, registered] of world.wrappers) {
      if (registered === wrapper) world.streams.set(id, event);
    }
    if (holdHistory && event.type === "session_history_changed") { historyFrames.push(event); return; }
    for (const stream of world.esInstances) {
      if (!stream.closedByCaller && world.wrappers.get(stream.channel.sessionId) === wrapper) stream.emit(event);
    }
  });
  wrapper.start();
  await wrapper.waitUntilReady();
  world.wrappers.set(native.sessionId, wrapper);
  return {
    wrapper, identityChanges, emitNative,
    completePrompt() { native.completePrompt({ channel: { sessionId: native.sessionId }, emit: emitNative }); },
    releaseHistory() {
      holdHistory = false;
      for (const event of historyFrames.splice(0)) {
        for (const stream of world.esInstances) {
          if (!stream.closedByCaller && world.wrappers.get(stream.channel.sessionId) === wrapper) stream.emit(event);
        }
      }
    },
  };
}

async function mountMovableChat(initialId, { onOpenFile } = {}) {
  const chatInputRef = React.createRef();
  let selectedId = initialId;
  let navigate;
  let changeLeaf;
  let activeLeaf;
  const onBranchDataChange = (_tree, leaf, handler) => { activeLeaf = leaf; changeLeaf = handler; };
  function Shell() {
    const [session, setSession] = React.useState(() => sessionInfo(initialId));
    const [navigationKey, setNavigationKey] = React.useState(0);
    navigate = (id) => {
      selectedId = id;
      setSession(sessionInfo(id));
      setNavigationKey((key) => key + 1);
      window.history.replaceState(null, "", `?session=${encodeURIComponent(id)}`);
    };
    return React.createElement(ChatWindow, {
      key: navigationKey, session, newSessionCwd: null, chatInputRef, onBranchDataChange, onOpenFile,
      onSessionMoved(oldId, newId) {
        if (selectedId !== oldId) return;
        selectedId = newId;
        setSession(sessionInfo(newId));
        window.history.replaceState(null, "", `?session=${encodeURIComponent(newId)}`);
      },
    });
  }
  window.history.replaceState(null, "", `?session=${encodeURIComponent(initialId)}`);
  const view = render(React.createElement(Shell));
  await settle();
  await act(async () => { lastEs()?.open(); });
  await settle();
  return {
    view, chatInputRef, unmount: view.unmount,
    navigate: (id) => navigate(id), changeLeaf: (leaf) => changeLeaf(leaf),
    editButton: () => view.getAllByRole("button", { name: translate("messageView.editFromHereTitle") })[1],
    get selectedId() { return selectedId; }, get activeLeaf() { return activeLeaf; },
  };
}

async function mountEditableSession(sid, options = {}) {
  const { getDraft, setDraft } = await import("@/lib/draft-store");
  const session = sessionInfo(sid);
  const chatInputRef = options.chatInputRef ?? React.createRef();
  let latest;
  let sending;
  let changeLeaf;
  const onBranchDataChange = (_tree, _leaf, handler) => { changeLeaf = handler; };
  function Chat() {
    const [value, setValue] = React.useState(() => getDraft(sid)?.value ?? "");
    React.useImperativeHandle(chatInputRef, () => ({
      insertIfEmpty(text) { setValue((current) => current.trim() ? current : text); },
    }), []);
    React.useEffect(() => { setDraft(sid, { value, images: [], files: [] }); }, [value]);
    const hook = useAgentSession({ session, newSessionCwd: null, ...options, chatInputRef, onBranchDataChange });
    latest = hook;
    const historyBusy = hook.editingEntryId !== null || hook.forkingEntryId !== null;
    return React.createElement(React.Fragment, null,
      hook.messages.map((message, index) => message.role === "user"
        ? React.createElement("section", { key: hook.entryIds[index] ?? index, "data-testid": `message-${hook.entryIds[index]}` },
          React.createElement(MessageView, {
            message, entryId: hook.entryIds[index], onEdit: hook.handleEdit,
            editing: hook.editingEntryId === hook.entryIds[index], editDisabled: historyBusy,
            onFork: hook.handleFork, forking: hook.forkingEntryId === hook.entryIds[index], forkDisabled: historyBusy,
          })) : null),
      React.createElement("form", { onSubmit: (event) => {
        event.preventDefault();
        sending = hook.handleSend(value);
        void sending.then((sent) => { if (sent.status === "accepted") setValue((current) => current === value ? "" : current); });
      } },
      React.createElement("textarea", { "aria-label": "Test composer", value, onChange: (event) => setValue(event.target.value) }),
      React.createElement("button", { type: "submit" }, "Submit replacement")));
  }
  const view = render(React.createElement(Chat));
  await settle();
  assert.equal(latest.loading, false, "the real hook must finish hydration");
  return {
    view, unmount: view.unmount, changeLeaf: (leafId) => changeLeaf(leafId),
    editButton: (entryId) => within(view.getByTestId(`message-${entryId}`)).getByRole("button", { name: translate("messageView.editFromHereTitle") }),
    get latest() { return latest; },
    get sending() { return sending; },
  };
}

// A live but idle wrapper supplies the observer connection without inventing
// an agent run just to deliver history notifications.

for (const order of ["identity/history before HTTP", "HTTP before history delivery"]) {
  test(`native Edit relocation keeps the prefix, composer and resend (${order})`, async (t) => {
    resetWorld();
    const { getDraft, setDraft, clearDraft } = await import("@/lib/draft-store");
    const sid = `edit-move-${order.startsWith("identity") ? "early" : "late"}`;
    const target = `${sid}-owned`;
    for (const id of [sid, target]) clearDraft(id);
    t.after(() => { clearDraft(sid); clearDraft(target); });
    const images = [{ data: "AAAA", mimeType: "image/png" }];
    const files = [{ name: "context.txt", mimeType: "text/plain", content: "keep attached context", size: 21 }];
    setDraft(sid, { value: "", images, files });
    const native = primeEditableHistory(sid);
    native.moveTo = target;
    const original = structuredClone(world.sessions.get(sid));
    const originalEntries = native.entries;
    const originalJsonl = native.jsonl;
    const server = await attachEditableWrapper(t, native, { holdHistory: order.startsWith("HTTP") });
    const w = await mountMovableChat(sid);
    const composer = w.view.getByRole("textbox");
    let releaseReply;
    let replyReady = false;
    if (order.startsWith("identity")) {
      const replyGate = new Promise((resolve) => { releaseReply = resolve; });
      t.after(releaseReply);
      world.holds.push({
        match: (method, url, body) => method === "POST" && url === `/api/agent/${sid}` && body?.type === "edit_message",
        produce: async () => {
          const result = await server.wrapper.send({ type: "edit_message", entryId: "entry-u2" });
          replyReady = true;
          await replyGate;
          return { value: { success: true, data: result } };
        },
      });
    }
    await confirmEdit(w.view, w.editButton());
    await until(() => server.identityChanges.length === 1, "native identity machinery must confirm the copy-on-write move");
    assert.deepEqual(server.identityChanges, [{ oldId: sid, newId: target, keepOldId: true }]);
    assert.equal(world.wrappers.get(sid), world.wrappers.get(target), "the existing alias registry retains the originating observer");
    if (releaseReply) {
      await until(() => replyReady, "the wrapper history event must precede the held HTTP response");
      assert.equal(w.selectedId, sid, "a native identity/history event alone cannot navigate the client");
      assert.equal(w.activeLeaf, original.leafId);
      assert.equal(composer.value, "");
      await act(async () => { releaseReply(); });
    }
    await until(() => w.selectedId === target && w.activeLeaf === native.leafId, "confirmed Edit must reload and select the moved conversation");
    await settle();
    assert.equal(w.view.getByRole("textbox"), composer, "ownership relocation preserves the live composer instance");
    assert.equal(w.view.getByRole("textbox").value, "U2-original");
    assert.equal(new URL(window.location.href).searchParams.get("session"), target);
    assert.deepEqual(getDraft(target), { value: "U2-original", images, files });
    assert.equal(getDraft(sid), null, "the draft moves rather than remaining on the abandoned branch");
    assert.deepEqual(world.sessions.get(sid), original, "the non-owned source file remains historical");
    assert.equal(native.persistedFiles.get(original.filePath), originalJsonl, "copy-on-write must never append the Edit marker to the source file");
    assert.deepEqual(native.entries.slice(0, originalEntries.length), originalEntries);
    assert.deepEqual(world.sessions.get(target).messages, original.messages.slice(0, 2));
    assert.equal(w.view.queryByText("U3-original"), null);

    // A held server frame is delivered during the replacement response. It must
    // not clear the optimistic prompt or reset streaming after the id changed.
    await act(async () => {
      fireEvent.change(w.view.getByRole("textbox"), { target: { value: "U2-modified" } });
      fireEvent.keyDown(w.view.getByRole("textbox"), { key: "Enter", code: "Enter" });
    });
    await until(() => lastEs()?.channel.sessionId === target, "resend must attach the confirmed native identity");
    await act(async () => { lastEs().open(); });
    await until(() => native.prompts.length === 1, "replacement prompt must reach native history");
    const partial = assistantMsg("moving-partial", "Moved response in progress");
    await act(async () => { server.emitNative({ type: "agent_start" }); server.emitNative({ type: "message_update", message: partial }); });
    await settle(90);
    await act(async () => { server.releaseHistory(); });
    await settle();
    assert.ok(w.view.getByText("Moved response in progress"), "a delayed history echo must not reset the new response");
    assert.equal(native.prompts[0].sessionId, target);
    assert.deepEqual(native.prompts[0].messages.slice(0, 2), original.messages.slice(0, 2));
    assert.match(native.prompts[0].messages.at(-1).content, /U2-modified/);
    assert.match(native.prompts[0].messages.at(-1).content, /keep attached context/);
    assert.equal(native.prompts[0].messages.some((message) => message.content === "U3-original"), false);
    const promptCall = world.calls.findLast((call) => call.body?.type === "prompt");
    assert.equal(promptCall.url, `/api/agent/${target}`);
    assert.deepEqual(promptCall.body.images.map(({ data, mimeType }) => ({ data, mimeType })), images);
    await act(async () => { server.completePrompt(); });
    await until(() => w.activeLeaf === native.leafId && w.view.queryByText("A2-revised") !== null, "the moved replacement must persist and hydrate");
    await act(async () => { await w.changeLeaf(original.leafId); });
    assert.ok(w.view.getByText("U3-original"), "the abandoned continuation remains browsable in the copied history");
    assert.deepEqual(world.sessions.get(sid), original);
    await act(async () => { await w.changeLeaf(null); });
    const revised = structuredClone(world.sessions.get(target));
    w.unmount();
    native.reopen();
    const reopened = await mountMovableChat(new URL(window.location.href).searchParams.get("session"));
    assert.equal(reopened.selectedId, target);
    assert.equal(reopened.activeLeaf, revised.leafId);
    assert.ok(reopened.view.getByText("A2-revised"), "reloading the selected URL keeps the revised conversation");
    assert.equal(reopened.view.queryByText("U3-original"), null);
  });
}

test("relocation merges existing target attachments and preserves typing added while reload awaits", async (t) => {
  resetWorld();
  const { getDraft, setDraft, clearDraft } = await import("@/lib/draft-store");
  const sid = "edit-move-new-typing", target = `${sid}-owned`;
  t.after(() => { clearDraft(sid); clearDraft(target); });
  const sourceImage = { data: "AAAA", mimeType: "image/png" };
  const targetImage = { data: "BBBB", mimeType: "image/webp" };
  const sourceFile = { name: "source.txt", mimeType: "text/plain", content: "source", size: 6 };
  const targetFile = { name: "target.txt", mimeType: "text/plain", content: "target", size: 6 };
  setDraft(sid, { value: "initial source draft", images: [sourceImage], files: [sourceFile] });
  setDraft(target, { value: "existing target draft", images: [targetImage], files: [targetFile] });
  const native = primeEditableHistory(sid);
  native.moveTo = target;
  await attachEditableWrapper(t, native);
  const w = await mountMovableChat(sid);
  let release;
  t.after(() => release?.());
  world.holds.push({
    match: (method, url) => method === "GET" && url.startsWith(`/api/sessions/${target}?`),
    produce: () => new Promise((resolve) => { release = () => resolve({ value: {
      sessionId: target, filePath: native.filePath, tree: world.sessions.get(target).tree,
      leafId: native.leafId, context: world.sessions.get(target),
    } }); }),
  });
  await confirmEdit(w.view, w.editButton());
  await until(() => release, "confirmed target history must be awaiting its load");
  await act(async () => {
    fireEvent.change(w.view.getByRole("textbox"), { target: { value: "new source typing" } });
    w.chatInputRef.current.addFiles([new File(["new file while waiting"], "new.txt", { type: "text/plain" })]);
  });
  await until(() => getDraft(sid)?.files.length === 2, "attachment reads completed during the reload must join the moved draft");
  await act(async () => { release(); });
  await until(() => w.selectedId === target, "the confirmed move must transition its composer");
  // Bun appends ";charset=utf-8" to a text File's type, so the type is pinned by its prefix.
  const mimeType = getDraft(target)?.files[1]?.mimeType ?? "";
  assert.ok(mimeType.startsWith("text/plain"), mimeType);
  assert.deepEqual(getDraft(target), {
    value: "new source typing\n\nexisting target draft", images: [sourceImage, targetImage],
    files: [sourceFile, { name: "new.txt", mimeType, content: "new file while waiting", size: 22 }, targetFile],
  });
  assert.equal(w.view.getByRole("textbox").value, "new source typing\n\nexisting target draft");
  assert.equal(getDraft(sid), null);
});

test("relocation keeps the source and existing target finished uploads", async (t) => {
  resetWorld();
  const { getDraft, setDraft, clearDraft } = await import("@/lib/draft-store");
  const sid = "edit-move-uploads", target = `${sid}-owned`;
  t.after(() => { clearDraft(sid); clearDraft(target); });
  const sourceUpload = { id: "up-source", name: "source.bin", size: 10, hostId: "local" };
  const targetUpload = { id: "up-target", name: "target.bin", size: 20, hostId: "local" };
  setDraft(sid, { value: "", images: [], files: [], uploads: [sourceUpload] });
  setDraft(target, { value: "Existing target text", images: [], files: [], uploads: [targetUpload] });
  const native = primeEditableHistory(sid);
  native.moveTo = target;
  await attachEditableWrapper(t, native);
  const w = await mountMovableChat(sid);
  await confirmEdit(w.view, w.editButton());
  await until(() => w.selectedId === target, "the confirmed target must become selected");
  await settle();
  // The composer re-persists the merged list in its own order.
  assert.deepEqual(getDraft(target)?.uploads?.map((upload) => upload.id).sort(), [sourceUpload.id, targetUpload.id]);
  assert.equal(getDraft(sid), null);
});

test("relocation merges an upload both drafts hold once", async (t) => {
  resetWorld();
  const { getDraft, setDraft, clearDraft, subscribeDrafts } = await import("@/lib/draft-store");
  const sid = "edit-move-shared-upload", target = `${sid}-owned`;
  t.after(() => { clearDraft(sid); clearDraft(target); });
  const shared = { id: "up-shared", name: "shared.bin", size: 10, hostId: "local" };
  const targetOnly = { id: "up-target", name: "target.bin", size: 20, hostId: "local" };
  setDraft(sid, { value: "", images: [], files: [], uploads: [shared] });
  setDraft(target, { value: "Existing target text", images: [], files: [], uploads: [{ ...shared, name: "target-shared.bin" }, targetOnly] });
  const native = primeEditableHistory(sid);
  native.moveTo = target;
  await attachEditableWrapper(t, native);
  const w = await mountMovableChat(sid);
  const persistedUploads = [];
  t.after(subscribeDrafts(() => {
    if (getDraft(sid) === null) persistedUploads.push(getDraft(target)?.uploads ?? []);
  }));
  await confirmEdit(w.view, w.editButton());
  await until(() => w.selectedId === target, "the confirmed target must become selected");
  await settle();
  assert.deepEqual(getDraft(target)?.uploads?.map((upload) => upload.id).sort(), [shared.id, targetOnly.id]);
  assert.equal(getDraft(target)?.uploads?.find((upload) => upload.id === shared.id)?.name, shared.name, "the source occurrence wins");
  assert.ok(persistedUploads.length > 0);
  for (const saved of persistedUploads) {
    assert.equal(saved.filter((upload) => upload.id === shared.id).length, 1, "no persisted snapshot contains the shared id twice");
  }
  assert.equal(getDraft(sid), null);
});

test("relocation adopts existing target text without prefilling over it", async (t) => {
  resetWorld();
  const { getDraft, setDraft, clearDraft } = await import("@/lib/draft-store");
  const sid = "edit-move-target-text", target = `${sid}-owned`;
  t.after(() => { clearDraft(sid); clearDraft(target); });
  const sourceImage = { data: "AAAA", mimeType: "image/png" };
  const targetFile = { name: "target.txt", mimeType: "text/plain", content: "Target context", size: 14 };
  setDraft(sid, { value: "", images: [sourceImage], files: [] });
  setDraft(target, { value: "Existing target text", images: [], files: [targetFile] });
  const native = primeEditableHistory(sid);
  native.moveTo = target;
  await attachEditableWrapper(t, native);
  const w = await mountMovableChat(sid);
  const composer = w.view.getByRole("textbox");
  assert.equal(composer.value, "");
  await confirmEdit(w.view, w.editButton());
  await until(() => w.selectedId === target, "the confirmed target must become selected");
  await settle();
  assert.equal(w.view.getByRole("textbox"), composer, "the existing composer adopts its new draft identity");
  assert.equal(composer.value, "Existing target text", "Edit prefill must not replace existing target content");
  assert.deepEqual(getDraft(target), { value: "Existing target text", images: [sourceImage], files: [targetFile] });
  assert.equal(getDraft(sid), null);
});

test("relocation at draft capacity preserves every unrelated draft and its attachments", async (t) => {
  resetWorld();
  const { getDraft, setDraft, clearDraft } = await import("@/lib/draft-store");
  const sid = "edit-move-full-drafts", target = `${sid}-owned`;
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const unrelated = Array.from({ length: 49 }, (_, index) => {
    const id = `${sid}-unrelated-${index}`;
    return [id, {
      value: `Unsent conversation ${index}`,
      images: [{ data: png, mimeType: "image/png" }],
      files: [{ name: `context-${index}.txt`, mimeType: "text/plain", content: `Context ${index}`, size: 10 }],
    }];
  });
  clearDraft(target);
  t.after(() => { for (const id of [sid, target, ...unrelated.map(([id]) => id)]) clearDraft(id); });
  // Fill all 50 slots with the source newer than every unrelated draft.
  // This also removes any in-memory drafts left by earlier tests.
  for (const [id, draft] of unrelated) setDraft(id, draft);
  const source = {
    value: "",
    images: [{ data: png, mimeType: "image/png" }],
    files: [{ name: "source.txt", mimeType: "text/plain", content: "Source context", size: 14 }],
  };
  setDraft(sid, source);
  const native = primeEditableHistory(sid);
  native.moveTo = target;
  await attachEditableWrapper(t, native);
  const w = await mountMovableChat(sid);
  const composer = w.view.getByRole("textbox");
  await confirmEdit(w.view, w.editButton());
  await until(() => w.selectedId === target, "Edit must move the selected conversation at full draft capacity");
  await settle();
  assert.equal(w.view.getByRole("textbox"), composer);
  assert.equal(composer.value, "U2-original");
  assert.deepEqual(getDraft(target), { ...source, value: "U2-original" });
  assert.equal(getDraft(sid), null);
  for (const [id, draft] of unrelated) {
    assert.deepEqual(getDraft(id), draft, `relocation must preserve ${id}, including its attachments`);
  }
  const [oldestId, oldestDraft] = unrelated[0];
  primeEditableHistory(oldestId);
  await act(async () => { w.navigate(oldestId); });
  await settle();
  assert.equal(w.view.getByRole("textbox").value, oldestDraft.value, "the oldest unrelated conversation still restores its unsent text");
  assert.deepEqual(getDraft(oldestId), oldestDraft, "restoring the oldest composer keeps both attachment payloads");
});

for (const phase of ["HTTP response", "target reload"]) {
test(`navigation during a moved Edit's ${phase} is not hijacked or prefilled`, async (t) => {
  resetWorld();
  const { getDraft, setDraft, clearDraft } = await import("@/lib/draft-store");
  const sid = `edit-move-leave-${phase.startsWith("HTTP") ? "http" : "reload"}`, target = `${sid}-owned`, other = `${sid}-other`;
  t.after(() => { for (const id of [sid, target, other]) clearDraft(id); });
  setDraft(sid, { value: "origin draft", images: [], files: [] });
  setDraft(other, { value: "other user's navigation draft", images: [], files: [] });
  const native = primeEditableHistory(sid);
  native.moveTo = target;
  primeEditableHistory(other);
  const server = await attachEditableWrapper(t, native);
  const w = await mountMovableChat(sid);
  let release;
  t.after(() => release?.());
  if (phase === "HTTP response") {
    world.holds.push({
      match: (method, url, body) => method === "POST" && url === `/api/agent/${sid}` && body?.type === "edit_message",
      produce: async () => {
        const result = await server.wrapper.send({ type: "edit_message", entryId: "entry-u2" });
        await new Promise((resolve) => { release = resolve; });
        return { value: { success: true, data: result } };
      },
    });
  } else {
    world.holds.push({
      match: (method, url) => method === "GET" && url.startsWith(`/api/sessions/${target}?`),
      produce: () => new Promise((resolve) => { release = () => resolve({ value: {
        sessionId: target, leafId: native.leafId, tree: [], context: world.sessions.get(target),
      } }); }),
    });
  }
  await confirmEdit(w.view, w.editButton());
  await until(() => release, "the old instance must await the moved Edit");
  await act(async () => { w.navigate(other); });
  await settle();
  const selectedComposer = w.view.getByRole("textbox");
  await act(async () => { release(); });
  await settle();
  assert.equal(w.selectedId, other);
  assert.equal(new URL(window.location.href).searchParams.get("session"), other);
  assert.equal(selectedComposer.value, "other user's navigation draft");
  assert.equal(getDraft(other)?.value, "other user's navigation draft");
  assert.equal(getDraft(sid)?.value, "origin draft");
  assert.equal(getDraft(target), null);
});
}

test("a moved conversation whose reload fails preserves attachments without prefilling and reports failure", async (t) => {
  resetWorld();
  const { getDraft, setDraft, clearDraft } = await import("@/lib/draft-store");
  const sid = "edit-move-load-failed", target = `${sid}-owned`;
  t.after(() => { clearDraft(sid); clearDraft(target); });
  const draft = { value: "", images: [{ data: "AAAA", mimeType: "image/png" }],
    files: [{ name: "keep.txt", mimeType: "text/plain", content: "retained file", size: 13 }] };
  setDraft(sid, draft);
  const native = primeEditableHistory(sid);
  native.moveTo = target;
  await attachEditableWrapper(t, native);
  const w = await mountMovableChat(sid);
  world.holds.push({
    match: (method, url) => method === "GET" && url.startsWith(`/api/sessions/${target}?`),
    produce: async () => ({ status: 503, value: {} }),
  });
  await confirmEdit(w.view, w.editButton());
  await until(() => w.selectedId === target, "authoritative identity must survive a failed read of the moved history");
  await settle();
  assert.equal(new URL(window.location.href).searchParams.get("session"), target);
  assert.equal(w.view.getByRole("textbox").value, "", "an unconfirmed history load must not prefill the original prompt");
  assert.deepEqual(getDraft(target), draft);
  assert.ok(w.view.getByText(translate("agentSession.commandFailed")));
});

test("observed edit-time persistence errors preserve the real composer and complete draft", async (t) => {
  resetWorld();
  const { getDraft, setDraft, clearDraft } = await import("@/lib/draft-store");
  const sid = "edit-native-disk-error";
  t.after(() => clearDraft(sid));
  const draft = { value: "keep unsent text", images: [{ data: "AAAA", mimeType: "image/png" }],
    files: [{ name: "keep.txt", mimeType: "text/plain", content: "retained file", size: 13 }] };
  setDraft(sid, draft);
  const native = primeEditableHistory(sid);
  native.editOutcome = "persistence-error";
  const original = structuredClone(world.sessions.get(sid));
  await attachEditableWrapper(t, native);
  const w = await mountMovableChat(sid);
  const composer = w.view.getByRole("textbox");
  await confirmEdit(w.view, w.editButton());
  await until(() => w.view.queryAllByText(/Could not append session file: disk full/).length > 0, "native persistence failure must be displayed");
  await settle();
  assert.equal(w.selectedId, sid);
  assert.equal(w.view.getByRole("textbox"), composer);
  assert.equal(composer.value, draft.value);
  assert.deepEqual(getDraft(sid), draft);
  assert.deepEqual(world.sessions.get(sid), original);
  assert.equal(w.editButton().disabled, false, "failure releases the mutation gate without discarding draft state");
});

test("Edit rewinds and resends in the same persisted session while retaining the old branch", async (t) => {
  resetWorld();
  const { clearDraft } = await import("@/lib/draft-store");
  const sid = "edit-same-session";
  clearDraft(sid);
  t.after(() => clearDraft(sid));
  const native = primeEditableHistory(sid);
  const originalEntries = native.entries;
  const original = world.sessions.get(sid);
  const forked = [];
  const options = { onSessionForked: (id) => forked.push(id) };
  const w = await mountEditableSession(sid, options);
  assert.equal(w.latest.data.filePath, native.filePath);
  const release = native.holdEdit();
  t.after(release);
  const edit = w.editButton("entry-u2");
  await confirmEdit(w.view, edit);
  await until(() => native.edits.length === 1, "the actual Edit button must reach native history navigation");
  assert.equal(w.latest.editingEntryId, "entry-u2");
  assert.equal(edit.disabled, true);
  await act(async () => {
    fireEvent.click(edit);
    assert.equal(await w.latest.handleEdit("entry-u2", "U2-original"), false, "the hook also refuses overlapping Edits");
    await w.latest.handleFork("entry-u2", true);
    fireEvent.change(w.view.getByRole("textbox"), { target: { value: "must not reach the old runtime" } });
  });
  await act(async () => {
    fireEvent.click(w.view.getByRole("button", { name: "Submit replacement" }));
    assert.equal((await w.sending).status, "rejected", "a nonempty send is refused while Edit is pending");
  });
  assert.deepEqual(native.edits, ["entry-u2"]);
  assert.deepEqual(native.prompts, []);
  assert.deepEqual(world.sessions.get(sid).messages, original.messages);
  await act(async () => {
    fireEvent.change(w.view.getByRole("textbox"), { target: { value: "" } });
    release();
  });
  await until(() => w.latest.editingEntryId === null && w.latest.entryIds.length === 2, "Edit must reload the real active prefix");
  assert.equal(w.latest.sessionIdRef.current, sid);
  assert.deepEqual(w.latest.messages, original.messages.slice(0, 2));
  assert.deepEqual(w.latest.entryIds, ["entry-u1", "entry-a1"]);
  assert.equal(w.latest.activeLeafId, "edit-marker-1", "the durable leaf is metadata, not the last visible message");
  assert.equal(w.view.getByRole("textbox").value, "U2-original");
  assert.deepEqual(native.entries.slice(0, originalEntries.length), originalEntries, "navigation must not remove the original continuation");
  assert.equal(native.entries.at(-1).parentId, "entry-a1");

  await act(async () => {
    fireEvent.change(w.view.getByRole("textbox"), { target: { value: "U2-modified" } });
  });
  await act(async () => { fireEvent.click(w.view.getByRole("button", { name: "Submit replacement" })); });
  await until(() => world.esInstances.some((stream) => stream.channel.sessionId === sid), "resend must connect to the same session");
  const stream = lastEs();
  await act(async () => { stream.open(); assert.equal((await w.sending).status, "accepted"); });
  assert.equal(native.prompts.length, 1);
  assert.equal(native.prompts[0].sessionId, sid);
  assert.equal(native.prompts[0].filePath, native.filePath);
  assert.deepEqual(native.prompts[0].messages, [original.messages[0], original.messages[1], userMsg("replacement-1", "U2-modified")],
    "the effective model context must exclude U2-original and every message after it");
  assert.equal(world.calls.findLast((call) => call.body?.type === "prompt").url, `/api/agent/${sid}`);
  await act(async () => { native.completePrompt(stream); });
  await until(() => !w.latest.agentRunning && w.latest.entryIds.at(-1) === "entry-revised-answer-1", "the revised branch must persist and hydrate");
  const revised = structuredClone(world.sessions.get(sid));
  const persisted = native.jsonl;
  w.unmount();
  world.sessions.delete(sid);
  native.reopen();
  const reopened = await mountEditableSession(sid, options);
  assert.equal(reopened.latest.sessionIdRef.current, sid);
  assert.equal(reopened.latest.data.filePath, native.filePath);
  assert.deepEqual(reopened.latest.entryIds, revised.entryIds);
  assert.deepEqual(reopened.latest.messages, revised.messages, "a cold reopen must select the persisted revised branch");
  assert.equal(reopened.latest.activeLeafId, revised.leafId);
  const branchReadsStart = world.calls.length;
  await act(async () => { await reopened.changeLeaf(original.leafId); });
  assert.deepEqual(reopened.latest.entryIds, original.entryIds);
  assert.deepEqual(reopened.latest.messages, original.messages, "the prior continuation remains reachable through read-only browsing");
  assert.deepEqual(world.sessions.get(sid).messages, revised.messages, "browsing must not move the native branch");
  await act(async () => { await reopened.changeLeaf(null); });
  assert.deepEqual(reopened.latest.messages, revised.messages);
  assert.equal(native.jsonl, persisted, "neither reopen nor read-only browsing rewrites the session file");
  assert.ok(world.calls.slice(branchReadsStart).every((call) => call.method === "GET"));
  assert.deepEqual([...world.sessions.keys()], [sid], "Edit never creates another session");
  assert.equal(world.calls.some((call) => call.body?.type === "fork" || call.url === "/api/agent/new" || call.body?.type === "new_session"), false);
  assert.deepEqual(forked, []);
});


test("cancelled and failed Edits preserve history selection and draft, then release the guard", async (t) => {
  const { getDraft, setDraft, clearDraft } = await import("@/lib/draft-store");
  for (const outcome of ["cancelled", "error"]) {
    await t.test(outcome, async (t) => {
      resetWorld();
      const sid = `edit-${outcome}`;
      setDraft(sid, { value: "keep my draft", images: [], files: [] });
      t.after(() => clearDraft(sid));
      const native = primeEditableHistory(sid);
      native.editOutcome = outcome;
      const original = structuredClone(world.sessions.get(sid));
      const persisted = native.jsonl;
      const forked = [];
      const w = await mountEditableSession(sid, { onSessionForked: (id) => forked.push(id) });
      await act(async () => { await w.changeLeaf("entry-a2"); });
      const selectedIds = [...w.latest.entryIds];
      const selectedMessages = structuredClone(w.latest.messages);
      await confirmEdit(w.view, w.editButton("entry-u2"));
      await until(() => native.edits.length === 1 && w.latest.editingEntryId === null, "the unsuccessful Edit must settle");
      assert.equal(w.latest.sessionIdRef.current, sid);
      assert.equal(w.latest.activeLeafId, "entry-a2");
      assert.deepEqual(w.latest.entryIds, selectedIds);
      assert.deepEqual(w.latest.messages, selectedMessages);
      assert.deepEqual(world.sessions.get(sid), original);
      assert.equal(native.jsonl, persisted);
      assert.equal(w.view.getByRole("textbox").value, "keep my draft");
      assert.equal(getDraft(sid)?.value, "keep my draft");
      assert.deepEqual(w.latest.notices.map((notice) => notice.type), outcome === "error" ? ["error"] : []);

      native.editOutcome = "success";
      await confirmEdit(w.view, w.editButton("entry-u2"));
      await until(() => native.edits.length === 2 && w.latest.editingEntryId === null, "a settled refusal must allow another Edit");
      assert.deepEqual(world.sessions.get(sid).entryIds, ["entry-u1", "entry-a1"]);
      assert.deepEqual(w.latest.entryIds, ["entry-u1", "entry-a1"]);
      assert.equal(w.view.getByRole("textbox").value, "keep my draft", "successful insertIfEmpty must not overwrite existing text");
      assert.equal(getDraft(sid)?.value, "keep my draft");
      assert.deepEqual([...world.sessions.keys()], [sid]);
      assert.equal(world.calls.some((call) => call.body?.type === "fork" || call.url === "/api/agent/new"), false);
      assert.deepEqual(forked, []);
      w.unmount();
    });
  }
});


// ---------------------------------------------------------------------------
// Remote hosts — port of upstream 8257ed02 (#339): a session can run on another
// machine, so the hook learns its host, surfaces `host_status` link changes,
// creates fresh chats on the picked host, and reports a send whose host's link
// stopped as a toast instead of a chat notice.
// Harness adaptations (this router answers 404 for ids the fake world does not
// know, where upstream's stub answered 200 for any id): the runtimes these
// blocks talk to are registered in `world` before they are used, and toasts are
// captured by wrapping the real `toast` object (see the top of this file).
// ---------------------------------------------------------------------------

test("host_status frames report the session's host going offline and coming back", async () => {
  resetWorld();
  primeSession("remote-link", [userMsg("u0", "q")]);
  const { w, es } = await startRun("remote-link", "hello");
  assert.equal(w.latest.hostStatus, null, "no change reported yet");
  await act(() => { es.emit({ type: "host_status", hostId: "h1", status: "offline" }); });
  assert.equal(w.latest.hostStatus, "offline");
  assert.equal(w.latest.agentRunning, true, "the run continues on the host while its link is down");
  await act(() => { es.emit({ type: "host_status", hostId: "h1", status: "online" }); });
  assert.equal(w.latest.hostStatus, "online");
  w.unmount();
});

test("a send to an offline host is accepted and held without a toast or recovered draft", async () => {
  resetWorld();
  toastCalls.length = 0;
  primeSession("remote-off", [userMsg("u0", "q")]);
  world.outboxHold = true;
  const w = await mountSession("remote-off");
  await act(async () => { assert.deepEqual(await w.latest.handleSend("keep me"), { status: "accepted" }); });
  assert.equal(w.latest.heldMessages[0].message, "keep me");
  assert.equal(w.latest.heldMessages[0].state, "sending");
  assert.equal(w.latest.agentRunning, false);
  assert.deepEqual(toastCalls, []);
  assert.deepEqual(w.latest.notices, []);
  assert.equal(callsTo("POST", "/api/agent/").some((call) => call.body?.type === "prompt"), false, "the offline hold dispatches nothing");
  w.unmount();
});

test("a fresh chat on a remote host creates its session there and toasts when that host is offline", async () => {
  resetWorld();
  toastCalls.length = 0;
  world.holds.push({
    match: (method, url) => method === "POST" && url === "/api/agent/new",
    produce: async () => ({ status: 503, value: { error: "Build box is offline", code: "host_offline", hostOffline: true } }),
  });
  const w = await mountSession(null, undefined, { newSessionCwd: "/remote/work", newSessionHostId: "h1" });
  let receipt;
  await act(async () => { receipt = await w.latest.handleSend("first"); await sleep(30); });
  // Drafts for one path on two hosts must not share a composer key.
  assert.deepEqual(receipt, { status: "rejected", recoveryKey: "new:h1:/remote/work" });
  assert.deepEqual(callsTo("POST", "/api/agent/new").map((call) => [call.body.cwd, call.body.hostId]), [["/remote/work", "h1"]]);
  assert.equal(toastCalls[0]?.[0], "error");
  assert.equal(w.latest.notices.length, 0);
  w.unmount();
});

test("a fresh chat whose host drops after the spawn adopts the kept session, so a retry starts no second one", async () => {
  resetWorld();
  toastCalls.length = 0;
  // The kept runtime is alive in the fake world, so the retry's prompt reaches it.
  world.agents.set("kept-remote", { running: false, state: {} });
  world.holds.push({
    match: (method, url) => method === "POST" && url === "/api/agent/new",
    produce: async () => ({ status: 503, value: { error: "Build box is offline", code: "host_offline", hostOffline: true, delivery: "refused", sessionId: "kept-remote" } }),
  });
  const w = await mountSession(null, undefined, { newSessionCwd: "/remote/work", newSessionHostId: "h1", onSessionCreated: () => {} });
  let first;
  await act(async () => { first = await w.latest.handleSend("first"); await sleep(30); });
  assert.equal(first.status, "rejected");
  assert.equal(toastCalls[0]?.[0], "error");
  let retry;
  await act(async () => { retry = w.latest.handleSend("first"); await sleep(30); });
  await act(async () => { lastEs()?.open(); retry = await retry; });
  w.unmount();
  assert.equal(retry.status, "accepted");
  assert.equal(callsTo("POST", "/api/agent/new").length, 1, "the retry reuses the kept session");
  assert.equal(callsTo("POST", "/api/agent/kept-remote").some((call) => call.body?.type === "prompt"), true);
});

test("a fresh local chat sends no host id and keeps the pre-hosts draft key", async () => {
  resetWorld();
  world.holds.push({
    match: (method, url) => method === "POST" && url === "/api/agent/new",
    produce: async () => ({ status: 500, value: { error: "stop here" } }),
  });
  const w = await mountSession(null, undefined, { newSessionCwd: "/workspace" });
  let receipt;
  await act(async () => { receipt = await w.latest.handleSend("first"); await sleep(30); });
  assert.equal("hostId" in callsTo("POST", "/api/agent/new")[0].body, false);
  assert.deepEqual(receipt, { status: "rejected", recoveryKey: "new:/workspace" });
  w.unmount();
});

for (const [name, method] of [["steer", "handleSteer"], ["follow-up", "handleFollowUp"], ["streaming-behavior prompt", "handlePromptWithStreamingBehavior"]]) {
  test(`a ${name} to an offline host is accepted into the outbox without a toast`, async () => {
    resetWorld();
    toastCalls.length = 0;
    primeSession(`remote-queue-${name}`, [userMsg("u0", "q")]);
    world.outboxHold = true;
    const w = await mountSession(`remote-queue-${name}`);
    let accepted;
    await act(async () => {
      accepted = method === "handlePromptWithStreamingBehavior"
        ? await w.latest[method]("queued text", "steer")
        : await w.latest[method]("queued text");
      await sleep(30);
    });
    assert.equal(accepted, true, "the composer drops the text into the outbox");
    assert.deepEqual(toastCalls, [], "an accepted hold is not a failure");
    assert.deepEqual(w.latest.notices, []);
    assert.equal(w.latest.heldMessages[0].message, "queued text");
    assert.equal(callsTo("POST", "/api/agent/").some((call) => ["prompt", "steer", "follow_up"].includes(call.body?.type)), false, "the offline hold dispatches nothing");
    w.unmount();
  });
}


test("an unknown delivery outcome stays in the server outbox as failed and never returns to the composer", async () => {
  resetWorld();
  toastCalls.length = 0;
  primeSession("remote-maybe", [userMsg("u0", "q")]);
  world.outboxHold = true;
  const w = await mountSession("remote-maybe");
  await act(async () => { assert.deepEqual(await w.latest.handleSend("maybe sent"), { status: "accepted" }); });
  const entry = world.outbox[0];
  await act(() => workerPort.onmessage({ data: { outbox: [] } }));
  await act(() => lastEs().emit({ type: "outbox_update", entries: [{ ...entry, mode: "prompt", state: "failed", error: "Build box is offline", mayHaveBeenSent: true, createdAt: entry.createdAt }] }));
  assert.equal(w.latest.heldMessages[0].state, "failed");
  assert.equal(w.latest.heldMessages[0].mayHaveBeenSent, true);
  assert.equal(w.latest.agentRunning, false);
  assert.deepEqual(toastCalls, [], "no toast: the held bubble owns the failure");
  assert.deepEqual(w.latest.notices, []);
  w.unmount();
});

test("a slash command held during a run dispatches as a prompt with its streaming behavior", async () => {
  resetWorld();
  primeSession("slash-outbox", [userMsg("u0", "q")]);
  const { w, es } = await startRun("slash-outbox", "run");
  await act(async () => { await w.latest.handleSteer("/skill queued text"); await settle(30); });
  const command = callsTo("POST", "/api/agent/slash-outbox").find((call) => call.body?.message === "/skill queued text");
  assert.equal(command?.body?.type, "prompt", "a held slash goes as a prompt command");
  assert.equal(command?.body?.streamingBehavior, "steer", "carrying the behavior omp is owed mid-run");
  void es;
});

// What the worker answers when the session socket dropped after sending a command (spec D5).
const SOCKET_LOST = { error: "The connection to omp-web dropped before the answer arrived; the command may have run.", code: "transport_lost" };

/** Runs a test with the worker in WebSocket mode, so agent commands go to it instead of fetch. */
async function inWebSocketMode(run) {
  const { openEventStream } = await import("@/lib/event-stream");
  openEventStream({ kind: "running" }).close(); // the tab's transport exists before the hook mounts
  workerPort.onmessage({ data: { transport: "ws" } });
  try {
    await run();
  } finally {
    workerPort.onmessage({ data: { transport: "sse" } });
    world.socketAnswer = null;
  }
}

test("a prompt is stored in the outbox even when the session socket cannot answer commands", async () => {
  await inWebSocketMode(async () => {
    resetWorld();
    toastCalls.length = 0;
    primeSession("socket-lost", [userMsg("u0", "q")]);
    world.outboxHold = true;
    world.socketAnswer = () => ({ status: 503, body: SOCKET_LOST });
    const w = await mountSession("socket-lost");
    await act(async () => { assert.deepEqual(await w.latest.handleSend("maybe sent"), { status: "accepted" }); });
    assert.equal(w.latest.heldMessages[0].message, "maybe sent");
    assert.equal(w.latest.agentRunning, false);
    assert.deepEqual(toastCalls, []);
    assert.deepEqual(w.latest.notices, []);
    assert.equal(callsTo("POST", "/api/agent/socket-lost").some((call) => call.body?.type === "prompt"), false, "the tab stores, not dispatches");
    w.unmount();
  });
});

test("a `!` command whose session socket dropped before the answer toasts that it may have run and stays out of the composer", async () => {
  await inWebSocketMode(async () => {
    resetWorld();
    toastCalls.length = 0;
    primeSession("socket-lost-bash", [userMsg("u0", "q")]);
    const offered = [];
    const w = await mountSession("socket-lost-bash", undefined, { chatInputRef: { current: { insertIfEmpty: (text) => offered.push(text) } } });
    world.socketAnswer = (command) => command.type === "bash" ? { status: 503, body: SOCKET_LOST } : null;
    await act(async () => { await w.latest.handleSend("!touch /tmp/once"); await sleep(30); });
    assert.deepEqual(offered, [], "the composer must not bring the command back: it may run twice");
    assert.deepEqual(toastCalls, [["info", translate("agentSession.transportLostMaybeSent")]]);
    assert.equal(w.latest.notices.length, 0);
  });
});

test("a `!` command the route refused is offered back to the composer with an error notice", async () => {
  await inWebSocketMode(async () => {
    resetWorld();
    toastCalls.length = 0;
    primeSession("socket-refused-bash", [userMsg("u0", "q")]);
    const offered = [];
    const w = await mountSession("socket-refused-bash", undefined, { chatInputRef: { current: { insertIfEmpty: (text) => offered.push(text) } } });
    world.socketAnswer = (command) => command.type === "bash" ? { status: 400, body: { error: "Shell is busy" } } : null;
    await act(async () => { await w.latest.handleSend("!touch /tmp/once"); await sleep(30); });
    assert.deepEqual(offered, ["!touch /tmp/once"], "it never ran, so the composer gets it back");
    assert.deepEqual(toastCalls, []);
    assert.deepEqual(w.latest.notices.map((notice) => notice.type), ["error"]);
  });
});

test("a `!` command during a run runs at once and its held-back output shows until the transcript has it", async () => {
  await inWebSocketMode(async () => {
    resetWorld();
    const run = (timestamp) => ({ role: "bashExecution", command: "echo hi", output: "hi\n", exitCode: 0, timestamp });
    primeSession("midrun-bash", [userMsg("u0", "q")]);
    const { w, es } = await startRun("midrun-bash", "q1");
    await act(async () => { es.emit({ type: "agent_start" }); await Promise.resolve(); });
    const result = { output: "hi\n", exitCode: 0, cancelled: false, truncated: false, deferred: true };
    world.socketAnswer = (command) => command.type === "bash" ? { status: 200, body: { success: true, data: result } } : null;
    let receipt;
    await act(async () => { receipt = await w.latest.handleSend("!echo hi"); await sleep(30); });
    assert.deepEqual(receipt, { status: "accepted" });
    assert.equal(w.latest.agentRunning, true, "the turn keeps running");
    assert.deepEqual(
      w.latest.deferredBash.map(({ command, output, exitCode }) => ({ command, output, exitCode })),
      [{ command: "echo hi", output: "hi\n", exitCode: 0 }],
    );

    await act(async () => { es.emit({ type: "agent_end", isTerminal: true, messages: [] }); await sleep(30); });
    await settle();
    assert.equal(w.latest.deferredBash.length, 1, "omp still holds it after the turn");

    // An older run of the same command comes into view (e.g. pre-compaction history): it is not this one.
    const before = world.sessions.get("midrun-bash").messages;
    saveSession("midrun-bash", [...before, run(1)]);
    await act(async () => { publishSessionsChanged(["midrun-bash"]); });
    await settle();
    assert.equal(w.latest.messages.filter((message) => message.role === "bashExecution").length, 1);
    assert.equal(w.latest.deferredBash.length, 1, "an older run does not count as this one");

    // omp writes it when a later prompt starts, stamped after everything before it.
    saveSession("midrun-bash", [...before, run(1), run(5)]);
    await act(async () => { publishSessionsChanged(["midrun-bash"]); });
    await settle();
    assert.deepEqual(w.latest.deferredBash, []);

    // Compaction drops it from the context: the shown output must not come back.
    saveSession("midrun-bash", [userMsg("u0", "q")]);
    await act(async () => { publishSessionsChanged(["midrun-bash"]); });
    await settle();
    assert.equal(w.latest.messages.some((message) => message.role === "bashExecution"), false);
    assert.deepEqual(w.latest.deferredBash, []);
  });
});

test("two held runs of the same `!` command each wait for their own recorded run", async () => {
  await inWebSocketMode(async () => {
    resetWorld();
    const run = (timestamp) => ({ role: "bashExecution", command: "git status", output: "clean\n", exitCode: 0, timestamp });
    primeSession("midrun-twice", [userMsg("u0", "q")]);
    const { w, es } = await startRun("midrun-twice", "q1");
    await act(async () => { es.emit({ type: "agent_start" }); await Promise.resolve(); });
    const result = { output: "clean\n", exitCode: 0, cancelled: false, truncated: false, deferred: true };
    world.socketAnswer = (command) => command.type === "bash" ? { status: 200, body: { success: true, data: result } } : null;
    for (let i = 0; i < 2; i++) await act(async () => { await w.latest.handleSend("!git status"); await sleep(30); });
    assert.equal(w.latest.deferredBash.length, 2);

    const before = world.sessions.get("midrun-twice").messages;
    saveSession("midrun-twice", [...before, run(5)]);
    await act(async () => { publishSessionsChanged(["midrun-twice"]); });
    await settle();
    assert.equal(w.latest.deferredBash.length, 1, "one recorded run settles one held run");

    saveSession("midrun-twice", [...before, run(5), run(6)]);
    await act(async () => { publishSessionsChanged(["midrun-twice"]); });
    await settle();
    assert.deepEqual(w.latest.deferredBash, []);
  });
});

test("Stop during a run with a `!` command beside it stops the turn, not the command", async () => {
  await inWebSocketMode(async () => {
    resetWorld();
    primeSession("midrun-stop", [userMsg("u0", "q")]);
    const { w, es } = await startRun("midrun-stop", "q1");
    await act(async () => { es.emit({ type: "agent_start" }); await Promise.resolve(); });
    const sent = [];
    let finishBash;
    world.socketAnswer = (command) => {
      sent.push(command.type);
      if (command.type !== "bash") return null;
      return new Promise((resolve) => { finishBash = () => resolve({ status: 200, body: { success: true, data: { output: "", exitCode: 0, cancelled: false, truncated: false, deferred: true } } }); });
    };
    let bash;
    await act(async () => { bash = w.latest.handleSend("!sleep 5"); await sleep(30); });
    assert.equal(w.latest.bashRunning, true);
    await act(async () => { void w.latest.handleAbort(); await sleep(30); });
    assert.equal(sent.includes("abort_bash"), false, "the shell command keeps running");
    assert.ok(sent.some((type) => type === "abort_and_restore_queue" || type === "abort"), "the turn is stopped");
    await act(async () => { finishBash(); await bash; });
  });
});

test("a steer is stored without consulting the session socket", async () => {
  await inWebSocketMode(async () => {
    resetWorld();
    toastCalls.length = 0;
    primeSession("socket-lost-steer", [userMsg("u0", "q")]);
    world.outboxHold = true;
    const w = await mountSession("socket-lost-steer");
    world.socketAnswer = (command) => command.type === "steer" ? { status: 503, body: SOCKET_LOST } : null;
    let accepted;
    await act(async () => { accepted = await w.latest.handleSteer("steer text"); await sleep(30); });
    assert.equal(accepted, true, "the composer drops the text into the outbox");
    assert.deepEqual(toastCalls, []);
    assert.equal(w.latest.heldMessages[0].mode, "steer");
    assert.equal(w.latest.heldMessages[0].message, "steer text");
    assert.equal(w.latest.notices.length, 0);
    w.unmount();
  });
});

test("an existing-session send never waits for a pre-prompt get_state reply", async () => {
  await inWebSocketMode(async () => {
    resetWorld();
    toastCalls.length = 0;
    primeSession("socket-lost-state", [userMsg("u0", "q")]);
    world.outboxHold = true;
    const w = await mountSession("socket-lost-state");
    world.socketAnswer = (command) => command.type === "get_state" ? { status: 503, body: SOCKET_LOST } : null;
    let receipt;
    await act(async () => { receipt = await w.latest.handleSend("never sent"); await sleep(30); });
    assert.deepEqual(receipt, { status: "accepted" });
    assert.deepEqual(toastCalls, []);
    assert.deepEqual(w.latest.notices, []);
    assert.equal(w.latest.heldMessages[0].message, "never sent");
    assert.equal(w.latest.agentRunning, false);
    assert.equal(callsTo("POST", "/api/agent/socket-lost-state").some((call) => call.body?.type === "prompt"), false);
    w.unmount();
  });
});

test("an interrupt-and-reply whose abort_and_prompt reply was lost is reported as taken and the text is not offered again", async () => {
  await inWebSocketMode(async () => {
    resetWorld();
    toastCalls.length = 0;
    primeSession("socket-lost-interrupt", [userMsg("u0", "q")]);
    const offered = [];
    const { w, es } = await startRun("socket-lost-interrupt", "q1", false, { chatInputRef: { current: { insertIfEmpty: (text) => offered.push(text) } } });
    await act(async () => { es.emit({ type: "agent_start" }); await Promise.resolve(); });
    world.socketAnswer = (command) => command.type === "abort_and_prompt" ? { status: 503, body: SOCKET_LOST } : null;
    let interrupt;
    await act(async () => { interrupt = w.latest.handleInterruptAndReply("replacement"); await sleep(30); });
    let accepted;
    await act(async () => { lastEs().open(); accepted = await interrupt; });
    assert.equal(accepted, true, "the replacement may be running: the composer drops the text");
    assert.deepEqual(offered, [], "a resend would interrupt the replacement turn");
    assert.deepEqual(toastCalls, [["info", translate("agentSession.transportLostMaybeSent")]]);
  });
});

test("the hosts channel decides the offline banner; a frame only speaks before its first snapshot", async () => {
  const bannerText = translate("hosts.offlineBanner", { host: "Build box" });
  const mount = async (hostStatus) => {
    resetWorld();
    primeSession("remote-banner", [userMsg("u0", "q")]);
    // A wrapper mid-stream attaches its event stream on load (this is how a
    // chat reopened during an outage gets its observer back).
    world.agents.set("remote-banner", { running: true, state: { isStreaming: true } });
    const view = render(React.createElement(ChatWindow, {
      session: { ...sessionInfo("remote-banner"), hostId: "h1" }, newSessionCwd: null, hostLabel: "Build box",
      ...(hostStatus ? { hostStatus } : {}),
    }));
    await settle();
    await act(async () => { lastEs()?.open(); });
    await settle();
    return view;
  };
  const withChannel = await mount("online");
  await act(async () => { lastEs().emit({ type: "host_status", hostId: "h1", status: "offline" }); });
  assert.equal(withChannel.queryByText(bannerText), null, "a frame cannot override the channel's online status");
  withChannel.unmount();

  const beforeSnapshot = await mount(undefined);
  await act(async () => { lastEs().emit({ type: "host_status", hostId: "h1", status: "offline" }); });
  assert.ok(beforeSnapshot.queryByText(bannerText), "without a channel snapshot the frame shows the banner");
  beforeSnapshot.unmount();

  const offlineChannel = await mount("offline");
  assert.ok(offlineChannel.queryByText(bannerText), "a chat opened during an outage shows the banner from the channel");
  offlineChannel.unmount();
});

// omp's delta message updates (lib/message-delta.ts, lib/message-update-coalescer.ts).
const recordedFrames = readFileSync(new URL("../tests/fixtures/omp-delta-stream.ndjson", import.meta.url), "utf8")
  .trim().split("\n").map((line) => JSON.parse(line)).filter((frame) => frame.type !== "response");

/** What omp's full mode sends for the same run, at each block end: the message as streamed so far. */
function fullFramesOf(frames) {
  const open = new Map();
  const out = [];
  for (const frame of frames) {
    if (frame.type === "message_start") open.set(frame.messageId, structuredClone(frame.message));
    if (frame.type !== "message_update") {
      out.push(frame);
      continue;
    }
    const message = open.get(frame.messageId);
    const event = frame.assistantMessageEvent;
    if (event.type === "text_end") message.content[event.contentIndex] = { ...event.block, text: event.content };
    else if (event.type === "thinking_end") message.content[event.contentIndex] = { ...event.block, thinking: event.content };
    else if (event.type === "toolcall_end") message.content[event.contentIndex] = event.toolCall;
    else continue;
    out.push({ type: "message_update", messageId: frame.messageId, message: structuredClone(message), assistantMessageEvent: { ...event, partial: message } });
  }
  return out;
}

async function streamRecorded(frames) {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startRun("s1", recordedFrames[0].message.content[0].text);
  await act(async () => { es.emit({ type: "agent_start" }); });
  const shown = [];
  let toolArguments;
  for (const frame of frames) {
    if (frame.type === "message_end" && frame.message.role === "assistant") {
      await settle(90);
      shown.push(structuredClone(w.latest.streamState.streamingMessage?.content));
    }
    await act(async () => { es.emit(frame); await Promise.resolve(); });
    if (frame.assistantMessageEvent?.type === "toolcall_delta" && toolArguments === undefined) {
      await settle(90);
      toolArguments = structuredClone(w.latest.streamState.streamingMessage?.content[2]);
    }
  }
  await settle(90);
  // The fork's optimistic user rows carry the wall-clock send instant; the two runs differ there by construction.
  const messages = structuredClone(w.latest.messages);
  for (const message of messages) delete message.timestamp;
  return { shown, toolArguments, messages };
}

test("a run streamed as omp's delta updates renders exactly what its full updates render", async () => {
  const deltas = await streamRecorded(recordedFrames);
  const full = await streamRecorded(fullFramesOf(recordedFrames));
  assert.equal(deltas.shown.length, 2);
  assert.deepEqual(deltas.shown, full.shown, "each reply as it stood before message_end");
  assert.deepEqual(deltas.messages, full.messages, "the committed transcript");
  assert.deepEqual(deltas.shown[0].map((block) => block.type), ["thinking", "text", "toolCall"]);
  assert.equal(deltas.toolArguments.toolName, "read", "a streaming tool call shows its name from its first delta");
  assert.deepEqual(deltas.toolArguments.input, { path: "note.txt" }, "and the arguments streamed so far");
});

test("the harness and the hook share the toast, i18n and draft-store instances", async () => {
  const hookMod = await import("./useAgentSession.ts");
  const { toast } = await import("@/components/ui/toast");
  const { getDraft } = await import("@/lib/draft-store");
  assert.equal(typeof hookMod.useAgentSession, "function");
  assert.equal(typeof toast.info, "function");
  assert.equal(typeof getDraft, "function");
});

// ---- upstream #390: running-channel attach regressions ----
test("a chat with no stream attaches when the running channel reports its session", async () => {
  resetWorld();
  primeSession("started-elsewhere", [userMsg("u0", "q")]);
  const w = await mountSession("started-elsewhere");
  assert.equal(world.esInstances.length, 0, "an idle chat has no observer");
  const running = world.runningStreams.at(-1);
  assert.ok(running, "the chat watches the running channel");
  // Another chat instance (the user switched away and back) or device started the run after this one loaded,
  // with a model and thinking level the chat has not seen.
  assert.notEqual(w.latest.thinkingLevel, "high");
  assert.notEqual(w.latest.displayModel?.modelId, "live-model");
  world.agents.set("started-elsewhere", {
    running: true,
    state: { isStreaming: true, isPromptRunning: true, model: { provider: "test", id: "live-model" }, thinkingLevel: "high" },
  });
  await act(async () => {
    running.deliver({ type: "message", data: JSON.stringify({ type: "running", runningSessionIds: ["other"] }) });
    await settle();
  });
  assert.equal(world.esInstances.length, 0, "another session's run is not this chat's");
  await act(async () => {
    running.deliver({ type: "message", data: JSON.stringify({ type: "running", runningSessionIds: ["started-elsewhere"] }) });
    await settle();
  });
  assert.equal(world.esInstances.length, 1, "the chat attaches its observer");
  assert.equal(lastEs().channel.sessionId, "started-elsewhere");
  assert.equal(w.latest.agentRunning, true);
  assert.equal(w.latest.thinkingLevel, "high", "the composer shows the run's thinking level");
  assert.equal(w.latest.displayModel.modelId, "live-model", "the composer shows the run's model");
});

test("a running attachment applies compaction before its observer opens", async () => {
  resetWorld();
  primeSession("compacting-elsewhere", [userMsg("u0", "q")]);
  const w = await mountSession("compacting-elsewhere");
  world.agents.set("compacting-elsewhere", { running: true, state: { isCompacting: true } });
  await act(async () => {
    world.runningStreams.at(-1).deliver({ type: "message", data: JSON.stringify({ type: "running", runningSessionIds: ["compacting-elsewhere"] }) });
    await settle();
  });
  assert.equal(lastEs().readyState, FakeStream.CONNECTING);
  assert.equal(w.latest.isCompacting, true, "the compaction control immediately reflects the attached run");
  await act(async () => { await w.latest.handleCompact(); });
  assert.equal(world.calls.some((call) => call.body?.type === "compact"), false, "a second compaction cannot start");
});

test("compaction attached from another tab settles without replacing a historical view", async (t) => {
  resetWorld();
  const sid = "historical-compaction";
  primeSession(sid, [userMsg("live", "current branch")]);
  let changeLeaf;
  const w = await mountSession(sid, undefined, {
    onBranchDataChange: (_tree, _leaf, handler) => { changeLeaf = handler; },
  });
  const branch = { leafId: "branch", messages: [userMsg("old", "selected branch")], entryIds: ["branch-entry"] };
  world.views.set(`${sid}:branch:false`, branch);
  await act(async () => { await changeLeaf("branch"); });
  world.agents.set(sid, { running: true, state: { isCompacting: true } });
  t.mock.timers.enable({ apis: ["setInterval"] });
  await act(async () => {
    world.runningStreams.at(-1).deliver({ type: "message", data: JSON.stringify({ type: "running", runningSessionIds: [sid] }) });
    await settle();
    lastEs().open();
    await settle();
  });
  assert.equal(w.latest.isCompacting, true);
  assert.equal(w.latest.agentRunning, false, "manual compaction is not a prompt run");
  world.agents.set(sid, { running: true, state: { isCompacting: false } });
  await act(async () => {
    world.runningStreams.at(-1).deliver({ type: "message", data: JSON.stringify({ type: "running", runningSessionIds: [] }) });
    t.mock.timers.tick(15_000);
    await settle();
  });
  assert.equal(w.latest.isCompacting, false, "native idle state releases Stop compaction without a completion event");
  assert.equal(w.latest.activeLeafId, "branch");
  assert.deepEqual(w.latest.entryIds, branch.entryIds);
  assert.deepEqual(w.latest.messages, branch.messages);
});

test("a refused compact command cannot unlock compaction attached from another tab", async () => {
  resetWorld();
  const sid = "attached-compaction-owner";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  world.agents.set(sid, { running: true, state: { isCompacting: true } });
  await act(async () => {
    world.runningStreams.at(-1).deliver({ type: "message", data: JSON.stringify({ type: "running", runningSessionIds: [sid] }) });
    await settle();
  });
  await act(async () => {
    const result = await w.latest.handleBuiltinSlashCommand("/compact");
    assert.ok(result.error, "a second compaction is refused");
  });
  assert.equal(w.latest.isCompacting, true, "the rejected command does not own the attached compaction");
  await act(async () => { await w.latest.handleCompact(); });
  assert.equal(world.calls.some(call => call.body?.type === "compact"), false, "neither control can start a second compaction");
});

test("an idle chat reconciles auto-compaction when its completion event is lost", async () => {
  resetWorld();
  const sid = "auto-compaction-owner";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  world.agents.set(sid, { running: true, state: {} });
  await act(async () => {
    world.runningStreams.at(-1).deliver({ type: "message", data: JSON.stringify({ type: "running", runningSessionIds: [sid] }) });
    await settle();
    lastEs().open();
    await settle();
    lastEs().emit({ type: "auto_compaction_start" });
  });
  assert.equal(w.latest.isCompacting, true);
  assert.equal(w.latest.agentRunning, false);
  world.agents.set(sid, { running: true, state: { isCompacting: false } });
  await act(async () => {
    window.dispatchEvent(new Event("online"));
    await settle();
  });
  assert.equal(w.latest.isCompacting, false, "the ref and rendered state share the same compaction lifecycle");
});

/** A compaction with no prompt behind it: busy enough to keep a run alive, never a run of its own. */
test("a compaction-only snapshot starts no run and ends without an empty-reply error", async () => {
  resetWorld();
  toastCalls.length = 0;
  const sid = "compaction-only-snapshot";
  primeSession(sid, [userMsg("u0", "q")]);
  world.agents.set(sid, { running: true, state: { isCompacting: true } });
  // The mount load is this fork's catch-up snapshot: it reports a compaction and
  // no prompt. Settling it as a run reported "The agent stopped without returning
  // a response" once the compaction ended.
  const w = await mountSession(sid);
  assert.equal(w.latest.isCompacting, true, "the native compaction is shown");
  assert.equal(w.latest.agentRunning, false, "a compaction runs no prompt");
  // The same snapshot reached as the catch-up for a running-channel frame (the
  // frame claims the session runs; the state says only a compaction) is no run
  // either.
  await act(async () => {
    world.runningStreams.at(-1).deliver({
      type: "message",
      data: JSON.stringify({ type: "running", runningSessionIds: [sid] }),
    });
    await settle();
  });
  assert.equal(w.latest.agentRunning, false, "a running frame backed only by a compaction starts no run");
  // The compaction ends: the chat stays idle and nothing reports a failed reply.
  world.agents.set(sid, { running: true, state: { isCompacting: false } });
  await act(async () => {
    window.dispatchEvent(new Event("online"));
    await settle();
  });
  assert.equal(w.latest.isCompacting, false);
  assert.equal(w.latest.agentRunning, false);
  assert.deepEqual(w.latest.notices.filter((notice) => notice.type === "error"), [],
    "a finished compaction is not an empty prompt reply");
  assert.deepEqual(toastCalls, []);
});

test("matching running frames received during an idle lookup trigger one fresh lookup", async () => {
  resetWorld();
  primeSession("late-start", [userMsg("u0", "q")]);
  const w = await mountSession("late-start");
  let release;
  world.holds.push({
    match: (method, url) => method === "GET" && url === "/api/agent/late-start",
    produce: () => new Promise((resolve) => { release = () => resolve({ value: { running: false, state: {} } }); }),
  });
  const running = world.runningStreams.at(-1);
  const frame = { type: "message", data: JSON.stringify({ type: "running", runningSessionIds: ["late-start"] }) };
  const gets = callsTo("GET", "/api/agent/late-start").length;
  await act(async () => {
    running.deliver(frame);
    await Promise.resolve();
  });
  assert.equal(typeof release, "function", "the first lookup is in flight");
  world.agents.set("late-start", { running: true, state: { isStreaming: true } });
  await act(async () => {
    running.deliver(frame);
    running.deliver(frame);
    release();
    await settle();
  });
  assert.equal(callsTo("GET", "/api/agent/late-start").length, gets + 2, "overlapping frames coalesce, but are not dropped");
  assert.equal(world.esInstances.length, 1);
  assert.equal(w.latest.agentRunning, true);
});

test("an idle running lookup without a newer matching frame is not retried", async () => {
  resetWorld();
  primeSession("still-idle", [userMsg("u0", "q")]);
  await mountSession("still-idle");
  const gets = callsTo("GET", "/api/agent/still-idle").length;
  await act(async () => {
    world.runningStreams.at(-1).deliver({ type: "message", data: JSON.stringify({ type: "running", runningSessionIds: ["still-idle"] }) });
    await settle();
  });
  assert.equal(callsTo("GET", "/api/agent/still-idle").length, gets + 1);
  assert.equal(world.esInstances.length, 0);
});

test("a delayed running lookup cannot take ownership of a locally started shell", async () => {
  resetWorld();
  primeSession("late-own-shell", [userMsg("u0", "q")]);
  const w = await mountSession("late-own-shell");
  let releaseLookup;
  let releaseBash;
  world.holds.push({
    match: (method, url) => method === "GET" && url === "/api/agent/late-own-shell",
    produce: () => new Promise((resolve) => { releaseLookup = () => resolve({ value: { running: true, state: { isBashRunning: true } } }); }),
  }, {
    match: (method, url, body) => method === "POST" && url === "/api/agent/late-own-shell" && body?.type === "bash",
    produce: () => new Promise((resolve) => { releaseBash = () => resolve({ value: { success: true, data: { output: "", exitCode: 0 } } }); }),
  });
  await act(async () => {
    world.runningStreams.at(-1).deliver({ type: "message", data: JSON.stringify({ type: "running", runningSessionIds: ["late-own-shell"] }) });
    await Promise.resolve();
  });
  let bash;
  await act(async () => { bash = w.latest.handleSend("!sleep 5"); await sleep(30); });
  assert.equal(w.latest.bashRunning, true);
  await act(async () => { releaseLookup(); await settle(); });
  assert.equal(world.esInstances.length, 0, "executeBash still exclusively owns the command's settlement");
  assert.equal(w.latest.bashRunning, true);
  await act(async () => { releaseBash(); await bash; });
  assert.equal(w.latest.bashRunning, false);
});

for (const stopped of [false, true]) {
  test(`a delayed running lookup cannot resurrect a ${stopped ? "stopped" : "completed"} local shell`, async () => {
    resetWorld();
    const sid = stopped ? "stopped-local-shell" : "completed-local-shell";
    primeSession(sid, [userMsg("u0", "q")]);
    const w = await mountSession(sid);
    let releaseLookup;
    let releaseBash;
    world.holds.push({
      match: (method, url) => method === "GET" && url === `/api/agent/${sid}`,
      produce: () => new Promise((resolve) => { releaseLookup = () => resolve({ value: { running: true, state: { isBashRunning: true } } }); }),
    }, {
      match: (method, url, body) => method === "POST" && url === `/api/agent/${sid}` && body?.type === "bash",
      produce: () => new Promise((resolve) => { releaseBash = () => resolve({ value: { success: true, data: { output: "", exitCode: stopped ? 130 : 0, cancelled: stopped } } }); }),
    });
    await act(async () => {
      world.runningStreams.at(-1).deliver({ type: "message", data: JSON.stringify({ type: "running", runningSessionIds: [sid] }) });
      await Promise.resolve();
    });
    let bash;
    await act(async () => { bash = w.latest.handleSend("!sleep 5"); await sleep(30); });
    assert.equal(w.latest.bashRunning, true);
    if (stopped) {
      await act(async () => { await w.latest.handleAbort(); });
      assert.equal(world.calls.some((call) => call.body?.type === "abort_bash"), true);
    }
    await act(async () => { releaseBash(); await bash; });
    assert.equal(w.latest.bashRunning, false);
    const streams = world.esInstances.length;
    await act(async () => { releaseLookup(); await settle(); });
    assert.equal(w.latest.bashRunning, false, "an obsolete snapshot cannot restart the settled shell's spinner");
    assert.equal(world.esInstances.length, streams, "an obsolete shell lookup cannot acquire an observer");
  });
}

test("a delayed running lookup cannot attach after a newer send went to the outbox", async () => {
  resetWorld();
  primeSession("held-new-prompt", [userMsg("u0", "q")]);
  const w = await mountSession("held-new-prompt");
  let release;
  world.holds.push({
    match: (method, url) => method === "GET" && url === "/api/agent/held-new-prompt",
    produce: () => new Promise((resolve) => { release = () => resolve({ value: { running: true, state: { isStreaming: true } } }); }),
  });
  await act(async () => {
    world.runningStreams.at(-1).deliver({ type: "message", data: JSON.stringify({ type: "running", runningSessionIds: ["held-new-prompt"] }) });
    await Promise.resolve();
  });
  world.outboxHold = true;
  await act(async () => {
    const receipt = await w.latest.handleSend("new prompt");
    assert.equal(receipt.status, "accepted");
  });
  assert.equal(world.esInstances.length, 1, "the held message opened the chat's stream");
  await act(async () => { release(); await settle(); });
  assert.equal(world.esInstances.length, 1, "a lookup from an older prompt generation cannot attach a second stream");
  assert.equal(w.latest.agentRunning, false);
});

test("a delayed running lookup cannot replace a side question's readiness wait", async () => {
  resetWorld();
  primeSession("late-btw", [userMsg("u0", "q")]);
  const w = await mountSession("late-btw");
  let release;
  world.holds.push({
    match: (method, url) => method === "GET" && url === "/api/agent/late-btw",
    produce: () => new Promise((resolve) => { release = () => resolve({ value: { running: true, state: { isStreaming: true } } }); }),
  });
  await act(async () => {
    world.runningStreams.at(-1).deliver({ type: "message", data: JSON.stringify({ type: "running", runningSessionIds: ["late-btw"] }) });
    await Promise.resolve();
  });
  let asking;
  await act(async () => { asking = w.latest.askBtw("side question"); await sleep(30); });
  const source = lastEs();
  assert.equal(source.readyState, FakeStream.CONNECTING);
  const gets = callsTo("GET", "/api/sessions/late-btw/state").length;
  await act(async () => { release(); await settle(); });
  assert.equal(world.esInstances.length, 1);
  assert.equal(source.closedByCaller, false);
  assert.equal(w.latest.agentRunning, false, "the stale lookup cannot manufacture a prompt run");
  assert.equal(callsTo("GET", "/api/sessions/late-btw/state").length, gets, "the stale lookup cannot refresh composer state");
  await act(async () => { source.open(); await asking; });
});

test("a running frame never touches a chat that already has its stream", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w } = await startRun("s1", "q1");
  const streams = world.esInstances.length;
  const gets = world.calls.filter((call) => call.method === "GET" && call.url === "/api/agent/s1").length;
  await act(async () => {
    world.runningStreams.at(-1).deliver({ type: "message", data: JSON.stringify({ type: "running", runningSessionIds: ["s1"] }) });
    await settle();
  });
  assert.equal(world.esInstances.length, streams);
  assert.equal(world.calls.filter((call) => call.method === "GET" && call.url === "/api/agent/s1").length, gets);
  assert.equal(w.latest.agentRunning, true);
});

test("a running frame leaves a shell command this idle chat runs to the chat", async () => {
  resetWorld();
  primeSession("own-shell", [userMsg("u0", "q")]);
  const w = await mountSession("own-shell");
  assert.equal(world.esInstances.length, 0, "an idle chat has no observer");
  let release;
  world.holds.push({
    match: (method, url, body) => method === "POST" && url === "/api/agent/own-shell" && body?.type === "bash",
    produce: () => new Promise((resolve) => { release = () => resolve({ value: { success: true, data: { output: "", exitCode: 0 } } }); }),
  });
  let bash;
  await act(async () => { bash = w.latest.handleSend("!sleep 5"); await sleep(30); });
  assert.equal(w.latest.bashRunning, true);
  // omp reports the session running while its shell runs; executeBash owns that command's settlement.
  world.agents.set("own-shell", { running: true, state: { isBashRunning: true } });
  const gets = world.calls.filter((call) => call.method === "GET" && call.url === "/api/agent/own-shell").length;
  await act(async () => {
    world.runningStreams.at(-1).deliver({ type: "message", data: JSON.stringify({ type: "running", runningSessionIds: ["own-shell"] }) });
    await settle();
  });
  assert.equal(world.calls.filter((call) => call.method === "GET" && call.url === "/api/agent/own-shell").length, gets);
  assert.equal(world.esInstances.length, 0);
  world.agents.set("own-shell", { running: false, state: {} });
  await act(async () => { release(); await bash; await settle(); });
  assert.equal(w.latest.bashRunning, false);
});

/** Delivers a `running` frame listing `ids` on the hook's running subscription. */
async function deliverRunning(ids) {
  await act(async () => {
    world.runningStreams.at(-1).deliver({ type: "message", data: JSON.stringify({ type: "running", runningSessionIds: ids }) });
    await Promise.resolve();
  });
}

/** Holds the next request `match` accepts; `release(value, status)` answers it. */
function holdNext(match) {
  const held = {};
  world.holds.push({ match, produce: () => new Promise((resolve) => { held.release = (value, status = 200) => resolve({ status, value }); }) });
  return held;
}

test("an idle snapshot cannot release a manual compaction this tab is still sending", async () => {
  resetWorld();
  const sid = "cold-compact";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  const compact = holdNext((method, url, body) => method === "POST" && url === `/api/agent/${sid}` && body?.type === "compact");
  let compacting;
  await act(async () => { compacting = w.latest.handleCompact(); await sleep(30); });
  assert.equal(w.latest.isCompacting, true);
  // omp is still starting: the state poll answers before the command reaches it.
  await act(async () => { window.dispatchEvent(new Event("online")); await sleep(30); });
  assert.equal(w.latest.isCompacting, true, "the command's own settlement releases Stop compaction");
  await act(async () => { await w.latest.handleCompact(); });
  assert.equal(callsTo("POST", `/api/agent/${sid}`).filter((call) => call.body?.type === "compact").length, 1, "no second compaction");
  await act(async () => { compact.release({ success: true, data: {} }); await compacting; });
  assert.equal(w.latest.isCompacting, false);
});

test("a late idle snapshot from an earlier compaction cannot release the next one", async () => {
  resetWorld();
  const sid = "two-compactions";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  world.agents.set(sid, { running: true, state: {} });
  await deliverRunning([sid]);
  await settle();
  await act(async () => { lastEs().open(); await sleep(30); });
  await act(async () => { lastEs().emit({ type: "auto_compaction_start" }); });
  const poll = holdNext((method, url) => method === "GET" && url === `/api/agent/${sid}`);
  await act(async () => { window.dispatchEvent(new Event("online")); await sleep(30); });
  assert.equal(typeof poll.release, "function", "the poll for the first compaction is in flight");
  await act(async () => {
    lastEs().emit({ type: "auto_compaction_end" });
    lastEs().emit({ type: "auto_compaction_start" });
  });
  await act(async () => { poll.release({ running: true, state: { isCompacting: false } }); await sleep(30); });
  assert.equal(w.latest.isCompacting, true, "the second compaction is still running");
});

test("a failed running lookup is retried", async () => {
  resetWorld();
  const sid = "lookup-retry";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  world.holds.push({ match: (method, url) => method === "GET" && url === `/api/agent/${sid}`, produce: async () => ({ status: 503, value: { error: "busy" } }) });
  world.agents.set(sid, { running: true, state: { isStreaming: true } });
  await deliverRunning([sid]);
  await settle();
  assert.equal(world.esInstances.length, 0, "the failed lookup attached nothing");
  await settle(1100);
  assert.equal(world.esInstances.length, 1, "the retry attaches the run");
  assert.equal(w.latest.agentRunning, true);
});

test("a running frame waits for the chat's first load, which it cannot invalidate", async () => {
  resetWorld();
  const sid = "hydrating";
  primeSession(sid, [userMsg("u0", "q")]);
  world.agents.set(sid, { running: true, state: { isStreaming: true } });
  const load = holdNext((method, url) => method === "GET" && url.startsWith(`/api/sessions/${sid}?`));
  const w = await mountSession(sid);
  assert.equal(typeof load.release, "function", "the first load is in flight");
  await deliverRunning([sid]);
  await settle();
  // On the old code the frame attached here, and the run's agent_start dropped the first load.
  if (lastEs()) await act(async () => { lastEs().open(); lastEs().emit({ type: "agent_start" }); });
  assert.equal(world.esInstances.length, 0, "no observer before the first load settles");
  const session = world.sessions.get(sid);
  await act(async () => {
    load.release({ sessionId: sid, filePath: "/fixture/session.jsonl", tree: [], leafId: session.leafId, context: { todoPhases: [], thinkingLevel: "off", model: null, ...session } });
    await settle();
  });
  assert.ok(w.latest.data, "the first load is kept");
  assert.equal(world.esInstances.length, 1, "then the run is attached");
  assert.equal(w.latest.agentRunning, true);
});

test("a running lookup from before an Edit cannot start a run during it", async () => {
  resetWorld();
  const sid = "lookup-edit";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  const lookup = holdNext((method, url) => method === "GET" && url === `/api/agent/${sid}`);
  const edit = holdNext((method, url, body) => method === "POST" && url === `/api/agent/${sid}` && body?.type === "edit_message");
  await deliverRunning([sid]);
  let editing;
  await act(async () => { editing = w.latest.handleEdit("e0", "q"); await sleep(30); });
  await act(async () => { lookup.release({ running: true, state: { isStreaming: true } }); await settle(); });
  assert.equal(world.esInstances.length, 0);
  assert.equal(w.latest.agentRunning, false);
  await act(async () => { edit.release({ success: true, data: { cancelled: true, leafId: null, sessionId: sid } }); await editing; });
});

test("a running lookup from before a completed Edit cannot attach its stale run", async () => {
  resetWorld();
  const sid = "lookup-edit-done";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  const lookup = holdNext((method, url) => method === "GET" && url === `/api/agent/${sid}`);
  await deliverRunning([sid]);
  world.holds.push({
    match: (method, url, body) => method === "POST" && url === `/api/agent/${sid}` && body?.type === "edit_message",
    produce: async () => ({ value: { success: true, data: { cancelled: true, leafId: null, sessionId: sid } } }),
  });
  await act(async () => { await w.latest.handleEdit("e0", "q"); });
  await act(async () => { lookup.release({ running: true, state: { isStreaming: true } }); await settle(); });
  assert.equal(world.esInstances.length, 0, "the snapshot predates the Edit");
  assert.equal(w.latest.agentRunning, false);
});

test("a manual compaction settling during an auto-compaction leaves Stop to the auto-compaction", async () => {
  resetWorld();
  const sid = "manual-then-auto";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  world.agents.set(sid, { running: true, state: {} });
  await deliverRunning([sid]);
  await settle();
  await act(async () => { lastEs().open(); await sleep(30); });
  world.holds.push({
    match: (method, url, body) => method === "POST" && url === `/api/agent/${sid}` && body?.type === "compact",
    produce: async () => ({ value: { success: true, data: {} } }),
  });
  const reload = holdNext((method, url) => method === "GET" && url.startsWith(`/api/sessions/${sid}?`));
  let compacting;
  await act(async () => { compacting = w.latest.handleCompact(); await sleep(30); });
  assert.equal(typeof reload.release, "function", "the manual compaction is reloading the transcript");
  await act(async () => { lastEs().emit({ type: "auto_compaction_start" }); });
  const session = world.sessions.get(sid);
  await act(async () => {
    reload.release({ sessionId: sid, filePath: "/fixture/session.jsonl", tree: [], leafId: session.leafId, context: { todoPhases: [], thinkingLevel: "off", model: null, ...session } });
    await compacting;
  });
  assert.equal(w.latest.isCompacting, true, "the auto-compaction is still running");
  await act(async () => { lastEs().emit({ type: "auto_compaction_end" }); });
  assert.equal(w.latest.isCompacting, false);
});

test("a run reported while a sent message waits in the outbox is adopted once its stream attaches", async () => {
  resetWorld();
  const sid = "held-then-remote";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  world.outboxHold = true;
  await act(async () => { assert.equal((await w.latest.handleSend("mine")).status, "accepted"); });
  assert.equal(world.outbox.length, 1, "the message waits in the outbox, not in a local startup");
  // Another tab's run starts while this held message's stream is still connecting.
  world.agents.set(sid, { running: true, state: { isStreaming: true } });
  await deliverRunning([sid]);
  await settle();
  assert.equal(world.esInstances.length, 1, "the held message's stream is the chat's only observer");
  assert.equal(w.latest.agentRunning, false, "nothing is adopted before the stream attaches");
  await act(async () => { lastEs().open(); lastEs().emit({ type: "connected" }); await settle(); });
  assert.equal(world.esInstances.length, 1, "the run is adopted on that stream, not a second one");
  assert.equal(w.latest.agentRunning, true);
  w.unmount();
});

test("a chat promoted from a new chat attaches a run reported after its first send failed", async (t) => {
  resetWorld();
  const sid = "promoted-later";
  primeSession(sid, [userMsg("u0", "q")]);
  let promoted = null;
  const view = renderHook(({ session }) => useAgentSession({ session, newSessionCwd: session ? null : "/workspace", onSessionCreated: (created) => { promoted = created; } }), { initialProps: { session: null } });
  await settle(30);
  world.holds.push({ match: (method, url) => method === "POST" && url === "/api/agent/new", produce: async () => ({ value: { sessionId: sid } }) });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let sending;
  await act(async () => { sending = view.result.current.handleSend("first"); for (let i = 0; i < 30; i++) await Promise.resolve(); });
  assert.equal(promoted?.id, sid);
  // Promotion re-renders the same chat with its new session; no mount load runs for it.
  await act(async () => { view.rerender({ session: promoted }); for (let i = 0; i < 30; i++) await Promise.resolve(); });
  await act(async () => {
    t.mock.timers.tick(60_001);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    assert.equal((await sending).status, "rejected");
  });
  world.agents.set(sid, { running: true, state: { isStreaming: true } });
  const gets = callsTo("GET", `/api/agent/${sid}`).length;
  await deliverRunning([sid]);
  assert.equal(callsTo("GET", `/api/agent/${sid}`).length, gets + 1, "no mount load to wait for");
  await act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); });
  assert.equal(view.result.current.agentRunning, true);
});

test("a run reported while a side question's stream connects is attached once that stream times out", async (t) => {
  resetWorld();
  const sid = "btw-then-remote";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let asking;
  await act(async () => { asking = w.latest.askBtw("side question"); for (let i = 0; i < 30; i++) await Promise.resolve(); });
  const observer = lastEs();
  assert.equal(observer.readyState, FakeStream.CONNECTING);
  world.agents.set(sid, { running: true, state: { isStreaming: true } });
  await deliverRunning([sid]);
  await act(async () => {
    t.mock.timers.tick(60_001);
    for (let i = 0; i < 50; i++) await Promise.resolve();
    assert.equal(await asking, false);
  });
  assert.equal(observer.closedByCaller, true, "the side question gave up its stream");
  assert.equal(world.esInstances.length, 2, "the held frame attaches the run without another frame");
  assert.equal(w.latest.agentRunning, true);
});

test("an auto-compaction whose end was missed cannot bring Stop back after a later manual compaction", async () => {
  resetWorld();
  const sid = "missed-auto-end";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  world.agents.set(sid, { running: true, state: {} });
  await deliverRunning([sid]);
  await settle();
  await act(async () => { lastEs().open(); await sleep(30); lastEs().emit({ type: "auto_compaction_start" }); });
  assert.equal(w.latest.isCompacting, true);
  // The end event is lost; the state poll settles it.
  world.agents.set(sid, { running: true, state: { isCompacting: false } });
  await act(async () => { window.dispatchEvent(new Event("online")); await sleep(30); });
  assert.equal(w.latest.isCompacting, false);
  await act(async () => { await w.latest.handleCompact(); await sleep(30); });
  assert.equal(w.latest.isCompacting, false, "the settled auto-compaction does not own Stop again");
});

test("a running lookup from before a manual compaction cannot release it", async () => {
  resetWorld();
  const sid = "lookup-compact";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  const lookup = holdNext((method, url) => method === "GET" && url === `/api/agent/${sid}`);
  const compact = holdNext((method, url, body) => method === "POST" && url === `/api/agent/${sid}` && body?.type === "compact");
  await deliverRunning([sid]);
  let compacting;
  await act(async () => { compacting = w.latest.handleCompact(); await sleep(30); });
  await act(async () => { lookup.release({ running: true, state: { isCompacting: false } }); await settle(); });
  assert.equal(w.latest.isCompacting, true);
  await act(async () => { await w.latest.handleCompact(); });
  assert.equal(callsTo("POST", `/api/agent/${sid}`).filter((call) => call.body?.type === "compact").length, 1, "no second compaction");
  await act(async () => { compact.release({ success: true, data: {} }); await compacting; });
});

test("the first load's idle state cannot overwrite a compaction a later lookup found", async () => {
  resetWorld();
  const sid = "mount-vs-lookup";
  primeSession(sid, [userMsg("u0", "q")]);
  const state = holdNext((method, url) => method === "GET" && url === `/api/sessions/${sid}/state`);
  const w = await mountSession(sid);
  world.agents.set(sid, { running: true, state: { isCompacting: true } });
  await deliverRunning([sid]);
  await settle();
  await act(async () => { state.release({ running: false, state: { isCompacting: false } }); await settle(); });
  assert.equal(w.latest.isCompacting, true, "the newer lookup's compaction stands");
  await act(async () => { await w.latest.handleCompact(); });
  assert.equal(callsTo("POST", `/api/agent/${sid}`).some((call) => call.body?.type === "compact"), false, "and the guard agrees with the control");
});

test("an idle session's held-message stream adopts no run", async () => {
  resetWorld();
  const sid = "held-idle";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  world.outboxHold = true;
  await act(async () => { assert.equal((await w.latest.handleSend("mine")).status, "accepted"); });
  await act(async () => { lastEs().open(); lastEs().emit({ type: "connected" }); await settle(); });
  assert.equal(w.latest.agentRunning, false);
  w.unmount();
});

test("a running lookup is dropped when the session left the running set meanwhile", async () => {
  resetWorld();
  const sid = "lookup-ended";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  const lookup = holdNext((method, url) => method === "GET" && url === `/api/agent/${sid}`);
  await deliverRunning([sid]);
  // The run ends (or its child exits) after the GET read its state, before the reply arrives.
  await deliverRunning([]);
  await act(async () => { lookup.release({ running: true, state: { isStreaming: true } }); await settle(); });
  assert.equal(world.esInstances.length, 0, "the finished run is not attached");
  assert.equal(w.latest.agentRunning, false);
  assert.equal(world.calls.some((call) => call.body?.type === "set_host_tools"), false, "no registration that could spawn a replacement");
});

test("a running lookup is dropped when the chat's session identity moves meanwhile", async () => {
  resetWorld();
  const sid = "lookup-identity";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  const lookup = holdNext((method, url) => method === "GET" && url === `/api/agent/${sid}`);
  await deliverRunning([sid]);
  w.latest.sessionIdRef.current = "moved-identity";
  await act(async () => { lookup.release({ running: true, state: { isStreaming: true } }); await settle(); });
  assert.equal(world.esInstances.length, 0);
  assert.equal(w.latest.agentRunning, false);
});

