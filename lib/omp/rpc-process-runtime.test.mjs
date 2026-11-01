import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { RpcProcess } = jiti("./rpc-process.ts");
const { encodeRpcFrames } = jiti("./rpc-frame.ts");

function makeTransport() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 4321,
    kill() {
      queueMicrotask(() => child.emit("exit", 0, null));
      return true;
    },
  });
  const commands = [];
  const spawnCalls = [];
  let partial = "";
  let onCommand = () => {};
  stdin.on("data", (chunk) => {
    partial += chunk.toString("utf8");
    const lines = partial.split("\n");
    partial = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      const command = JSON.parse(line);
      commands.push(command);
      onCommand(command);
    }
  });
  stdin.on("end", () => queueMicrotask(() => child.emit("exit", 0, null)));
  queueMicrotask(() => {
    stdout.write(`${JSON.stringify({ type: "ready", supportedProtocolVersions: [1, 2] })}\n`);
  });

  return {
    commands,
    spawnCalls,
    child,
    set onCommand(callback) { onCommand = callback; },
    send(frame) { stdout.write(`${JSON.stringify(frame)}\n`); },
    sendFrames(frames) { for (const frame of frames) stdout.write(frame); },
    spawn(...args) { spawnCalls.push(args); return child; },
  };
}

function startProcess(transport) {
  return new RpcProcess({
    cwd: process.cwd(),
    dependencies: {
      resolveOmpBin: () => "fake-omp",
      spawn: transport.spawn,
    },
  });
}

test("RpcProcess negotiates v2 and correlates out-of-order command responses", async () => {
  const transport = makeTransport();
  transport.onCommand = (command) => {
    if (command.type === "negotiate_protocol") {
      transport.send({ type: "response", id: command.id, command: command.type, success: true, data: { protocolVersion: 2 } });
    }
  };
  const proc = startProcess(transport);
  const ready = await proc.waitReady();
  assert.equal(await proc.negotiateProtocol(ready), 2);

  const first = proc.sendCommand({ type: "first" });
  const second = proc.sendCommand({ type: "second" });
  // Writes are serialized through a FIFO queue (physical v2 chunk sequences
  // must not interleave), so the commands land asynchronously.
  while (transport.commands.length < 2) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const [firstCommand, secondCommand] = transport.commands.slice(-2);
  transport.send({ type: "response", id: secondCommand.id, command: "second", success: true, data: "second" });
  transport.send({ type: "response", id: firstCommand.id, command: "first", success: true, data: "first" });

  assert.equal(await first, "first");
  assert.equal(await second, "second");
  await proc.dispose(0);
});

test("RpcProcess does not create a separate Windows console", async () => {
  const transport = makeTransport();
  const proc = startProcess(transport);
  assert.equal(transport.spawnCalls[0][2].windowsHide, true);
  if (process.platform === "win32") assert.equal(transport.spawnCalls[0][2].detached, false);
  await proc.dispose(0);
});

test("RpcProcess reassembles v2 events and rejects pending commands when the child crashes", async () => {
  const transport = makeTransport();
  transport.onCommand = (command) => {
    if (command.type === "negotiate_protocol") {
      transport.send({ type: "response", id: command.id, command: command.type, success: true, data: { protocolVersion: 2 } });
    }
  };
  const proc = startProcess(transport);
  const ready = await proc.waitReady();
  await proc.negotiateProtocol(ready);

  const frames = [];
  proc.onFrame((frame) => frames.push(frame));
  const expected = { type: "message_update", content: "x".repeat(1024 * 1024) };
  transport.sendFrames(encodeRpcFrames(expected, 2, "event-1"));
  assert.deepEqual(frames, [expected]);

  const pending = proc.sendCommand({ type: "never_returns" });
  transport.child.emit("exit", 7, null);
  await assert.rejects(pending, /omp exited/);
});

test("RpcProcess refuses an over-cap command without writing anything to stdin", async () => {
  // Image-attached prompts are one line; past the transport cap the write
  // must fail with an actionable error BEFORE touching the pipe — a partial
  // or over-long stdin line would leave the child without a parseable record.
  const transport = makeTransport();
  const proc = startProcess(transport);
  await proc.waitReady();
  const { MAX_IPC_FRAME_BYTES } = jiti("./rpc-frame.ts");
  const before = transport.commands.length;
  await assert.rejects(
    () => proc.sendCommand({ type: "prompt", message: "x".repeat(MAX_IPC_FRAME_BYTES) }),
    /too large for the OMP transport limit/,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transport.commands.length, before, "no frame may reach stdin");
  await proc.dispose(0);
});

/** Outbound v2 chunk records exactly as OMP emits them (via the real encoder). */
function chunkRecords(frame, chunkId) {
  return encodeRpcFrames(frame, 2, chunkId).map((line) => JSON.parse(line));
}

function makeInjectedTransport() {
  const listeners = { line: [], stderr: [], exit: [], resync: [] };
  const transport = {
    endInputCalls: 0,
    write(line, callback) {
      const command = JSON.parse(line);
      callback(null);
      queueMicrotask(() => {
        const data = command.type === "get_state" ? { isStreaming: false } : command.type === "negotiate_protocol" ? { protocolVersion: 2 } : undefined;
        const response = { type: "response", id: command.id, command: command.type, success: true, data };
        for (const listener of listeners.line) listener(JSON.stringify(response));
      });
    },
    onLine(listener) { listeners.line.push(listener); },
    onStderr(listener) { listeners.stderr.push(listener); },
    onExit(listener) { listeners.exit.push(listener); },
    onResync(listener) { listeners.resync.push(listener); },
    send(frame) { for (const listener of listeners.line) listener(JSON.stringify(frame)); },
    resync() { for (const listener of listeners.resync) listener(); },
    endInput() {
      transport.endInputCalls += 1;
      queueMicrotask(() => { for (const listener of listeners.exit) listener(0, null); });
    },
    killTree() {},
  };
  queueMicrotask(() => {
    for (const listener of listeners.line) listener(JSON.stringify({ type: "ready" }));
  });
  return transport;
}

test("RpcProcess runs over an injected transport", async () => {
  const transport = makeInjectedTransport();
  const proc = new RpcProcess({ cwd: process.cwd(), transport });
  await proc.waitReady();
  assert.deepEqual(await proc.sendCommand({ type: "get_state" }), { isStreaming: false });
  await proc.dispose(0);
  assert.equal(transport.endInputCalls, 1);
  assert.equal(proc.isAlive, false);
  assert.equal(proc.exitDetails?.code, 0);
});

test("a host resync mid chunk sequence drops the partial frame and skips the tail instead of killing omp", async () => {
  const big = (type, id) => ({ type, id, content: "x".repeat(1024 * 1024) });
  const transport = makeInjectedTransport();
  const proc = new RpcProcess({ cwd: process.cwd(), transport });
  await proc.waitReady();
  await proc.negotiateProtocol({ type: "ready", supportedProtocolVersions: [2] });
  const frames = [];
  proc.onFrame((frame) => frames.push(frame.id ?? frame.type));
  // The host dropped this channel's backlog after two chunks went up.
  const lost = chunkRecords(big("message_start", "lost"), "rpc-1");
  for (const record of lost.slice(0, 2)) transport.send(record);
  transport.resync();
  for (const record of lost.slice(3)) transport.send(record);
  for (const record of chunkRecords(big("message_end", "next"), "rpc-2")) transport.send(record);
  transport.send({ type: "agent_end" });
  assert.deepEqual(frames, ["next", "agent_end"]);
  assert.equal(transport.endInputCalls, 0, "no protocol error disposed the child");
  assert.equal(proc.isAlive, true);
  await proc.dispose(0);
});

/** A child that was already running: it sends no `ready`, and `held` lines reach the first reader at once, as RemoteRpcTransport delivers them. */
function makeAdoptedTransport(held) {
  const readers = [];
  const transport = {
    endInputCalls: 0,
    answer: () => {},
    write(line, callback) {
      callback(null);
      queueMicrotask(() => transport.answer(JSON.parse(line)));
    },
    onLine(listener) {
      readers.push(listener);
      for (const line of held) listener(line);
    },
    onStderr() {},
    onExit(listener) { transport.exit = listener; },
    endInput() {
      transport.endInputCalls += 1;
      queueMicrotask(() => transport.exit?.(0, null));
    },
    killTree() {},
    send(record) { for (const reader of readers) reader(JSON.stringify(record)); },
  };
  return transport;
}

test("an adopted RpcProcess needs no ready, skips a chunk tail, and holds live frames until the replay is released", async () => {
  const big = (type, id) => ({ type, id, content: "x".repeat(1024 * 1024) });
  // The web server restarted mid chunk sequence: its tail must not be a protocol error.
  const tail = chunkRecords(big("message_update", "lost"), "before-restart").slice(2);
  const transport = makeAdoptedTransport([...tail, { type: "agent_start" }].map((record) => JSON.stringify(record)));
  const proc = new RpcProcess({ cwd: process.cwd(), transport, adopted: { protocolVersion: 2 } });
  transport.answer = (command) => transport.send({ type: "response", id: command.id, command: command.type, success: true, data: { protocolVersion: 2 } });
  assert.equal(await proc.negotiateProtocol(await proc.waitReady(1), 1_000), 2);

  const frames = [];
  proc.onFrame((frame) => frames.push(frame.id ?? frame.type));
  const live = chunkRecords(big("message_update", "live"), "live");
  for (const record of live.slice(0, 2)) transport.send(record);
  assert.deepEqual(frames, [], "live frames wait for the replay");

  // The daemon's lines are older than anything live, and a half-read live sequence does not disturb them.
  proc.replay([
    JSON.stringify({ type: "extension_ui_request", id: "q1", method: "ask" }),
    ...chunkRecords(big("host_tool_call", "h1"), "pending").map((record) => JSON.stringify(record)),
  ]);
  assert.deepEqual(frames, ["q1", "h1"], "the replay is delivered at once; live frames are still held");
  proc.release();
  assert.deepEqual(frames, ["q1", "h1", "agent_start"]);
  for (const record of live.slice(2)) transport.send(record);
  assert.deepEqual(frames, ["q1", "h1", "agent_start", "live"]);
  assert.equal(transport.endInputCalls, 0, "no protocol error disposed the child");
  assert.equal(proc.isAlive, true);
  await proc.dispose(0);
});

test("an adopted RpcProcess delivers a request both replayed and held once", async () => {
  const requests = [
    { type: "extension_ui_request", id: "q1", method: "ask" },
    { type: "host_tool_call", id: "h1", toolName: "send_to_session" },
    { type: "host_uri_request", id: "u1", url: "x:1" },
  ];
  // Opened while the old server stopped: the daemon resends each unacked and lists it in its hello.
  const transport = makeAdoptedTransport([...requests, { type: "host_tool_call", id: "h2" }].map((record) => JSON.stringify(record)));
  const proc = new RpcProcess({ cwd: process.cwd(), transport, adopted: { protocolVersion: 2 } });
  const frames = [];
  proc.onFrame((frame) => frames.push(frame.id));
  proc.replay(requests.map((record) => JSON.stringify(record)));
  proc.release();
  assert.deepEqual(frames, ["q1", "h1", "u1", "h2"]);
  await proc.dispose(0);
});

test("a response naming another command does not settle a command with its id", async () => {
  const transport = makeAdoptedTransport([]);
  const proc = new RpcProcess({ cwd: process.cwd(), transport, adopted: { protocolVersion: 2 } });
  proc.release();
  const unsolicited = [];
  proc.onFrame((frame) => unsolicited.push(frame.command));
  transport.answer = (command) => {
    // A late answer naming another command, with this command's id, arrives first.
    transport.send({ type: "response", id: command.id, command: "prompt", success: false, error: "stale" });
    transport.send({ type: "response", id: command.id, command: command.type, success: true, data: { sessionId: "s" } });
  };
  assert.deepEqual(await proc.sendCommand({ type: "get_state" }, 1_000), { sessionId: "s" });
  assert.deepEqual(unsolicited, ["prompt"]);
  await proc.dispose(0);
});

test("a late answer to the previous server's command of the same type does not settle an adopted process's command", async () => {
  // The previous server's process sent get_state and stopped before the child answered.
  const before = makeAdoptedTransport([]);
  const previous = new RpcProcess({ cwd: process.cwd(), transport: before, adopted: { protocolVersion: 2 } });
  previous.release();
  let staleId;
  before.answer = (command) => { staleId = command.id; };
  void previous.sendCommand({ type: "get_state" }).catch(() => {});
  await previous.dispose(0);
  assert.ok(staleId, "the previous process sent its get_state");

  const transport = makeAdoptedTransport([]);
  const proc = new RpcProcess({ cwd: process.cwd(), transport, adopted: { protocolVersion: 2 } });
  proc.release();
  transport.answer = (command) => {
    assert.notEqual(command.id, staleId);
    transport.send({ type: "response", id: staleId, command: "get_state", success: true, data: { sessionId: "stale" } });
    transport.send({ type: "response", id: command.id, command: command.type, success: true, data: { sessionId: "s" } });
  };
  assert.deepEqual(await proc.sendCommand({ type: "get_state" }, 1_000), { sessionId: "s" });
  await proc.dispose(0);
});

test("an adopted RpcProcess whose output outgrows the hold cap fails its commands and its replay", async () => {
  const { LINK_LIMITS } = jiti("../hosts/link-protocol.ts");
  const saved = LINK_LIMITS.channelBufferBytes;
  LINK_LIMITS.channelBufferBytes = 1_000;
  try {
    const transport = makeAdoptedTransport([]);
    const proc = new RpcProcess({ cwd: process.cwd(), transport, adopted: { protocolVersion: 2 } });
    const frames = [];
    proc.onFrame((frame) => frames.push(frame));
    // The child holds this answer back while its output piles up.
    const pending = proc.sendCommand({ type: "get_state" });
    transport.send({ type: "message_update", text: "x".repeat(2_000) });
    await assert.rejects(pending, /exceeded 1000 bytes/);
    await assert.rejects(proc.sendCommand({ type: "get_state" }), /exceeded 1000 bytes/);
    assert.throws(() => proc.replay([]), /exceeded 1000 bytes/);
    assert.throws(() => proc.release(), /exceeded 1000 bytes/);
    assert.deepEqual(frames, [], "nothing held reaches the session");
    await proc.dispose(0);
  } finally {
    LINK_LIMITS.channelBufferBytes = saved;
  }
});
