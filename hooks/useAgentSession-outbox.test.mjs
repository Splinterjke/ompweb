import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { mock } from "bun:test";

// React ships `act` only in its development build; force NODE_ENV before any
// React module loads so these tests work regardless of the environment's
// default (production builds throw "act(...) is not supported").
process.env.NODE_ENV = "test";
const { act, cleanup, renderHook } = await import("@testing-library/react/pure.js");

// Message-outbox client port (#403) on this repo's monolithic
// hooks/useAgentSession.ts: every existing-session send (prompt, steer,
// follow-up, streaming-behavior) becomes a durable outbox hold instead of a
// direct POST, `outbox_update` session frames and the state route's snapshot
// drive the held bubbles, and a delete splits between this browser's
// IndexedDB copy and the server's queue. Driven through the fake shared
// worker + fetch router below (the useAgentSession.rpc.test.mjs harness,
// trimmed to the outbox needs) with an in-memory stand-in for the
// event-stream worker's IndexedDB leg.

// Native `import()` throughout (bun's module registry): the hook loads natively, and jiti keeps its own cache, so
// anything imported through jiti lands on a SECOND copy of every module — the wrapped `toast`, the draft store and
// i18n the harness reads would be different objects than the ones the hook mutates (the identity checks below prove it).
// ---------------------------------------------------------------------------
// The message outbox (#403) rides lib/event-stream.ts in the browser: the
// event-stream worker holds the durable entries, the tab-side Transport
// speaks {op:"outbox_add"/"outbox_drop"} against {outbox}/{outboxAdded}/
// {outboxDropped} replies, and the hook merges that local snapshot with the
// server's (`outbox_update` frames + the state route's answer). The fake
// shared worker above does not speak that leg, so this swap replaces exactly
// the four outbox exports with an in-memory ledger answering in the worker's
// real event shapes; every other event-stream export keeps its real
// behavior (the harness drives openEventStream through the fake worker).
// `fakeOutbox.stored()` stands in for the server dispatcher accepting an
// entry (the worker's `outboxStored` event, then the list without it).
// ---------------------------------------------------------------------------
const fakeOutbox = {
  entries: [],
  listeners: new Set(),
  nextId: 1,
  /** Adds whose worker reply is still owed (stage-1 entries in the delete test). */
  pendingAdds: new Map(),
  /** Answer one owed add exactly as the worker commits it: the
   * `outboxAdded` reply first; the `stored` event comes only after. */
  ack(id) {
    const resolve = this.pendingAdds.get(id);
    if (!resolve) throw new Error(`fake outbox: no pending add ${id}`);
    this.pendingAdds.delete(id);
    resolve();
  },
  emit() {
    const entries = this.entries.map((entry) => ({ ...entry }));
    for (const listener of this.listeners) listener({ entries });
  },
  /** Entries the fake server dispatcher holds (rendered through
   * `outbox_update` frames): the delete routing test flips an entry between
   * the two ledgers exactly once the real dispatcher's stored/settle events
   * would. */
  serverLedger: [],
  reset() {
    this.entries = [];
    this.pendingAdds.clear();
  },
  /** The server dispatcher accepted an entry (its `outboxAdded` reply must
   * have been answered via `ack` first): the worker's stored event, then
   * the list without it (it leaves the browser's ledger once stored). */
  stored(id, overrides = {}) {
    const entry = this.entries.find((held) => held.id === id);
    if (!entry) throw new Error(`fake outbox: no entry ${id}`);
    if (this.pendingAdds.has(id)) throw new Error(`fake outbox: the add of ${id} is not answered yet`);
    for (const listener of this.listeners) {
      listener({ stored: { ...entry, state: "held", ...overrides } });
    }
    this.entries = this.entries.filter((held) => held.id !== id);
    this.emit();
  },

};
const realEventStream = await import("@/lib/event-stream");
mock.module("@/lib/event-stream", () => ({
  ...realEventStream,
  newOutboxId: () => `held-${fakeOutbox.nextId++}`,
  addToOutbox: (entry) => {
    fakeOutbox.entries.push({ ...entry, state: "sending" });
    fakeOutbox.emit();
    // The worker's `outboxAdded` answer lands only when the fake test says
    // the write committed — a held send stays un-ACKed until then.
    return new Promise((resolve) => { fakeOutbox.pendingAdds.set(entry.id, resolve); });
  },
  dropFromOutbox: async (id) => {
    fakeOutbox.entries = fakeOutbox.entries.filter((entry) => entry.id !== id);
        fakeOutbox.emit();
  },
  subscribeOutbox: (listener) => {
    fakeOutbox.listeners.add(listener);
    listener({ entries: fakeOutbox.entries.map((entry) => ({ ...entry })) });
    return () => fakeOutbox.listeners.delete(listener);
  },
}));

const { useAgentSession } = await import("./useAgentSession.ts");

// The remote-host blocks below assert on toasts. Upstream spies through bun's
// `mock.module`, which this harness has no equivalent of, so the real `toast`
// object the hook imports is wrapped in place; calls land as [kind, title].
const { toast } = await import("@/components/ui/toast");
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
  }
  emit(event) {
    if (this.closedByCaller) return;
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
        }
      },
    };
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
};

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
    // The real route answers the #403 outbox fields beside `running` (and in
    // its 503 body during a host outage); the hook reads them from there.
    return jsonResponse(200, {
      running: a.running,
      state: a.state,
      ...(a.outbox ? { outbox: a.outbox, outboxScope: a.outboxScope, outboxSettledIds: a.outboxSettledIds } : {}),
    });
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
    if (method === "GET") {
      // Faithful to the real route: an id with neither a live wrapper nor an
      // on-disk file is not found (a6ebcc7e review; the stub here keeps the
      // live wrapper in world.agents, so an unknown id means both are gone).
      const a = world.agents.get(sid);
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


const userMsg = (id, text) => ({ role: "user", id, content: text, timestamp: 1 });
const assistantMsg = (id, text) => ({
  role: "assistant",
  id,
  provider: "test",
  model: "test-model",
  content: [{ type: "text", text }],
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** Run a hold-path send (handleSend / handleSteer / handleFollowUp /
 * handlePromptWithStreamingBehavior) and let the fake worker's IndexedDB
 * commit answer it — the composer clears only on that reply. Returns the
 * method's own receipt. */
async function sendHeld(w, method, ...args) {
  let receipt;
  const sending = w.latest[method](...args);
  // The hold's IndexedDB commit is synchronous in the fake: the entry is in
  // the ledger once the microtask queue drains. Then answer the worker's
  // `outbox_add` — the send settles on that reply.
  await settle(20);
  fakeOutbox.ack(fakeOutbox.entries.at(-1).id);
  await act(async () => { receipt = await sending; });
  return receipt;
}

/** Mount, send once (a #403 send opens the session channel — no wrapper is
 * needed for the held view), and hand back the harness plus that stream. */
async function mountOpen(sid) {
  // The first hold needs the install scope; mountSession's beforeEach
  // cleared storage, so seed it like a session that already sent once.
  localStorage.setItem("omp-web:outbox-scope", "install-scope");
  const w = await mountSession(sid);
  await sendHeld(w, "handleSend", "open the channel");
  const es = world.esInstances.find((s) => s.channel?.sessionId === sid);
  return { w, es };
}

/** The outbox view of a session, as the state route answers it (#403 fields
 * ride both the 200 body and the host-offline 503 body). */
const outboxEntry = (id, overrides = {}) => ({
  id,
  sessionId: "s1",
  scope: "install-scope",
  mode: "prompt",
  message: `held ${id}`,
  advisor: false,
  state: "pending",
  createdAt: 1,
  ...overrides,
});

test("an existing session's send becomes an outbox hold: no prompt POST, the bubble appears", async () => {
  resetWorld();
  fakeOutbox.reset();
  localStorage.setItem("omp-web:outbox-scope", "install-scope");
  primeSession("s1", [userMsg("u1", "loaded question"), assistantMsg("a1", "loaded answer")]);
  const w = await mountSession("s1");
  let accepted;
  accepted = await sendHeld(w, "handleSend", "keep this safe");
  assert.equal(accepted.status, "accepted");
  assert.deepEqual(callsTo("POST", "/api/agent/s1").filter((c) => c.body?.type === "prompt"), [],
    "#403: the send never reaches the agent route directly");
  assert.equal(fakeOutbox.entries.length, 1);
  assert.equal(fakeOutbox.entries[0].message, "keep this safe");
  assert.equal(fakeOutbox.entries[0].mode, "prompt");
  assert.equal(fakeOutbox.entries[0].sessionId, "s1");
  assert.equal(fakeOutbox.entries[0].scope, "install-scope");
  assert.equal(fakeOutbox.entries[0].state, "sending", "the worker commits it as sending (server-dispatcher owned from there)");
  assert.deepEqual(w.latest.heldMessages.map((held) => [held.message, held.mode, held.local]),
    [["keep this safe", "prompt", true]]);
});

test("steer, follow-up and the streaming behavior all hold through the outbox with their modes", async () => {
  resetWorld();
  fakeOutbox.reset();
  localStorage.setItem("omp-web:outbox-scope", "install-scope");
  primeSession("s1", [userMsg("u1", "q"), assistantMsg("a1", "a")]);
  const w = await mountSession("s1");
  assert.equal(await sendHeld(w, "handleSteer", "steer text"), true);
  assert.equal(await sendHeld(w, "handleFollowUp", "follow text"), true);
  assert.equal(await sendHeld(w, "handlePromptWithStreamingBehavior", "behavior text", "steer"), true);
  assert.deepEqual(callsTo("POST", "/api/agent/s1").filter((c) =>
    ["steer", "follow_up", "prompt"].includes(c.body?.type)), [], "no direct write commands");
  assert.deepEqual(fakeOutbox.entries.map((entry) => entry.mode), ["steer", "followUp", "steer"]);
  assert.deepEqual(w.latest.heldMessages.map((held) => held.message),
    ["steer text", "follow text", "behavior text"]);
});

test("an outbox_update frame shows the server's held list and settles retire it", async () => {
  resetWorld();
  fakeOutbox.reset();
  primeSession("s1", [userMsg("u1", "q"), assistantMsg("a1", "a")]);
  const { w, es } = await mountOpen("s1");
  assert.ok(es, "a send opened the session channel");
  await act(async () => {
    es.open();
    es.emit({ type: "outbox_update", entries: [outboxEntry("srv-1"), outboxEntry("srv-2", { mode: "steer" })], settledIds: [] });
  });
  // The frames retire entries only through snapshots: the stored copy stays
  // rendered until `settledIds` (or a snapshot listing it delivered) covers
  // its id (#403: the held view never blinks on the add handshake).
  await act(async () => {
    es.emit({ type: "outbox_update", entries: [outboxEntry("srv-1"), outboxEntry("srv-2", { mode: "steer" })], settledIds: [] });
  });
  assert.equal(fakeOutbox.entries.length, 1, "the channel-opening send is still held here");
  const heldId = fakeOutbox.entries[0].id;
  fakeOutbox.stored(heldId);
  await settle(20);
  assert.ok(w.latest.heldMessages.some((held) => held.id === heldId && !held.local),
    "the stored copy keeps the bubble after the worker's stored event");
  // The server's list leads, then the stored copy the dispatcher accepted
  // (no snapshot has covered its id yet — it leaves with a settle).
  assert.deepEqual(w.latest.heldMessages.filter((held) => !held.local).map((held) => [held.id, held.local]),
    [["srv-1", false], ["srv-2", false], [heldId, false]]);
  await act(async () => {
    es.emit({ type: "outbox_update", entries: [outboxEntry("srv-2", { mode: "steer" })], settledIds: ["srv-1", heldId] });
  });
  assert.deepEqual(w.latest.heldMessages.filter((held) => !held.local).map((held) => held.id), ["srv-2"],
    "settledIds retire the stored copy along with the server's entry");
});

test("the state route's outbox snapshot hydrates held bubbles before any frame lands", async () => {
  resetWorld();
  fakeOutbox.reset();
  primeSession("s1", [userMsg("u1", "q"), assistantMsg("a1", "a")]);
  Object.assign(world.agents.get("s1"), { outbox: [outboxEntry("srv-9")], outboxScope: "install-scope", outboxSettledIds: [] });
  const w = await mountSession("s1");
  assert.deepEqual(w.latest.heldMessages.map((held) => [held.id, held.local]), [["srv-9", false]]);
  assert.equal(localStorage.getItem("omp-web:outbox-scope"), "install-scope", "the scope was remembered");
});

test("deleting a held bubble: sending refuses, a stored copy goes outbox_remove, a failed local one drops", async () => {
  resetWorld();
  fakeOutbox.reset();
  localStorage.setItem("omp-web:outbox-scope", "install-scope");
  primeSession("s1", [userMsg("u1", "q"), assistantMsg("a1", "a")]);
  const { w, es } = await mountOpen("s1");
  await act(async () => { es.open(); });
  // Refused — the browser's entry is `sending`: the dispatcher may already
  // own it; nothing leaves either store.
  const sendingId = fakeOutbox.entries[0].id;
  await act(async () => { await w.latest.deleteHeldMessage(sendingId); });
  assert.ok(fakeOutbox.entries.some((entry) => entry.id === sendingId), "a sending entry stays");
  assert.equal(callsTo("POST", "/api/agent/s1").filter((c) => c.body?.type === "outbox_remove").length, 0);
  // Server-owned — a second send, the worker's `outbox_add` accepted: the
  // entry leaves the browser's ledger, renders from the stored event, and
  // its delete goes outbox_remove through the agent route.
  await sendHeld(w, "handleSend", "mine too");
  const sharedId = fakeOutbox.entries[0].id;
  fakeOutbox.stored(sharedId, { mode: "prompt" });
  await settle(20);
  assert.ok(w.latest.heldMessages.some((held) => held.id === sharedId && !held.local && held.state === "held"),
    "the stored copy renders until a snapshot retires it");
  await act(async () => { await w.latest.deleteHeldMessage(sharedId); });
  assert.deepEqual(callsTo("POST", "/api/agent/s1").filter((c) => c.body?.type === "outbox_remove").map((c) => c.body.id),
    [sharedId], "the server's copy is deleted through the agent route");
  // Failed local — the worker refused the add for good (O6): the bubble is
  // the browser's again and the delete drops it from the store, no POST.
  await act(async () => {
    es.emit({ type: "outbox_update", entries: [], settledIds: [sharedId] });
  });
  await sendHeld(w, "handleSend", "keep me");
  const failedId = fakeOutbox.entries[0].id;
  fakeOutbox.entries[0].state = "failed";
  fakeOutbox.entries[0].error = "The message cannot be saved.";
  fakeOutbox.emit();
  await settle(20);
  await act(async () => { await w.latest.deleteHeldMessage(failedId); });
  assert.equal(fakeOutbox.entries.find((entry) => entry.id === failedId), undefined,
    "the failed entry is gone from the fake store");
  assert.equal(callsTo("POST", "/api/agent/s1").filter((c) => c.body?.type === "outbox_remove").length, 1,
    "the local delete never reaches the server");
});

test("a sending or delivering entry cannot be deleted: omp may already hold it", async () => {
  resetWorld();
  fakeOutbox.reset();
  localStorage.setItem("omp-web:outbox-scope", "install-scope");
  primeSession("s1", [userMsg("u1", "q"), assistantMsg("a1", "a")]);
  const first = await mountSession("s1");
  await sendHeld(first, "handleSend", "mine");
  first.unmount();
  // Re-mount with the entry mid-flight: deleteHeldMessage must refuse while
  // the dispatcher owns it.
  const local = fakeOutbox.entries[0];
  assert.equal(local.state, "sending", "the worker's ledger holds it as sending");
  const w = await mountSession("s1");
  await act(async () => { await w.latest.deleteHeldMessage(local.id); });
  assert.equal(fakeOutbox.entries.length, 1, "a sending entry stays");
  assert.deepEqual(fakeOutbox.entries[0].message, "mine");
});
