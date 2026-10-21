import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": new URL("../", import.meta.url).pathname,
  },
});
const { EventStreamConnection, getEventStreamConnection } = await jiti.import("./event-stream-hub.ts");
const route = await jiti.import("../app/api/events/route.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const idleSnapshot = () => ({ cursor: { streamId: "test-stream", sequence: 0 } });

const decoder = new TextDecoder();

/** Next non-heartbeat SSE frame, with a watchdog so a missing flush fails
 * fast instead of hanging the test runner. */
async function readFrame(reader) {
  for (;;) {
    const r = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("read stalled: stream never delivered the expected frame")), 2000)),
    ]);
    if (r.done) throw new Error("stream ended before all expected frames were read");
    const text = decoder.decode(r.value);
    if (text.startsWith(":")) continue;
    const event = /^event: (.*)$/m.exec(text)?.[1] ?? "message";
    const data = /^data: (.*)$/m.exec(text)?.[1];
    return { event, data: JSON.parse(data) };
  }
}

/** Open a connection and consume its hello frame. */
async function connect(signal) {
  const connection = new EventStreamConnection(signal);
  const reader = connection.stream.getReader();
  const hello = await readFrame(reader);
  assert.deepEqual(hello, { event: "mux", data: { type: "hello", connectionId: connection.id } });
  return { connection, reader };
}

function withSession(id, session) {
  globalThis.__ompSessions ??= new Map();
  globalThis.__ompSessions.set(id, session);
  return () => globalThis.__ompSessions.delete(id);
}

function emitterSession(onDetach = () => {}) {
  const session = {
    emit: null,
    isAlive: () => true,
    getStreamSnapshot: idleSnapshot,
    onEvent(fn) {
      session.emit = fn;
      return onDetach;
    },
  };
  return session;
}

/** Subscribe a session channel and consume its open + connected frames. */
async function subscribeSession(connection, reader, sub, sessionId) {
  assert.deepEqual(await connection.subscribe(sub, { kind: "session", sessionId }), { ok: true });
  assert.deepEqual(await readFrame(reader), { event: "mux", data: { type: "open", sub } });
  const connected = await readFrame(reader);
  assert.equal(connected.event, sub);
  assert.equal(connected.data.type, "connected");
}

async function postEvents(body) {
  const res = await route.POST(new Request("http://localhost/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

test("POST attaches subscriptions to a live connection and rejects unknown or malformed requests", async () => {
  const release = withSession("route-sess", emitterSession());
  const ac = new AbortController();
  const res = route.GET(new Request("http://localhost/api/events", { signal: ac.signal }));
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body.getReader();
  try {
    const hello = await readFrame(reader);
    const { connectionId } = hello.data;
    assert.ok(getEventStreamConnection(connectionId), "the stream registers its connection id");

    assert.deepEqual(
      await postEvents({ connectionId, subscribe: { id: "s1", channel: { kind: "session", sessionId: "route-sess" } } }),
      { status: 200, body: { ok: true } },
    );
    assert.deepEqual(await readFrame(reader), { event: "mux", data: { type: "open", sub: "s1" } });
    assert.equal((await readFrame(reader)).data.type, "connected");

    const unmanaged = await postEvents({ connectionId, subscribe: { id: "s2", channel: { kind: "session", sessionId: "file-only" } } });
    assert.equal(unmanaged.status, 409);
    assert.equal(unmanaged.body.code, "session_not_managed");

    assert.equal((await postEvents({ connectionId, subscribe: { id: "mux", channel: { kind: "running" } } })).status, 400);
    assert.equal((await postEvents({ connectionId, subscribe: { id: "s3", channel: { kind: "bogus" } } })).status, 400);

    const unknown = await postEvents({ connectionId: "gone", subscribe: { id: "s4", channel: { kind: "running" } } });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, "unknown_connection");

    ac.abort();
    assert.equal(getEventStreamConnection(connectionId), undefined, "abort unregisters the connection");
    assert.equal((await postEvents({ connectionId, unsubscribe: "s1" })).body.code, "unknown_connection");
  } finally {
    await reader.cancel();
    release();
  }
});

test("session subscription unsubscribes exactly once across abort and cancel", async () => {
  let unsubscribeCount = 0;
  const release = withSession("test-sess-lifecycle", emitterSession(() => { unsubscribeCount += 1; }));
  try {
    const ac = new AbortController();
    const { connection, reader } = await connect(ac.signal);
    await subscribeSession(connection, reader, "s1", "test-sess-lifecycle");
    ac.abort();
    await reader.cancel();
    assert.equal(unsubscribeCount, 1, "RPC event listener must be unsubscribed exactly once");
    assert.equal(connection.isClosed, true);
  } finally {
    release();
  }
});

test("running subscription returns listener count to baseline on unsubscribe and on disconnect", async () => {
  globalThis.__ompRunningListeners ??= new Set();
  const baseline = globalThis.__ompRunningListeners.size;
  const { connection, reader } = await connect();
  try {
    assert.deepEqual(await connection.subscribe("s1", { kind: "running" }), { ok: true });
    assert.deepEqual(await readFrame(reader), { event: "mux", data: { type: "open", sub: "s1" } });
    // The running channel leads with the boot epoch (restart detection), then
    // the running-snapshot frame.
    const boot = await readFrame(reader);
    assert.equal(boot.data.type, "server_boot");
    assert.equal(typeof boot.data.startedAt, "number");
    const snapshot = await readFrame(reader);
    assert.equal(snapshot.data.type, "running");
    assert.ok(Array.isArray(snapshot.data.runningSessionIds));
    assert.ok(Array.isArray(snapshot.data.meta));
    assert.equal(globalThis.__ompRunningListeners.size, baseline + 1);
    connection.unsubscribe("s1");
    assert.equal(globalThis.__ompRunningListeners.size, baseline);

    await connection.subscribe("s2", { kind: "running" });
    assert.equal(globalThis.__ompRunningListeners.size, baseline + 1);
  } finally {
    await reader.cancel();
  }
  assert.equal(globalThis.__ompRunningListeners.size, baseline, "running listeners must not leak past the connection");
});

test("a notifications subscription keeps its tab reachable until it ends; malformed client ids are refused", async () => {
  const streams = () => globalThis.__ompNotificationHub?.streams ?? new Map();
  const { connection, reader } = await connect();
  try {
    assert.deepEqual(await connection.subscribe("s1", { kind: "notifications", clientId: "tab-notify-01" }), { ok: true });
    assert.deepEqual(await readFrame(reader), { event: "mux", data: { type: "open", sub: "s1" } });
    const sends = [...streams().get("tab-notify-01") ?? []];
    assert.equal(sends.length, 1, "the tab must be reachable while its notifications subscription is open");
    const event = { type: "completed", sessionId: "s-done", sessionName: "Done" };
    sends[0]({ kind: "toast", event });
    assert.deepEqual(await readFrame(reader), { event: "s1", data: { type: "notification", kind: "toast", event } });

    connection.unsubscribe("s1");
    assert.equal(streams().has("tab-notify-01"), false, "an ended subscription must not keep the tab reachable");

    // The id the notification hub routes by is validated before anything attaches.
    const bad = await postEvents({ connectionId: connection.id, subscribe: { id: "s2", channel: { kind: "notifications", clientId: "bad id" } } });
    assert.equal(bad.status, 400);
    assert.equal(streams().has("bad id"), false);

    await connection.subscribe("s3", { kind: "notifications", clientId: "tab-notify-02" });
    assert.equal(streams().has("tab-notify-02"), true);
  } finally {
    await reader.cancel();
  }
  assert.equal(streams().has("tab-notify-02"), false, "a dropped socket must detach its tabs");
});

test("host-tools subscription delivers cross-session calls and releases its listener", async () => {
  globalThis.__ompHostToolListeners ??= new Set();
  const listeners = globalThis.__ompHostToolListeners;
  const baseline = listeners.size;
  const { connection, reader } = await connect();
  try {
    assert.deepEqual(await connection.subscribe("s1", { kind: "host-tools" }), { ok: true });
    assert.deepEqual(await readFrame(reader), { event: "mux", data: { type: "open", sub: "s1" } });
    assert.equal(listeners.size, baseline + 1);
    const call = { sessionId: "bg-sess", id: "call-1", toolName: "open_url", arguments: { url: "https://example.com" } };
    for (const listener of listeners) listener(call);
    assert.deepEqual(await readFrame(reader), { event: "s1", data: { type: "host_tool_call", ...call } });

    connection.unsubscribe("s1");
    assert.equal(listeners.size, baseline);
    await connection.subscribe("s2", { kind: "host-tools" });
  } finally {
    await reader.cancel();
  }
  assert.equal(listeners.size, baseline, "host tool listeners must not leak past the connection");
});

test("subscriptions share one socket, stay separated by event name, and unsubscribe independently", async () => {
  const a = emitterSession();
  const b = emitterSession();
  const releaseA = withSession("mux-a", a);
  const releaseB = withSession("mux-b", b);
  const { connection, reader } = await connect();
  try {
    await subscribeSession(connection, reader, "s1", "mux-a");
    await subscribeSession(connection, reader, "s2", "mux-b");
    a.emit({ type: "agent_start" });
    b.emit({ type: "agent_end", isTerminal: true });
    assert.deepEqual(await readFrame(reader), { event: "s1", data: { type: "agent_start" } });
    assert.deepEqual(await readFrame(reader), { event: "s2", data: { type: "agent_end", isTerminal: true } });

    connection.unsubscribe("s1");
    a.emit({ type: "message_update", message: { content: "dropped" } });
    b.emit({ type: "agent_start" });
    assert.deepEqual(await readFrame(reader), { event: "s2", data: { type: "agent_start" } });
    assert.equal(connection.subscriptionCount, 1);
  } finally {
    await reader.cancel();
    releaseA();
    releaseB();
  }
});

test("slow consumer receives a coalesced message_update on resume without a new event or heartbeat", { timeout: 5000 }, async () => {
  const session = emitterSession();
  const release = withSession("test-sess-resume", session);
  const { connection, reader } = await connect();
  try {
    await subscribeSession(connection, reader, "s1", "test-sess-resume");
    // Consumer stalled: v1/v2 fill the queue, v3 is coalesced. Only a resumed
    // pull() can deliver it — no heartbeat yet, no new event.
    session.emit({ type: "message_update", message: { id: "m1", content: "v1" } });
    session.emit({ type: "message_update", message: { id: "m1", content: "v2" } });
    session.emit({ type: "message_update", message: { id: "m1", content: "v3" } });
    const contents = [];
    for (let i = 0; i < 3; i++) contents.push((await readFrame(reader)).data.message.content);
    assert.deepEqual(contents, ["v1", "v2", "v3"], "latest snapshot flushed exactly once on resume");
  } finally {
    await reader.cancel();
    release();
  }
});

test("multiple coalesced updates collapse to the latest snapshot (latest-wins)", { timeout: 5000 }, async () => {
  const session = emitterSession();
  const release = withSession("test-sess-latest", session);
  const { connection, reader } = await connect();
  try {
    await subscribeSession(connection, reader, "s1", "test-sess-latest");
    for (const content of ["v1", "v2", "v3", "v4"]) {
      session.emit({ type: "message_update", message: { id: "m3", content } });
    }
    const contents = [];
    for (let i = 0; i < 3; i++) contents.push((await readFrame(reader)).data.message.content);
    assert.deepEqual(contents, ["v1", "v2", "v4"], "superseded snapshot must never reach the consumer");
  } finally {
    await reader.cancel();
    release();
  }
});

test("terminal event flushes the buffered update first and arrives last, in order", { timeout: 5000 }, async () => {
  const session = emitterSession();
  const release = withSession("test-sess-terminal", session);
  const { connection, reader } = await connect();
  try {
    await subscribeSession(connection, reader, "s1", "test-sess-terminal");
    session.emit({ type: "message_update", message: { id: "m4", content: "v1" } });
    session.emit({ type: "message_update", message: { id: "m4", content: "v2" } });
    session.emit({ type: "message_update", message: { id: "m4", content: "v3" } });
    session.emit({ type: "agent_end", isTerminal: true });
    const order = [];
    for (let i = 0; i < 4; i++) order.push((await readFrame(reader)).data.type);
    assert.deepEqual(
      order,
      ["message_update", "message_update", "message_update", "agent_end"],
      "buffered snapshot must precede the terminal event, never the reverse",
    );
  } finally {
    await reader.cancel();
    release();
  }
});

test("backpressured disconnect with a pending update cleans up exactly once", async () => {
  let unsubscribeCount = 0;
  const session = emitterSession(() => { unsubscribeCount += 1; });
  const release = withSession("test-sess-disconnect", session);
  const ac = new AbortController();
  const { connection, reader } = await connect(ac.signal);
  try {
    await subscribeSession(connection, reader, "s1", "test-sess-disconnect");
    session.emit({ type: "message_update", message: { id: "m2", content: "v1" } });
    session.emit({ type: "message_update", message: { id: "m2", content: "v2" } });
    session.emit({ type: "message_update", message: { id: "m2", content: "v3" } });
    ac.abort();
  } finally {
    await reader.cancel();
    release();
  }
  assert.equal(unsubscribeCount, 1, "unsubscribe must fire exactly once across abort+cancel");
});

test("session subscription attaches its listener before announcing connected", async () => {
  // The local contract has no stream cursor; the event-gap guarantee is that
  // onEvent is subscribed BEFORE the connected frame is queued, so a replay
  // the listener emits synchronously still precedes `connected` on the wire.
  let listener;
  let detachCount = 0;
  const release = withSession("subscribe-before-snapshot", {
    isAlive: () => true,
    onEvent(callback) {
      listener = callback;
      callback({ type: "extension_ui_request", id: "pending-dialog", method: "input" });
      return () => { detachCount += 1; };
    },
  });
  const { connection, reader } = await connect();
  try {
    await connection.subscribe("s1", { kind: "session", sessionId: "subscribe-before-snapshot" });
    const frames = [];
    for (let i = 0; i < 3; i++) frames.push(await readFrame(reader));
    assert.deepEqual(frames[0], { event: "mux", data: { type: "open", sub: "s1" } });
    assert.deepEqual(frames.slice(1).map((frame) => frame.data.type), ["extension_ui_request", "connected"]);
    assert.equal(typeof listener, "function", "the wrapper listener must be attached during open");
  } finally {
    await reader.cancel();
    release();
  }
  assert.equal(detachCount, 1);
});

test("an unserializable UI replay ends only its own subscription and releases it", async () => {
  let detachCount = 0;
  const releaseBroken = withSession("failed-ui-replay", {
    isAlive: () => true,
    getStreamSnapshot: idleSnapshot,
    onEvent(listener) {
      const circular = { type: "extension_ui_request" };
      circular.self = circular;
      listener(circular);
      return () => { detachCount += 1; };
    },
  });
  const healthy = emitterSession();
  const releaseHealthy = withSession("healthy", healthy);
  const { connection, reader } = await connect();
  try {
    await subscribeSession(connection, reader, "s1", "healthy");
    await connection.subscribe("s2", { kind: "session", sessionId: "failed-ui-replay" });
    assert.deepEqual(await readFrame(reader), { event: "mux", data: { type: "open", sub: "s2" } });
    assert.deepEqual(await readFrame(reader), { event: "mux", data: { type: "end", sub: "s2" } });
    assert.equal(detachCount, 1);

    healthy.emit({ type: "agent_start" });
    assert.deepEqual(await readFrame(reader), { event: "s1", data: { type: "agent_start" } }, "the shared socket survives");
  } finally {
    await reader.cancel();
    releaseBroken();
    releaseHealthy();
  }
});

test("session channel observes a quiet real wrapper and refuses file-only sessions", async () => {
  const id = "quiet-wrapper";
  const wrapper = new AgentSessionWrapper({
    isAlive: true,
    onFrame: () => () => {},
    sendFrame() {},
    sendCommand: async () => { throw new Error("an observer must not send RPC commands"); },
    dispose: async () => {},
  }, process.cwd());
  const release = withSession(id, wrapper);
  const { connection, reader } = await connect();
  try {
    await connection.subscribe("s1", { kind: "session", sessionId: id });
    await readFrame(reader); // open
    const connected = await readFrame(reader);
    assert.deepEqual(connected.data, { type: "connected", sessionId: id });
    const absent = await connection.subscribe("s2", { kind: "session", sessionId: "file-only" });
    assert.equal(absent.ok, false);
    assert.equal(absent.status, 409);
    assert.equal(connection.subscriptionCount, 1, "a refused subscription is not retained");
  } finally {
    await reader.cancel();
    await wrapper.destroyAndWait();
    release();
  }
});

test("file channel enforces the allow-list and reports content changes", { timeout: 10000 }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-event-stream-"));
  const allowed = path.join(base, "allowed");
  const outside = path.join(base, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  const watched = path.join(allowed, "notes.txt");
  const secret = path.join(outside, "secret.txt");
  fs.writeFileSync(watched, "one");
  fs.writeFileSync(secret, "secret");
  const previousRoots = globalThis.__piAllowedRootsCache;
  globalThis.__piAllowedRootsCache = { roots: new Set([allowed]), expiresAt: Date.now() + 60_000 };
  const { connection, reader } = await connect();
  t.after(async () => {
    await reader.cancel();
    globalThis.__piAllowedRootsCache = previousRoots;
    fs.rmSync(base, { recursive: true, force: true });
  });

  const denied = await connection.subscribe("s1", { kind: "file", path: secret, sessionId: null });
  assert.deepEqual([denied.status, denied.code], [403, "access_denied"]);
  const missing = await connection.subscribe("s2", { kind: "file", path: path.join(allowed, "gone.txt"), sessionId: null });
  assert.deepEqual([missing.status, missing.code], [404, "file_not_found"]);
  const directory = await connection.subscribe("s3", { kind: "file", path: allowed, sessionId: null });
  assert.deepEqual([directory.status, directory.code], [400, "not_a_file"]);

  assert.deepEqual(await connection.subscribe("s4", { kind: "file", path: watched, sessionId: null }), { ok: true });
  assert.deepEqual(await readFrame(reader), { event: "mux", data: { type: "open", sub: "s4" } });
  assert.equal((await readFrame(reader)).data.type, "connected");
  fs.writeFileSync(watched, "one two");
  const change = await readFrame(reader);
  assert.equal(change.event, "s4");
  assert.equal(change.data.type, "change");
  assert.equal(change.data.size, 7);
});

test("the heartbeat emits a mux ping frame a browser can see", { timeout: 5000 }, async () => {
  const connection = new EventStreamConnection(undefined, 40);
  const reader = connection.stream.getReader();
  try {
    assert.deepEqual(await readFrame(reader), { event: "mux", data: { type: "hello", connectionId: connection.id } });
    assert.deepEqual(await readFrame(reader), { event: "mux", data: { type: "ping" } });
  } finally {
    await reader.cancel();
    connection.close();
  }
});

test("a consumer that never reads is closed and releases its subscriptions", { timeout: 5000 }, async () => {
  let detached = false;
  const release = withSession("dead-sess", emitterSession(() => { detached = true; }));
  try {
    const connection = new EventStreamConnection(undefined, 30);
    // Nobody ever reads connection.stream — the half-open-socket stand-in:
    // the queue only grows, so the starvation guard must close the connection.
    assert.deepEqual(await connection.subscribe("s1", { kind: "session", sessionId: "dead-sess" }), { ok: true });
    const deadline = Date.now() + 1500;
    while (!connection.isClosed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert.ok(connection.isClosed, "the starved connection closes itself");
    assert.ok(detached, "the session listener is released");
    const after = await connection.subscribe("s2", { kind: "running" });
    assert.deepEqual([after.status, after.code], [404, "unknown_connection"]);
  } finally {
    release();
  }
});

test("destroying the wrapper ends its session subscription so the client can re-attach to the respawn", async () => {
  const id = "destroy-ends-sub";
  const wrapper = new AgentSessionWrapper({
    isAlive: true,
    onFrame: () => () => {},
    sendFrame() {},
    sendCommand: async () => { throw new Error("an observer must not send RPC commands"); },
    dispose: async () => {},
  }, process.cwd());
  const release = withSession(id, wrapper);
  const { connection, reader } = await connect();
  try {
    await subscribeSession(connection, reader, "s1", id);
    // The idle-destroy backstop (or a crash) tears the wrapper down while the
    // browser still watches the channel: the destroy frame must flow and the
    // subscription must end immediately after. A sub left open on the zombie
    // wrapper made the send path trust `isOpen`, skip the cold get_state, and
    // every frame of the respawned wrapper emitted to zero listeners — the
    // frozen chat after idle.
    await wrapper.destroyAndWait();
    assert.deepEqual(await readFrame(reader), { event: "s1", data: { type: "session_destroyed" } });
    assert.deepEqual(await readFrame(reader), { event: "mux", data: { type: "end", sub: "s1" } }, "the client learns the stream ended instead of sitting open on the zombie");
    assert.equal(connection.subscriptionCount, 0, "the ended subscription is released");
    // The worker's resubscribe (the browser worker retries an ended channel
    // like EventSource reconnects) lands on the wrapper respawned by the next
    // command, and frames flow again.
    const respawned = new AgentSessionWrapper({
      isAlive: true,
      onFrame: () => () => {},
      sendFrame() {},
      sendCommand: async () => { throw new Error("unused"); },
      dispose: async () => {},
    }, process.cwd());
    const releaseRespawned = withSession(id, respawned);
    try {
      await subscribeSession(connection, reader, "s1", id);
      respawned.emit({ type: "agent_start" });
      assert.deepEqual(await readFrame(reader), { event: "s1", data: { type: "agent_start" } });
    } finally {
      await respawned.destroyAndWait();
      releaseRespawned();
    }
  } finally {
    await reader.cancel();
    release();
  }
});
