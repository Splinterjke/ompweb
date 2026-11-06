import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mock } from "bun:test";
import childProcess from "node:child_process";
import { mockBuiltin } from "../tests/mock-builtin.mjs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
let isolatedFresh = 0;

// rpc-manager.ts drives the user's `omp` binary over NDJSON (lib/omp/rpc-process)
// instead of embedding a Bun-only SDK. Most coverage is source-contract; the
// disconnect-reaper tests below load the real wrapper through jiti.

// Wrappers publish notifications, which the notification store records: never in the real agent dir.
const notificationsTestDir = mkdtempSync(join(tmpdir(), "omp-rpc-manager-test-"));
process.env.PI_CODING_AGENT_DIR = notificationsTestDir;
const { closeNotificationStore } = await import("./notification-store.ts");
const { closeOutboxStore } = await import("./message-outbox.ts");
test.after(async () => {
  // The hub's held link samples go to this file's agent dir, before it is gone.
  (await import("./hosts/hub.ts")).flushLinkSamples();
  closeNotificationStore();
  closeOutboxStore();
  rmSync(notificationsTestDir, { recursive: true, force: true });
});

// The mid-run (TUI-parity) titling generator is mocked module-wide before the
// wrapper loads: its semantics are covered by lib/omp/title-generator.test.mjs
// and the fake-gateway suite; the wrapper tests below drive the fake gateway's
// answer through this holder. The default gates every opener as low-signal,
// so pre-existing tests only ever see the settle path.
const earlyTitle = {
  isLowSignal: true,
  isWeakPointer: false,
  result: null,
  gate: null,
  calls: [],
  chainOpts: null,
};
mock.module("./omp/title-generator.ts", () => ({
  isLowSignalOpener: () => earlyTitle.isLowSignal,
  isWeakPointerOpener: () => earlyTitle.isWeakPointer,
  buildTitleModelChain: (opts) => {
    earlyTitle.chainOpts = opts;
    return ["@mocked-chain"];
  },
  generateOpenerTitle: async (request) => {
    if (earlyTitle.gate) await earlyTitle.gate;
    earlyTitle.calls.push(request);
    return earlyTitle.result;
  },
  TITLE_ROLE_SELECTORS: ["@tiny", "@commit", "@smol"],
}));

const { AgentSessionWrapper: SnapshotWrapper, subscribeHostToolCalls } = await import("./rpc-manager.ts");
// Wrappers built directly need an online host; the daemon's machine host is one.
const { localHost } = await import("./hosts/local-host.ts");

// Process-boundary fakes exercise the real wrapper without invoking the user's
// installed agent.
function snapshotSession(t, sendCommand = async () => ({}), Wrapper = SnapshotWrapper, sessionId = "", disconnectDestroyMs, host = localHost) {
  const frameListeners = new Set();
  const sentFrames = [];
  const wrapper = new Wrapper({
    isAlive: true,
    onFrame(listener) { frameListeners.add(listener); return () => frameListeners.delete(listener); },
    // As RpcProcess: onReply runs when the reply is read, told whether the command succeeded.
    async sendCommand(command, timeoutMs, onReply) {
      let result;
      try {
        result = await sendCommand(command, timeoutMs);
      } catch (error) {
        onReply?.(false);
        throw error;
      }
      onReply?.(true);
      return result;
    },
    sendFrame(frame) { sentFrames.push(frame); },
    dispose: async () => {},
  }, process.cwd(), null, false, sessionId, disconnectDestroyMs, host);
  wrapper.start();
  t.after(() => wrapper.destroyAndWait());
  return { wrapper, sentFrames, get listenerCount() { return frameListeners.size; }, emit: (event) => { for (const listener of frameListeners) listener(event); } };
}

test("rpc-manager spawns omp via RpcProcess and has no SDK imports", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

  assert.match(source, /from "\.\/omp\/rpc-process"/);
  assert.doesNotMatch(source, /@earendil-works/);
  assert.doesNotMatch(source, /@oh-my-pi/);
});

test("session startup negotiates RPC v2 when the installed OMP advertises it", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(source, /await this\.proc\.negotiateProtocol\(ready\)/);
  assert.match(source, /await proc\.negotiateProtocol\(ready\)/);
});

test("registered host tools route to listeners; unknown ones are rejected", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  // Registered host tools (set_host_tools) are forwarded to attached UI
  // listeners, which answer with host_tool_result.
  assert.match(source, /case "host_tool_call":/);
  assert.match(source, /this\.hostToolNames\.has\(toolName\)/);
  assert.match(source, /case "set_host_tools":/);
  assert.match(source, /case "host_tool_result":/);
  // Unregistered tools / no attached listener are settled with an error so
  // the agent turn cannot hang waiting for a response.
  assert.match(source, /type: "host_tool_result"/);
  assert.match(source, /isError: true/);
  // A disconnected UI rejects outstanding host tool calls.
  assert.match(source, /rejectPendingHostTools\(/);
  assert.match(source, /hasBrowserSubscribers\(\)/);
});

test("registered host URI schemes route to listeners; unknown schemes are rejected", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  // Registered schemes (set_host_uri_schemes) forward host_uri_request frames
  // to attached UI listeners, which answer with host_uri_result.
  assert.match(source, /case "set_host_uri_schemes":/);
  assert.match(source, /case "host_uri_request":/);
  assert.match(source, /case "host_uri_result":/);
  assert.match(source, /this\.hostUriSchemes\.get\(scheme\)/);
  assert.match(source, /registered\.writable/);
  // Unknown schemes / no listener get an error result so read/write never hangs.
  assert.match(source, /isError: true,\s*\n\s*error: `URI scheme/);
  // A disconnected UI rejects outstanding URI requests too.
  assert.match(source, /rejectPendingHostUris\(/);
});

test("host tools for a session no tab watches go to other open tabs, then settle when they leave", async (t) => {
  const { wrapper, emit, sentFrames } = snapshotSession(t, undefined, SnapshotWrapper, "cross-session");
  globalThis.__ompSessions ??= new Map();
  globalThis.__ompSessions.set("cross-session", wrapper);
  t.after(() => globalThis.__ompSessions.delete("cross-session"));
  await wrapper.send({ type: "set_host_tools", tools: [{ name: "open_url" }] });

  // No tab anywhere: rejected immediately so the agent cannot hang.
  emit({ type: "host_tool_call", id: "alone", toolName: "open_url", arguments: { url: "https://a.test" } });
  assert.deepEqual(sentFrames.map((f) => [f.id, f.isError]), [["alone", true]]);

  // Another tab is open: it receives the call with the owning session id.
  const calls = [];
  const leave = subscribeHostToolCalls((call) => calls.push(call));
  t.after(leave);
  emit({ type: "host_tool_call", id: "routed", toolName: "open_url", arguments: { url: "https://b.test" } });
  assert.deepEqual(calls, [{ sessionId: "cross-session", hostId: "local", cwd: process.cwd(), id: "routed", toolName: "open_url", arguments: { url: "https://b.test" } }]);
  assert.equal(sentFrames.length, 1);

  // A tab watching the session itself takes precedence over other tabs.
  const own = [];
  const detach = wrapper.onEvent((event) => own.push(event));
  emit({ type: "host_tool_call", id: "own", toolName: "open_url", arguments: {} });
  assert.equal(own.at(-1).id, "own");
  assert.equal(calls.length, 1);

  // That tab leaving settles only its own call; the other tabs still own "routed".
  detach();
  assert.deepEqual(sentFrames.map((f) => [f.id, f.isError]), [["alone", true], ["own", true]]);

  // The last other tab leaving settles the call routed to it.
  leave();
  assert.deepEqual(sentFrames.map((f) => [f.id, f.isError]), [["alone", true], ["own", true], ["routed", true]]);
});

test("internal observers cannot receive browser URI requests or keep departed browser calls pending", async (t) => {
  const { wrapper, emit, sentFrames } = snapshotSession(t);
  await wrapper.send({ type: "set_host_tools", tools: [{ name: "open_url" }] });
  await wrapper.send({ type: "set_host_uri_schemes", schemes: [{ scheme: "browser", writable: true }] });
  const observed = [];
  const stopObserver = wrapper.onEvent((event) => observed.push(event), { internal: true });
  t.after(stopObserver);
  emit({ type: "host_uri_request", id: "no-browser", url: "browser:clipboard", operation: "read" });
  assert.deepEqual(sentFrames.map((frame) => [frame.type, frame.id, frame.isError]), [["host_uri_result", "no-browser", true]]);
  assert.equal(observed.some((event) => event.type === "host_uri_request"), false);

  const browserEvents = [];
  const detachBrowser = wrapper.onEvent((event) => browserEvents.push(event));
  emit({ type: "host_tool_call", id: "own-tool", toolName: "open_url", arguments: {} });
  emit({ type: "host_uri_request", id: "own-uri", url: "browser:clipboard", operation: "read" });
  assert.deepEqual(browserEvents.map((event) => [event.type, event.id]), [["host_tool_call", "own-tool"], ["host_uri_request", "own-uri"]]);
  detachBrowser();
  assert.deepEqual(sentFrames.map((frame) => [frame.type, frame.id, frame.isError]), [
    ["host_uri_result", "no-browser", true],
    ["host_tool_result", "own-tool", true],
    ["host_uri_result", "own-uri", true],
  ], "the last browser leaving rejects its own calls even while the internal observer remains");
  stopObserver();
  assert.equal(sentFrames.length, 3, "internal observer departure cannot answer or reject calls again");
});

test("cross-session tool cancellation retains the source alias and isolates identical request ids", async (t) => {
  let state = { sessionId: "cancel-source", sessionFile: "/s/cancel-source.jsonl", isStreaming: false };
  const first = snapshotSession(t, async () => ({ ...state }), SnapshotWrapper, "cancel-source");
  const second = snapshotSession(t, undefined, SnapshotWrapper, "other-source");
  await first.wrapper.send({ type: "get_state" });
  for (const session of [first, second]) {
    await session.wrapper.send({ type: "set_host_tools", tools: [{ name: "open_file" }] });
  }
  const events = [];
  const leave = subscribeHostToolCalls(event => events.push(event));
  t.after(leave);
  const call = { type: "host_tool_call", id: "same-id", toolName: "open_file", arguments: { path: "local://note.md" } };
  first.emit({ ...call, webCrossSession: true, webSourceSessionId: "spoofed" });
  second.emit(call);
  state = { sessionId: "cancel-moved", sessionFile: "/s/cancel-moved.jsonl", isStreaming: false };
  first.emit({ type: "notice", level: "warning", source: "session-persistence", message: "moved" });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(first.wrapper.sessionId, "cancel-moved");
  first.emit({ type: "host_tool_cancel", targetId: "same-id" });
  assert.deepEqual(events.filter(event => event.type === "host_tool_cancel"), [
    { type: "host_tool_cancel", sessionId: "cancel-source", targetId: "same-id" },
  ]);
  assert.equal(first.sentFrames.length, 0, "native cancellation needs no browser response");
  assert.equal(second.wrapper.isRunning(), true, "the other child still owns its request");
  await second.wrapper.destroyAndWait();
  assert.deepEqual(events.at(-1), { type: "host_tool_cancel", sessionId: "other-source", targetId: "same-id" });
});

// Process-boundary fixtures exercise the real wrapper without invoking the user's installed agent.
test("host tool and URI replies go out as fire-and-forget frames with the original id", async () => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { AgentSessionWrapper } = jiti("./rpc-manager.ts");

  const frames = [];
  let sendCommandCalls = 0;
  const fakeProc = {
    isAlive: true,
    onFrame: () => () => {},
    sendCommand: async () => {
      sendCommandCalls += 1;
      throw new Error("host replies must be forwarded as frames, not awaited commands");
    },
    sendFrame: (frame) => frames.push(frame),
    dispose: async () => {},
  };

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();

  await wrapper.send({
    type: "host_tool_result",
    id: "tool-42",
    result: { content: [{ type: "text", text: "opened" }] },
  });
  await wrapper.send({
    type: "host_uri_result",
    id: "uri-42",
    result: { content: [{ type: "text", text: "clipboard" }] },
  });

  // The frames must keep the correlation ids the agent sent in
  // host_tool_call / host_uri_request — routing them through sendCommand
  // would replace the id with a fresh request id and the agent's pending
  // call could never be matched.
  assert.equal(sendCommandCalls, 0);
  assert.deepEqual(frames, [
    { type: "host_tool_result", id: "tool-42", result: { content: [{ type: "text", text: "opened" }] } },
    { type: "host_uri_result", id: "uri-42", result: { content: [{ type: "text", text: "clipboard" }] } },
  ]);
  // Release the idle-destroy timer so the test process can exit.
  await wrapper.destroyAndWait();
});








test("prompt completion is driven by agent_end / prompt_result, not prompt_done", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

  assert.match(source, /case "prompt_result":/);
  assert.match(source, /isTerminal !== false/);
  assert.doesNotMatch(source, /"prompt_done"/);
});

test("prompt acknowledgement and authoritative state reads are bounded and recoverable", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(source, /const GET_STATE_TIMEOUT_MS = 5_000/);
  assert.match(source, /const PROMPT_ACK_TIMEOUT_MS = 30_000/);
  assert.match(source, /PROMPT_ACK_TIMEOUT_MS\)/);
  assert.match(source, /getStateWithTimeout/);
  assert.match(source, /session_unresponsive/);
  assert.match(source, /promptDispatchPendingCount/);
  assert.match(source, /awaitingAgentStart/);
});

test("agent startup broadcasts a session-list refresh without waiting for a reply", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const agentStart = source.slice(source.indexOf('case "agent_start":'), source.indexOf('case "agent_end":'));

  assert.match(agentStart, /this\.invalidateSessionLists\(\)/);
  assert.match(agentStart, /refreshSessionList = true/);
  assert.match(source, /private invalidateSessionLists\(\)/);
  assert.match(source, /this\.host\.invalidateSessionLists\(this\._sessionFile \|\| undefined\)/);
  assert.match(source, /notifyRunningChange\(\{ refreshSessionList \}\)/);
  assert.match(source, /snapshot === lastRunningSnapshot && !refreshSessionList/);
});





test("a prompt or steer during a `!` shell command degrades into the follow-up queue", async (t) => {
  const commands = [];
  let releaseBash;
  const bashGate = new Promise((resolve) => { releaseBash = resolve; });
  const { wrapper } = snapshotSession(t, async (command) => {
    commands.push(command);
    if (command.type === "bash") await bashGate;
    return {};
  });

  const bash = wrapper.send({ type: "bash", command: "npm run build" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(commands.map((command) => command.type), ["bash"]);
  assert.equal(wrapper.isRunning(), true, "the shell command owns the session");

  // Neither frame may reject or abort the shell command: both join omp's own
  // follow-up queue and the reply says where the message went.
  const queuedReply = { queued: true, queue: "followUp", reason: "shellRunning" };
  const image = { type: "image", data: "QUJD", mimeType: "image/png" };
  assert.deepEqual(await wrapper.send({ type: "prompt", message: "run the tests after" }), queuedReply);
  assert.deepEqual(await wrapper.send({ type: "prompt", message: "steer me", streamingBehavior: "steer" }), queuedReply);
  assert.deepEqual(await wrapper.send({ type: "steer", message: "and this", images: [image] }), queuedReply);
  assert.deepEqual(commands.map((command) => command.type), ["bash", "follow_up", "follow_up", "follow_up"]);
  assert.deepEqual(
    commands.slice(1).map(({ type, message, images }) => ({ type, message, images })),
    [
      { type: "follow_up", message: "run the tests after", images: undefined },
      { type: "follow_up", message: "steer me", images: undefined },
      { type: "follow_up", message: "and this", images: [image] },
    ],
  );

  // An invalid attachment still fails before anything reaches omp.
  await assert.rejects(
    wrapper.send({ type: "prompt", message: "bad image", images: [{ type: "text", text: "nope" }] }),
    /Each attachment must be an image/,
  );
  assert.equal(commands.length, 4);
  // Degrading is not a run: nothing was marked as a prompt in flight.
  assert.equal((await wrapper.send({ type: "get_state" })).isPromptRunning, false);

  releaseBash();
  await bash;
  assert.equal(wrapper.isRunning(), false, "the shell command released the session");

  // Back to normal once the shell command is done.
  await wrapper.send({ type: "prompt", message: "now really" });
  assert.equal(commands.at(-1).type, "prompt");
});

test("a `!` shell command runs beside a running turn, which keeps its steers and queued prompts", async (t) => {
  const commands = [];
  let releaseBash;
  const bashGate = new Promise((resolve) => { releaseBash = resolve; });
  const { wrapper, emit } = snapshotSession(t, async (command) => {
    commands.push(command);
    if (command.type === "bash") await bashGate;
    return command.type === "bash" ? { output: "ok", exitCode: 0, cancelled: false, truncated: false } : {};
  });
  emit({ type: "agent_start" });

  // omp's terminal runs `!cmd` mid-turn and records it when the next prompt starts.
  const bash = wrapper.send({ type: "bash", command: "git status" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(commands.map((command) => command.type), ["bash"]);
  await assert.rejects(wrapper.send({ type: "bash", command: "ls" }), /already running/);

  // The turn is live, so a steer still steers it and a queued prompt keeps its behavior.
  assert.equal(await wrapper.send({ type: "steer", message: "look here" }), null);
  const queued = await wrapper.send({ type: "prompt", message: "then this", streamingBehavior: "followUp" });
  assert.notEqual(queued?.reason, "shellRunning");
  assert.deepEqual(commands.map((command) => command.type), ["bash", "steer", "prompt"]);

  releaseBash();
  assert.equal((await bash).deferred, true, "omp held the result back for the next prompt");

  emit({ type: "agent_end", isTerminal: true });
  assert.equal((await wrapper.send({ type: "bash", command: "pwd" })).deferred, false, "idle: omp recorded it at once");
});



test("compaction fires context_compacted, never conversation_completed", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

  // Auto-compact frame: dispatches context_compacted and nothing else.
  const autoEnd = source.slice(source.indexOf('case "auto_compaction_end":'), source.indexOf('case "session_info_update":'));
  assert.match(autoEnd, /dispatchChatEvent\("context_compacted"/);
  assert.doesNotMatch(autoEnd, /dispatchChatEvent\("conversation_completed"/);

  // Manual compact command: dispatches context_compacted only on the
  // success path (after sendCommand resolves).
  const compact = source.slice(source.indexOf('case "compact":'), source.indexOf('case "abort_compaction":'));
  assert.match(compact, /dispatchChatEvent\("context_compacted"/);

  // conversation_completed fires from the prompt_result / session_settled
  // resolution, never from the compaction frames (behavioral coverage:
  // "conversation_completed waits for session_settled…" and the
  // interrupted-turn test below).
  const promptResult = source.slice(source.indexOf('case "prompt_result":'), source.indexOf('case "session_settled":'));
  assert.match(promptResult, /dispatchChatEvent\("conversation_completed"/);
});
test("interrupted turn's terminal agent_end does not dispatch conversation_completed", async () => {
  const { createJiti } = await import("jiti");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  // Redirect the chat-action store to a temp dir so the test observes its
  // own dispatches (the notification executor records lastRun on every run).
  const agentDir = mkdtempSync(join(tmpdir(), "ompweb-chat-actions-"));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    const jiti = createJiti(import.meta.url);
    const { AgentSessionWrapper } = jiti("./rpc-manager.ts");
    const store = jiti("./chat-event-action-store.ts");

    const { action } = store.createChatEventAction({
      name: "completion-test",
      events: ["conversation_completed"],
      action: { type: "notification" },
    });
    store.saveChatEventActionFile({ version: 1, actions: [action] });
    const lastRun = () => store.getChatEventAction(action.id)?.lastRun?.at ?? null;

    let frameListener = null;
    const fakeProc = {
      isAlive: true,
      onFrame(listener) {
        frameListener = listener;
        return () => { frameListener = null; };
      },
      sendCommand: async (command) => {
        if (command.type === "prompt") return { agentInvoked: true };
        if (command.type === "get_state") {
          return {
            sessionId: "test-session-1",
            sessionFile: "/tmp/session.jsonl",
            isStreaming: false,
            isCompacting: false,
          };
        }
        return {};
      },
      sendFrame: () => {},
      dispose: async () => {},
    };

    const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
    wrapper.start();

    // 1) Interrupted turn: prompt -> start -> abort -> terminal agent_end.
    //    The interrupted end must NOT dispatch conversation_completed.
    await wrapper.send({ type: "prompt", message: "Hello" });
    frameListener({ type: "agent_start" });
    await wrapper.send({ type: "abort" });
    frameListener({ type: "agent_end", isTerminal: true });
    frameListener({ type: "prompt_result", agentInvoked: true, status: "aborted", sessionSettled: true });
    await sleep(300);
    assert.equal(lastRun(), null, "interrupted turn must not dispatch conversation_completed");

    // 2) The next genuine run still dispatches conversation_completed (the
    //    pending-interrupt flag was consumed by the interrupted turn's end).
    await wrapper.send({ type: "prompt", message: "Again" });
    frameListener({ type: "agent_start" });
    await sleep(50);
    frameListener({ type: "agent_end", isTerminal: true });
    frameListener({ type: "prompt_result", agentInvoked: true, status: "completed", sessionSettled: true });
    const first = lastRun();
    assert.ok(first, "genuine completion must dispatch conversation_completed");

    // 3) A no-op abort (nothing running) must not swallow the next
    //    completion: agent_start clears the stale pending-interrupt flag.
    await wrapper.send({ type: "abort" });
    await wrapper.send({ type: "prompt", message: "Third" });
    frameListener({ type: "agent_start" });
    await sleep(50);
    frameListener({ type: "agent_end", isTerminal: true });
    frameListener({ type: "prompt_result", agentInvoked: true, status: "completed", sessionSettled: true });
    const third = lastRun();
    assert.ok(third > first, "no-op abort must not suppress the next completion");

    // 4) Background-job resume: the turn pauses with a non-terminal
    //    agent_end while the job runs; when the job finishes omp resumes
    //    the turn (agent_start again) and its terminal agent_end must not
    //    dispatch conversation_completed (it closes the job, not the
    //    conversation).
    await wrapper.send({ type: "prompt", message: "Fourth" });
    frameListener({ type: "agent_start" });
    frameListener({ type: "agent_end", isTerminal: false });
    frameListener({ type: "agent_start" });
    await sleep(50);
    frameListener({ type: "agent_end", isTerminal: true });
    frameListener({ type: "prompt_result", agentInvoked: true, status: "completed", sessionSettled: true });
    assert.equal(lastRun(), third, "background-job resume turn must not dispatch conversation_completed");

    // 5) A subsequent user-prompted turn still dispatches (the flag was
    //    consumed by the resume turn's end).
    await wrapper.send({ type: "prompt", message: "Fifth" });
    frameListener({ type: "agent_start" });
    await sleep(50);
    frameListener({ type: "agent_end", isTerminal: true });
    frameListener({ type: "prompt_result", agentInvoked: true, status: "completed", sessionSettled: true });
    assert.ok(lastRun() > first, "normal turn after a bg-job resume must dispatch conversation_completed");

    await wrapper.destroyAndWait();
  } finally {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  }
});

test("goal pause/drop aborts an in-flight goal-driven turn but never a host-prompt run", async () => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { AgentSessionWrapper } = jiti("./rpc-manager.ts");

  const sent = [];
  let frameListener = null;
  const fakeProc = {
    isAlive: true,
    onFrame(listener) {
      frameListener = listener;
      return () => { frameListener = null; };
    },
    sendCommand: async (command) => {
      sent.push(`${command.type}${command.op ? ":" + command.op : ""}`);
      if (command.type === "prompt") return { agentInvoked: true };
      if (command.type === "goal") {
        if (command.op === "create" || command.op === "resume") return { goal: { id: "g1", status: "active", objective: "x" } };
        if (command.op === "pause") return { goal: { id: "g1", status: "paused" } };
        return { goal: null };
      }
      return {};
    },
    sendFrame: () => {},
    dispose: async () => {},
  };
  const abortCount = () => sent.filter((t) => t === "abort").length;

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();

  // 1) Active goal driving a child-initiated wake: pause must abort that run.
  await wrapper.send({ type: "goal", op: "create", objective: "x" });
  frameListener({ type: "agent_start" });
  await wrapper.send({ type: "goal", op: "pause" });
  assert.equal(abortCount(), 1, "pause during a goal wake must abort the run");
  frameListener({ type: "agent_end", isTerminal: true });

  // 2) Goal still known-active but nothing running: pause must not abort.
  frameListener({ type: "goal_updated", goal: { id: "g1", status: "active" } });
  await wrapper.send({ type: "goal", op: "pause" });
  assert.equal(abortCount(), 1, "pause with no active run must not abort");

  // 3) The user's own prompt run must survive a goal pause.
  frameListener({ type: "goal_updated", goal: { id: "g1", status: "active" } });
  await wrapper.send({ type: "prompt", message: "mine" });
  frameListener({ type: "agent_start" });
  await wrapper.send({ type: "goal", op: "pause" });
  assert.equal(abortCount(), 1, "pause must never interrupt a host-prompted run");
  frameListener({ type: "agent_end", isTerminal: true });

  // 4) Drop during a goal wake aborts too; the client-facing reply stays intact.
  frameListener({ type: "goal_updated", goal: { id: "g1", status: "active" } });
  frameListener({ type: "agent_start" });
  const dropReply = await wrapper.send({ type: "goal", op: "drop" });
  assert.equal(abortCount(), 2, "drop during a goal wake must abort the run");
  assert.deepEqual(dropReply, { goal: null });
  frameListener({ type: "agent_end", isTerminal: true });

  // 5) No goal status known (older omp never reported one): pause is a plain relay.
  const wrapper2 = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper2.start();
  frameListener({ type: "agent_start" });
  await wrapper2.send({ type: "goal", op: "pause" });
  assert.equal(abortCount(), 2, "pause without a known active goal must not abort");

  await wrapper.destroyAndWait();
  await wrapper2.destroyAndWait();
});

test("conversation_completed waits for session_settled when the prompt did not settle", async () => {
  const { createJiti } = await import("jiti");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const agentDir = mkdtempSync(join(tmpdir(), "ompweb-chat-settle-"));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    const jiti = createJiti(import.meta.url);
    const { AgentSessionWrapper } = jiti("./rpc-manager.ts");
    const store = jiti("./chat-event-action-store.ts");

    const { action } = store.createChatEventAction({
      name: "settle-test",
      events: ["conversation_completed"],
      action: { type: "notification" },
    });
    store.saveChatEventActionFile({ version: 1, actions: [action] });
    const lastRun = () => store.getChatEventAction(action.id)?.lastRun?.at ?? null;

    let frameListener = null;
    const fakeProc = {
      isAlive: true,
      onFrame(listener) {
        frameListener = listener;
        return () => { frameListener = null; };
      },
      sendCommand: async (command) => (command.type === "prompt" ? { agentInvoked: true } : {}),
      sendFrame: () => {},
      dispose: async () => {},
    };

    const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
    wrapper.start();

    // 1) Unsettled run: background work (async subagent, job, delivery) can
    //    still wake the session, so the completion must NOT fire at the end.
    await wrapper.send({ type: "prompt", message: "Background" });
    frameListener({ type: "agent_start" });
    frameListener({ type: "agent_end", isTerminal: true });
    frameListener({ type: "prompt_result", agentInvoked: true, status: "completed", sessionSettled: false });
    await sleep(100);
    assert.equal(lastRun(), null, "unsettled completion must wait for session_settled");

    // 2) The settle frame releases the held completion exactly once.
    frameListener({ type: "session_settled" });
    await sleep(100);
    const settled = lastRun();
    assert.ok(settled, "session_settled must dispatch the deferred conversation_completed");
    frameListener({ type: "session_settled" });
    await sleep(50);
    assert.equal(lastRun(), settled, "a repeated settle must not re-dispatch");

    // 3) A settled run completes at its prompt_result, no settle frame needed.
    await wrapper.send({ type: "prompt", message: "Plain" });
    frameListener({ type: "agent_start" });
    frameListener({ type: "agent_end", isTerminal: true });
    frameListener({ type: "prompt_result", agentInvoked: true, status: "completed", sessionSettled: true });
    await sleep(50);
    assert.ok(lastRun() > settled, "settled completion fires without a settle frame");

    // 4) A held completion is never lost: if session_settled never arrives,
    //    the next run's agent_start flushes it.
    await wrapper.send({ type: "prompt", message: "Stuck" });
    frameListener({ type: "agent_start" });
    frameListener({ type: "agent_end", isTerminal: true });
    frameListener({ type: "prompt_result", agentInvoked: true, status: "completed", sessionSettled: false });
    await sleep(50);
    const beforeFlush = lastRun();
    await wrapper.send({ type: "prompt", message: "Next" });
    frameListener({ type: "agent_start" });
    await sleep(50);
    assert.ok(lastRun() > beforeFlush, "agent_start must flush a completion whose settle never arrived");

    await wrapper.destroyAndWait();
  } finally {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  }
});

test("ask tool fires question_asked with the question text", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

  // The start frame is the only tool frame carrying the call arguments, so
  // question_asked is bound to tool_execution_start for the `ask` tool and
  // reads the question from args (joined across multiple questions).
  const start = source.slice(source.indexOf('case "tool_execution_start":'), source.indexOf('case "extension_ui_request":'));
  assert.match(start, /toolName === "ask"/);
  assert.match(start, /dispatchChatEvent\("question_asked"/);
  assert.match(start, /chatEventPayload\(/);
  assert.match(start, /question \|\| undefined/);
  assert.match(start, /args\.questions/);
});

test("timed-out extension dialogs are not replayed on reconnect", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const onEvent = source.slice(source.indexOf("onEvent(listener: EventListener,"), source.indexOf("onDestroy(cb:"));

  assert.match(onEvent, /expiresAt !== undefined && expiresAt <= now/);
  assert.match(onEvent, /this\.forgetPendingUiRequest\(id\)/);
  // The expiry also fires on its own so a long-lived session stops holding it.
  assert.match(source, /setTimeout\(\(\) => this\.forgetPendingUiRequest\(id\), timeout\)/);
});

test("restart rejects concurrent commands and disposes a failed replacement", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const restart = source.slice(source.indexOf("private async restart(requireIdle"), source.indexOf("async send(command"));

  assert.match(restart, /if \(this\.restarting\) throw new WebRpcError\(RESTARTING_MESSAGE, "session_restarting"\)/);
  assert.match(restart, /void proc\.dispose\(\)/);
  // send() must refuse while the child is being swapped out.
  const send = source.slice(source.indexOf("async send(command"), source.indexOf('case "prompt": {'));
  assert.match(send, /if \(this\.restarting\) throw new WebRpcError\(RESTARTING_MESSAGE, "session_restarting"\)/);
});

test("restart restores the subagent event subscription before reading replacement state", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const restart = source.slice(source.indexOf("private async restart(requireIdle"), source.indexOf("async send(command"));
  const subscription = restart.indexOf('type: "set_subagent_subscription", level: "events"');
  const state = restart.indexOf('type: "get_state"');

  assert.ok(subscription >= 0, "restart must restore subagent subscription");
  assert.ok(state >= 0, "restart must read replacement state");
  assert.ok(subscription < state, "subscription must be restored before replacement state is read");
});

test("resolveSpawnCwd uses the recorded directory when it exists, falls back otherwise", async () => {
  const { resolveSpawnCwd, resolveSpawnCwdResult } = await import("./hosts/local-host.ts");
  const { existsSync } = await import("node:fs");

  // A live recorded cwd is used verbatim — no fallback.
  const live = process.cwd();
  assert.equal(resolveSpawnCwd(live), live);
  assert.deepEqual(resolveSpawnCwdResult(live), { cwd: live, fellBack: false });

  // A missing recorded cwd falls back to a live directory and reports it.
  const missing = "/nonexistent/path/that/should/not/exist";
  const result = resolveSpawnCwdResult(missing);
  assert.equal(result.fellBack, true);
  assert.ok(existsSync(result.cwd), "fallback cwd must exist on disk");

  // The second-tier fallback is process.cwd() (which exists in normal environments);
  // resolveSpawnCwd (string return) matches the result's cwd.
  assert.equal(result.cwd, process.cwd());
  assert.equal(resolveSpawnCwd(missing), process.cwd());

  // undefined/empty also falls back.
  assert.equal(resolveSpawnCwdResult(undefined).fellBack, true);
  assert.equal(resolveSpawnCwd(undefined), process.cwd());

  // A recorded path that is a file, not a directory, cannot be a cwd either.
  const file = new URL(import.meta.url).pathname;
  assert.deepEqual(resolveSpawnCwdResult(file), { cwd: process.cwd(), fellBack: true });
});

test("missing terminal agent_end clears isPromptRunning on raw idle get_state", async () => {
  const { AgentSessionWrapper } = await import("./rpc-manager.ts");

  let frameListener = null;
  const fakeProc = {
    isAlive: true,
    onFrame(listener) {
      frameListener = listener;
      return () => { frameListener = null; };
    },
    sendCommand: async (command) => {
      if (command.type === "prompt") return { agentInvoked: true };
      if (command.type === "get_state") {
        return {
          sessionId: "test-session-1",
          sessionFile: "/tmp/session.jsonl",
          isStreaming: false,
          isCompacting: false,
        };
      }
      return {};
    },
    sendFrame: () => {},
    dispose: async () => {},
  };

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();

  await wrapper.send({ type: "prompt", message: "Hello" });
  frameListener({ type: "agent_start" });
  assert.equal(wrapper.isRunning(), true);

  // Missing agent_end frame — get_state reports raw idle
  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.isPromptRunning, false);
  assert.equal(wrapper.isRunning(), false);
  await wrapper.destroyAndWait();
});

// omp ≤18.6.1 still serializes the usage-limit state as `anthropicSlowMode`;
// buildWebState must dual-read it or the composer badge silently dies on the
// pinned binary (port of upstream 892399be, local wire-compat adaptation).
test("get_state dual-reads the usage-limit badge from the legacy anthropicSlowMode wire name", async () => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { AgentSessionWrapper } = jiti("./rpc-manager.ts");

  const usageLimit = { stage: "wrap_up", resetsAtSec: 1770000000, extraUsage: true };
  const fakeProc = {
    isAlive: true,
    onFrame() { return () => {}; },
    sendCommand: async (command) => {
      if (command.type === "get_state") {
        return {
          sessionId: "test-session-1",
          sessionFile: "/tmp/session.jsonl",
          isStreaming: false,
          isCompacting: false,
          anthropicSlowMode: usageLimit,
        };
      }
      return {};
    },
    sendFrame: () => {},
    dispose: async () => {},
  };

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();
  const state = await wrapper.send({ type: "get_state" });
  // The badge survives the pre-rename wire (pinned omp 18.6.1).
  assert.deepEqual(state.usageLimit, usageLimit);
  // The Slow toggle is advertised only by omp with the slow-mode RPC.
  assert.equal(state.slowModeSupported, false);
  assert.equal(state.slowModeEnabled, false);
  assert.equal(state.slowModeScope, undefined);
  await wrapper.destroyAndWait();
});

test("get_state prefers the renamed usageLimit wire field when omp ships it", async () => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { AgentSessionWrapper } = jiti("./rpc-manager.ts");

  const legacy = { stage: "wrap_up", extraUsage: false };
  const renamed = { stage: "low_priority", resetsAtSec: 1770000000, allowanceLeftPercent: 40 };
  const fakeProc = {
    isAlive: true,
    onFrame() { return () => {}; },
    sendCommand: async (command) => {
      if (command.type === "get_state") {
        return {
          sessionId: "test-session-1",
          sessionFile: "/tmp/session.jsonl",
          isStreaming: false,
          isCompacting: false,
          anthropicSlowMode: legacy,
          usageLimit: renamed,
          slowModeSupported: true,
          slowModeEnabled: true,
          slowModeScope: "global",
        };
      }
      return {};
    },
    sendFrame: () => {},
    dispose: async () => {},
  };

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();
  const state = await wrapper.send({ type: "get_state" });
  assert.deepEqual(state.usageLimit, renamed);
  assert.equal(state.slowModeSupported, true);
  assert.equal(state.slowModeEnabled, true);
  assert.equal(state.slowModeScope, "global");
  await wrapper.destroyAndWait();
});

test("set_slow_mode is an explicit wrapper command forwarded to omp", async () => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { AgentSessionWrapper } = jiti("./rpc-manager.ts");

  const sent = [];
  const fakeProc = {
    isAlive: true,
    onFrame() { return () => {}; },
    sendCommand: async (command) => {
      sent.push(command);
      if (command.type === "set_slow_mode") return command.enabled === true ? { enabled: true } : {};
      return {};
    },
    sendFrame: () => {},
    dispose: async () => {},
  };

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();
  const result = await wrapper.send({ type: "set_slow_mode", enabled: true });
  assert.deepEqual(sent, [{ type: "set_slow_mode", enabled: true }], "forwarded verbatim, not swallowed by the passthrough default");
  assert.deepEqual(result, { enabled: true });
  const off = await wrapper.send({ type: "set_slow_mode", enabled: false });
  assert.deepEqual(off, { enabled: false }, "omp's answer falls back to the requested value");
  await wrapper.destroyAndWait();
});

test("prompt ack pending does not let raw idle get_state clear promptRunning", async () => {
  const { AgentSessionWrapper } = await import("./rpc-manager.ts");

  let resolvePromptAck;
  const fakeProc = {
    isAlive: true,
    onFrame: () => () => {},
    sendCommand: async (command) => {
      if (command.type === "prompt") {
        return new Promise((resolve) => { resolvePromptAck = resolve; });
      }
      if (command.type === "get_state") {
        return {
          sessionId: "test-session-2",
          isStreaming: false,
          isCompacting: false,
        };
      }
      return {};
    },
    sendFrame: () => {},
    dispose: async () => {},
  };

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();

  const promptPromise = wrapper.send({ type: "prompt", message: "Hello" });
  assert.equal(wrapper.isRunning(), true);

  // While prompt ack is still pending, get_state must not clear isPromptRunning
  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.isPromptRunning, true);
  assert.equal(wrapper.isRunning(), true);

  resolvePromptAck({ agentInvoked: true });
  await promptPromise;
  await wrapper.destroyAndWait();
});

test("non-terminal agent_end keeps promptRunning through raw idle get_state until terminal agent_end", async () => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { AgentSessionWrapper } = jiti("./rpc-manager.ts");

  let frameListener = null;
  const fakeProc = {
    isAlive: true,
    onFrame(listener) {
      frameListener = listener;
      return () => { frameListener = null; };
    },
    sendCommand: async (command) => {
      if (command.type === "prompt") return { agentInvoked: true };
      if (command.type === "get_state") {
        return {
          sessionId: "test-session-3",
          isStreaming: false,
          isCompacting: false,
        };
      }
      return {};
    },
    sendFrame: () => {},
    dispose: async () => {},
  };

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();

  await wrapper.send({ type: "prompt", message: "Hello" });
  frameListener({ type: "agent_start" });
  // Async continuation pending (e.g. a backgrounded bash job): the turn
  // resumes with a later agent_start, so raw idle get_state must not clear
  // promptRunning even though the child reports isStreaming=false.
  frameListener({ type: "agent_end", isTerminal: false });

  const stateDuringPause = await wrapper.send({ type: "get_state" });
  assert.equal(stateDuringPause.isPromptRunning, true);
  assert.equal(wrapper.isRunning(), true);

  // The pause can last minutes (the background job runs) — time must not
  // matter; a time-based grace would have cleared the flag by now.
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 600_000;
    const stateAfterLongPause = await wrapper.send({ type: "get_state" });
    assert.equal(stateAfterLongPause.isPromptRunning, true);
    assert.equal(wrapper.isRunning(), true);
  } finally {
    Date.now = realNow;
  }

  // The continuation's terminal agent_end clears the flag.
  frameListener({ type: "agent_start" });
  frameListener({ type: "agent_end", isTerminal: true });
  const stateAfterTerminal = await wrapper.send({ type: "get_state" });
  assert.equal(stateAfterTerminal.isPromptRunning, false);
  assert.equal(wrapper.isRunning(), false);
  await wrapper.destroyAndWait();
});

test("abort_and_prompt images go through the same server-side validation as prompt", async () => {
  const { AgentSessionWrapper } = await import("./rpc-manager.ts");

  let forwarded = false;
  const fakeProc = {
    isAlive: true,
    onFrame: () => () => {},
    sendCommand: async () => { forwarded = true; return {}; },
    sendFrame: () => {},
    dispose: async () => {},
  };

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();

  await assert.rejects(
    wrapper.send({ type: "abort_and_prompt", message: "Hi", images: [{ type: "text", text: "nope" }] }),
    /Each attachment must be an image/,
  );
  assert.equal(forwarded, false, "an invalid attachment must never reach omp");
  await wrapper.destroyAndWait();
});

test("get_state timeout preserves the process and reports a transient status error", async () => {
  const { AgentSessionWrapper, WebRpcError } = await import("./rpc-manager.ts");
  const { RpcCommandTimeoutError } = await import("./omp/rpc-process.ts");

  let disposed = false;
  const fakeProc = {
    isAlive: true,
    onFrame: () => () => {},
    sendCommand: async (command, timeoutMs) => {
      if (command.type === "get_state") {
        assert.equal(timeoutMs, 5000);
        throw new RpcCommandTimeoutError("get_state", 5000);
      }
      return {};
    },
    sendFrame: () => {},
    dispose: async () => { disposed = true; },
  };

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();

  await assert.rejects(
    wrapper.send({ type: "get_state" }),
    (err) => {
      assert.ok(err instanceof WebRpcError || err.name === "WebRpcError");
      assert.equal(err.code, "session_state_timeout");
      return true;
    },
  );

  assert.equal(disposed, false);
  assert.equal(wrapper.isAlive(), true);
  await wrapper.destroyAndWait();
});

test("a running task survives a slow status query and later state reads recover", async (t) => {
  const { RpcCommandTimeoutError } = await import("./omp/rpc-process.ts");
  let reads = 0;
  let running = true;
  const { wrapper, emit } = snapshotSession(t, async (command) => {
    if (command.type === "get_state" && ++reads === 1) throw new RpcCommandTimeoutError("get_state", 5000);
    return { sessionId: "live", sessionFile: "", isStreaming: running, isCompacting: false };
  });
  let disposed = false;
  const dispose = wrapper.proc.dispose;
  wrapper.proc.dispose = async () => { disposed = true; return dispose(); };
  emit({ type: "agent_start" });
  await assert.rejects(wrapper.send({ type: "get_state" }), { code: "session_state_timeout" });
  assert.equal(disposed, false, "a read-only poll must never stop generation");
  assert.equal(wrapper.isRunning(), true);
  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.isStreaming, true);
  running = false;
  emit({ type: "agent_end", isTerminal: true });
  assert.equal((await wrapper.send({ type: "get_state" })).isStreaming, false);
  assert.equal(wrapper.isAlive(), true);
});

test("set_model timeout recycles wrapper and reports session_unresponsive", async () => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { AgentSessionWrapper, WebRpcError } = jiti("./rpc-manager.ts");
  const { RpcCommandTimeoutError } = jiti("./omp/rpc-process.ts");

  let disposed = false;
  const fakeProc = {
    isAlive: true,
    onFrame: () => () => {},
    sendCommand: async (command, timeoutMs) => {
      if (command.type === "set_model") {
        assert.equal(timeoutMs, 30000);
        throw new RpcCommandTimeoutError("set_model", timeoutMs);
      }
      return {};
    },
    sendFrame: () => {},
    dispose: async () => { disposed = true; },
  };

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();

  await assert.rejects(
    wrapper.send({ type: "set_model", provider: "provider", modelId: "model" }),
    (err) => {
      assert.ok(err instanceof WebRpcError || err.name === "WebRpcError");
      assert.equal(err.code, "session_unresponsive");
      return true;
    },
  );
  assert.equal(disposed, true);
  assert.equal(wrapper.isAlive(), false);
  assert.equal(wrapper.isRunning(), false);
});

test("getRunningRpcSessions and getRunningRpcSessionIds export running sessions with their originating cwd", async () => {
  const { getRunningRpcSessions, getRunningRpcSessionIds } = await import("./rpc-manager.ts");

  assert.equal(typeof getRunningRpcSessions, "function");
  assert.equal(typeof getRunningRpcSessionIds, "function");
  const running = getRunningRpcSessions();
  const runningIds = getRunningRpcSessionIds();
  assert.ok(Array.isArray(running));
  assert.ok(Array.isArray(runningIds));
  assert.deepEqual(runningIds, running.map((r) => r.id));
});

test("unexpected child exit is retained until a replacement session clears it", async (t) => {
  const {
    AgentSessionWrapper,
    clearExitedRpcSession,
    getExitedRpcSession,
  } = await import("./rpc-manager.ts");
  globalThis.__ompExitedSessions = new Map();
  t.after(() => { delete globalThis.__ompExitedSessions; });

  const fakeProc = {
    isAlive: true,
    waitReady: async () => ({ type: "ready", protocolVersion: 2 }),
    negotiateProtocol: async () => {},
    onFrame: () => () => {},
    sendCommand: async (command) => command.type === "get_state"
      ? {
          sessionId: "crashed-session",
          sessionFile: "/tmp/crashed-session.jsonl",
          isStreaming: false,
          isCompacting: false,
        }
      : {},
    sendFrame: () => {},
    dispose: async () => {},
  };

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();
  await wrapper.waitUntilReady();
  wrapper.expectedExitProc = fakeProc;
  wrapper.handleProcessExit({ code: 0, signal: null, stderrTail: "" }, fakeProc);
  assert.equal(getExitedRpcSession("crashed-session"), undefined, "deliberate disposal must not look like a crash");

  wrapper.restarting = true;
  const startedAt = Date.now();
  wrapper.handleProcessExit(
    { code: null, signal: "SIGKILL", stderrTail: `${"x".repeat(600)}fatal detail` },
    {},
  );

  const recorded = getExitedRpcSession("crashed-session");
  assert.ok(recorded.at >= startedAt && recorded.at <= Date.now());
  assert.deepEqual({ ...recorded, at: 0 }, {
    id: "crashed-session",
    cwd: process.cwd(),
    at: 0,
    code: null,
    signal: "SIGKILL",
    detail: `${"x".repeat(488)}fatal detail`,
  });
  assert.equal(clearExitedRpcSession("crashed-session"), true);
  assert.equal(getExitedRpcSession("crashed-session"), undefined);
  await wrapper.destroyAndWait();
});

test("a resumed session crash is retained before its initial handshake", async (t) => {
  const { AgentSessionWrapper, getExitedRpcSession } = await import("./rpc-manager.ts");
  globalThis.__ompExitedSessions = new Map();
  t.after(() => { delete globalThis.__ompExitedSessions; });

  const fakeProc = {
    isAlive: true,
    onFrame: () => () => {},
    sendFrame: () => {},
    dispose: async () => {},
  };
  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "resume-before-ready", undefined, localHost);
  wrapper.start();
  wrapper.handleProcessExit({ code: 1, signal: null, stderrTail: "startup failed" });

  assert.equal(getExitedRpcSession("resume-before-ready").detail, "startup failed");
  await wrapper.destroyAndWait();
});

/** One reachable (hidden) tab in an isolated notification hub; `restore()` tears it down. */
async function reachableTab() {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { saveDevice } = await import("./notification-store.ts");
  const previousHub = globalThis.__ompNotificationHub;
  const previousExited = globalThis.__ompExitedSessions;
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const dir = mkdtempSync(join(tmpdir(), "omp-notify-rpc-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  saveDevice("desk-0001", { enabled: true, types: { completed: true, input: true, error: true, modelSwitch: true }, whenActive: "toast", locale: "en" });
  globalThis.__ompExitedSessions = new Map();
  const delivered = [];
  globalThis.__ompNotificationHub = {
    presence: new Map([["tab-0001", { clientId: "tab-0001", deviceId: "desk-0001", visible: false, sessionId: null, lastSeen: Date.now() }]]),
    streams: new Map([["tab-0001", new Set([(message) => delivered.push([message.event.type, message.event.detail])])]]),
  };
  const restore = () => {
    globalThis.__ompNotificationHub = previousHub;
    globalThis.__ompExitedSessions = previousExited;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    // Windows cannot delete the directory while the store's database is open.
    closeNotificationStore();
    rmSync(dir, { recursive: true, force: true });
  };
  return { delivered, restore };
}

/** A wrapper whose omp frames the test drives, with one reachable tab collecting notifications. */
async function notifyingSession(t) {
  const { delivered, restore } = await reachableTab();
  let feed;
  /** What omp's get_state answers; tests change it to simulate session moves and switches. */
  const ompState = { sessionId: "notify-session", sessionFile: "/tmp/notify-session.jsonl", isStreaming: false, isCompacting: false };
  const fakeProc = {
    isAlive: true,
    waitReady: async () => ({ type: "ready", protocolVersion: 2 }),
    negotiateProtocol: async () => {},
    onFrame: (handler) => { feed = handler; return () => {}; },
    sendCommand: async (command) => command.type === "get_state" ? { ...ompState } : {},
    sendFrame: () => {},
    dispose: async () => {},
  };
  const wrapper = new SnapshotWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();
  await wrapper.waitUntilReady();
  t.after(async () => {
    await wrapper.destroyAndWait();
    restore();
  });
  return { wrapper, feed, delivered, ompState };
}

test("after a moved session switches to another conversation, a tab left on the old id no longer silences it", async (t) => {
  const { wrapper, feed, delivered, ompState } = await notifyingSession(t);
  // omp moves the conversation to a new file (session-persistence notice).
  Object.assign(ompState, { sessionId: "moved-session", sessionFile: "/tmp/moved-session.jsonl" });
  feed({ type: "notice", level: "warning", source: "session-persistence", message: "moved" });
  await new Promise((resolve) => setImmediate(resolve));
  // Then the user switches the wrapper to an unrelated session.
  Object.assign(ompState, { sessionId: "other-session", sessionFile: "/tmp/other-session.jsonl" });
  await wrapper.refreshIdentityAfterSessionChange();

  globalThis.__ompNotificationHub.presence.set("tab-0001", {
    clientId: "tab-0001", deviceId: "desk-0001", visible: true, sessionId: "notify-session", seq: 1, lastSeen: Date.now(),
  });
  feed({ type: "agent_start" });
  feed({ type: "session_settled" });
  assert.deepEqual(delivered.filter(([type]) => type === "completed"), [["completed", undefined]]);
});

test("omp frames reach the user as notifications: settled run, pending question", async (t) => {
  const { feed, delivered } = await notifyingSession(t);
  feed({ type: "agent_start" });
  feed({ type: "agent_end", isTerminal: true, messages: [] });
  feed({ type: "prompt_result", agentInvoked: true, status: "completed", sessionSettled: true });
  assert.deepEqual(delivered, [], "completion waits for session_settled");
  feed({ type: "session_settled" });
  feed({ type: "extension_ui_request", id: "q1", method: "confirm", title: "Delete the branch?", message: "" });
  assert.deepEqual(delivered, [["completed", undefined], ["input", "Delete the branch?"]]);
});

test("a crash during a run notifies the user once", async (t) => {
  const { wrapper, feed, delivered } = await notifyingSession(t);
  feed({ type: "agent_start" });
  wrapper.handleProcessExit({ code: 1, signal: null, stderrTail: "out of memory" });
  assert.deepEqual(delivered, [["error", "out of memory"]]);
});

test("a crash after the turn ended but before background work settled still notifies", async (t) => {
  const { wrapper, feed, delivered } = await notifyingSession(t);
  feed({ type: "agent_start" });
  feed({ type: "agent_end", isTerminal: true, messages: [] });
  feed({ type: "prompt_result", agentInvoked: true, status: "completed", sessionSettled: false });
  wrapper.handleProcessExit({ code: 1, signal: null, stderrTail: "killed" });
  assert.deepEqual(delivered, [["error", "killed"]]);
});

test("an asynchronous prompt failure (failed response) notifies the user", async (t) => {
  const { feed, delivered } = await notifyingSession(t);
  feed({ type: "response", id: "p1", command: "prompt", success: false, error: "No API key for provider" });
  assert.deepEqual(delivered, [["error", "No API key for provider"]]);
});

test("a crash of an idle session does not notify", async (t) => {
  const { wrapper, delivered } = await notifyingSession(t);
  wrapper.handleProcessExit({ code: 1, signal: null, stderrTail: "out of memory" });
  assert.deepEqual(delivered, []);
});

test("buildSessionSpawnArgs maps tool presets to spawn flags", async () => {
  const { buildSessionSpawnArgs } = await import("./hosts/local-host.ts");

  // "full" must omit --tools entirely so omp keeps its complete default
  // toolset (task/hub included); any other list becomes an explicit --tools
  // restriction; an empty list disables tools; resume never re-applies tools.
  assert.deepEqual(buildSessionSpawnArgs("", ["bash", "read", "edit", "write", "grep", "find", "ls"]), []);
  assert.deepEqual(buildSessionSpawnArgs("", ["read", "bash", "edit", "write"]), ["--tools", "read,bash,edit,write"]);
  assert.deepEqual(buildSessionSpawnArgs("", []), ["--no-tools"]);
  assert.deepEqual(buildSessionSpawnArgs("", undefined), []);
  assert.deepEqual(
    buildSessionSpawnArgs("/tmp/session.jsonl", ["read", "bash", "edit", "write"]),
    ["--resume", "/tmp/session.jsonl"],
  );
});
test("buildSessionSpawnArgs applies workspace launch config safely", async () => {
  const { buildSessionSpawnArgs } = await import("./hosts/local-host.ts");

  assert.deepEqual(
    buildSessionSpawnArgs("", undefined, false, { profile: "work", advisor: true, extraArgs: ["--verbose"] }),
    ["--advisor", "--profile", "work", "--verbose"],
  );
  // Explicit per-call advisor wins; reserved/smuggled args never reach the child.
  assert.deepEqual(
    buildSessionSpawnArgs("", undefined, true, { advisor: false, extraArgs: ["--cwd=/evil", "--resume", "--verbose"] }),
    ["--advisor", "--verbose"],
  );
  // Dash-leading profiles are dropped instead of becoming flag slots.
  assert.deepEqual(buildSessionSpawnArgs("", undefined, false, { profile: "--evil" }), []);
});

test("buildSessionSpawnArgs binds an explicit model on resume only (#277)", async () => {
  const { buildSessionSpawnArgs } = await import("./hosts/local-host.ts");

  // A cold set_model must reach omp before the saved model is restored, so
  // the spawn carries --model alongside --resume.
  assert.deepEqual(
    buildSessionSpawnArgs("/tmp/session.jsonl", undefined, false, undefined, "october/gpt-6.1-sol"),
    ["--resume", "/tmp/session.jsonl", "--model", "october/gpt-6.1-sol"],
  );
  // New sessions apply their model over RPC after spawn, not at spawn time.
  assert.deepEqual(buildSessionSpawnArgs("", undefined, false, undefined, "october/gpt-6.1-sol"), []);
  // Flag-smuggled / whitespace values never become a flag slot.
  assert.deepEqual(
    buildSessionSpawnArgs("/tmp/session.jsonl", undefined, false, undefined, "--evil"),
    ["--resume", "/tmp/session.jsonl"],
  );
  assert.deepEqual(
    buildSessionSpawnArgs("/tmp/session.jsonl", undefined, false, undefined, "october/gpt 6"),
    ["--resume", "/tmp/session.jsonl"],
  );
});








test("mcp list ack timeout recycles a child that accepts the frame but withholds its response", async (t) => {
  const { AgentSessionWrapper, WebRpcError } = await import("./rpc-manager.ts");
  const { RpcCommandTimeoutError } = await import("./omp/rpc-process.ts");

  t.mock.timers.enable({ apis: ["setTimeout"] });
  let acceptedFrame = null;
  let disposed = false;
  const fakeProc = {
    isAlive: true,
    onFrame: () => () => {},
    sendCommand: (command, timeoutMs) => {
      if (command.type !== "prompt") return Promise.resolve({});
      acceptedFrame = command;
      // The transport ack of the accepted /mcp list frame — the child takes
      // the frame and never answers.
      assert.equal(timeoutMs, 30000);
      return new Promise((_, reject) => {
        setTimeout(() => reject(new RpcCommandTimeoutError("prompt", timeoutMs)), timeoutMs);
      });
    },
    sendFrame: () => {},
    dispose: async () => { disposed = true; },
  };

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();

  const pending = wrapper.getMcpList();
  await Promise.resolve();
  assert.deepEqual(acceptedFrame, { type: "prompt", message: "/mcp list" });
  t.mock.timers.tick(30000);

  await assert.rejects(
    pending,
    (err) => {
      assert.ok(err instanceof WebRpcError || err.name === "WebRpcError");
      assert.equal(err.code, "session_unresponsive");
      return true;
    },
  );

  assert.equal(disposed, true);
  assert.equal(wrapper.isAlive(), false);
  assert.equal(wrapper.isRunning(), false);
});

test("mcp list ack timeout clears the waiter so a retry is not blocked as busy", async (t) => {
  const { AgentSessionWrapper } = await import("./rpc-manager.ts");
  const { RpcCommandTimeoutError } = await import("./omp/rpc-process.ts");

  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fakeProc = {
    isAlive: true,
    onFrame: () => () => {},
    sendCommand: (command, timeoutMs) =>
      command.type === "prompt"
        ? new Promise((_, reject) => {
            setTimeout(() => reject(new RpcCommandTimeoutError("prompt", timeoutMs)), timeoutMs);
          })
        : Promise.resolve({}),
    sendFrame: () => {},
    dispose: async () => {},
  };

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();

  const first = wrapper.getMcpList();
  await Promise.resolve();
  t.mock.timers.tick(30000);
  await assert.rejects(first, { code: "session_unresponsive" });

  // The wedged wrapper must not report itself busy: without the bounded ack
  // the finally block never ran and this second call failed with session_busy.
  await assert.rejects(
    () => wrapper.getMcpList(),
    (err) => {
      assert.equal(err.message, "Session is no longer running");
      return true;
    },
  );
});

test("live snapshots restore quiet partial messages and tools, with ordered event metadata", async (t) => {
  const { wrapper, emit } = snapshotSession(t);
  const events = [];
  wrapper.onEvent((event) => {
    events.push(event);
    // The server-side coalescer may dispatch a partial after a later frame was
    // already recorded; the state must never be BEHIND the frame the subscriber
    // sees, and the frame must belong to the wrapper's current stream epoch.
    const cursor = wrapper.getStreamSnapshot().cursor;
    assert.equal(cursor.streamId, event.web.streamId);
    assert.ok(cursor.sequence >= event.web.sequence, "state is updated before subscribers run");
  });
  emit({ type: "agent_start" });
  emit({ type: "message_start", message: { role: "assistant", content: [] } });
  const first = { role: "assistant", content: [{ type: "text", text: "partial" }] };
  emit({ type: "message_update", message: first });
  emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "sleep 1" } });
  emit({ type: "tool_execution_update", toolCallId: "tool-1", partialResult: { content: [{ type: "text", text: "working" }] } });
  const snapshot = wrapper.getStreamSnapshot();
  assert.deepEqual(snapshot.streamingMessage, first);
  assert.equal(snapshot.isStreaming, true);
  assert.deepEqual(snapshot.toolEvents.map(({ toolCallId, toolName, args, partialResult }) => ({ toolCallId, toolName, args, partialResult })), [
    { toolCallId: "tool-1", toolName: "bash", args: { command: "sleep 1" }, partialResult: { content: [{ type: "text", text: "working" }] } },
  ]);
  await Promise.resolve(); // no further frame: reload must still have a snapshot
  assert.deepEqual(wrapper.getStreamSnapshot(), snapshot);
  emit({ type: "message_start", message: { role: "user", content: "steering" } });
  emit({ type: "message_end", message: { role: "user", content: "steering" } });
  assert.deepEqual(wrapper.getStreamSnapshot().streamingMessage, first);
  emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "newer" }] } });
  assert.deepEqual(snapshot.streamingMessage, first, "later frames do not mutate prior HTTP snapshots");
  snapshot.cursor.sequence = -1;
  snapshot.streamingMessage.role = "user";
  snapshot.toolEvents[0].toolName = "changed";
  snapshot.toolEvents.length = 0;
  assert.equal(wrapper.getStreamSnapshot().toolEvents[0].toolName, "bash");
  assert.equal(wrapper.getStreamSnapshot().streamingMessage.role, "assistant");
  for (let i = 1; i < events.length; i++) {
    assert.equal(events[i].web.streamId, events[0].web.streamId);
    assert.ok(events[i].web.sequence > events[i - 1].web.sequence);
  }
  emit({ type: "tool_execution_end", toolCallId: "tool-1" });
  emit({ type: "message_end", message: first });
  assert.equal(wrapper.getStreamSnapshot().streamingMessage, null);
  assert.deepEqual(wrapper.getStreamSnapshot().toolEvents, []);
});

test("a returned background tool's later updates stay out of the live snapshot", (t) => {
  const { wrapper, emit } = snapshotSession(t);
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  emit({ type: "agent_start" });
  for (const id of ["ended", "committed"]) emit({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: {} });
  emit({ type: "tool_execution_end", toolCallId: "ended" });
  emit({ type: "message_end", message: { role: "toolResult", toolCallId: "committed", content: [] } });
  // omp keeps reporting a backgrounded job on its call id after the call returned, with no later end.
  for (const id of ["ended", "committed"]) {
    emit({ type: "tool_execution_update", toolCallId: id, toolName: "bash", partialResult: { content: [{ type: "text", text: "done" }] } });
  }
  assert.deepEqual(wrapper.getStreamSnapshot().toolEvents, []);
  assert.equal(events.some((event) => event.type === "tool_execution_update"), false, "open tabs drop them too: the row would show running again");
  emit({ type: "agent_end" });
  emit({ type: "agent_start" });
  emit({ type: "tool_execution_update", toolCallId: "ended", toolName: "bash", partialResult: { content: [] } });
  assert.deepEqual(wrapper.getStreamSnapshot().toolEvents, [], "a job outliving its run stays out of the next run's snapshot");
  emit({ type: "tool_execution_start", toolCallId: "ended", toolName: "bash", args: {} });
  emit({ type: "tool_execution_update", toolCallId: "ended", toolName: "bash", partialResult: { content: [] } });
  assert.deepEqual(wrapper.getStreamSnapshot().toolEvents.map((event) => event.toolCallId), ["ended"], "a new start of a reused id is live again");
});

test("live tool-result images reach tabs and the replay snapshot as media URLs", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-live-media-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  });
  const { wrapper, emit } = snapshotSession(t);
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  const image = { type: "image", data: Buffer.from("png bytes").toString("base64"), mimeType: "image/png" };
  emit({ type: "tool_execution_start", toolCallId: "shot", toolName: "eval" });
  emit({ type: "tool_execution_update", toolCallId: "shot", partialResult: { content: [image] } });
  // The wrapper folds tool updates to display rate; let the fold flush before
  // reading what the tab actually received.
  await new Promise((resolve) => setTimeout(resolve, 60));
  const url = events[1].partialResult.content[0].url;
  assert.match(url, /^\/api\/media\/[a-f0-9]{64}$/);
  assert.equal(wrapper.getStreamSnapshot().toolEvents[0].partialResult.content[0].url, url, "reconnecting tabs get the URL too");
  emit({ type: "message_end", message: { role: "toolResult", toolCallId: "shot", content: [{ type: "text", text: "done" }, image] } });
  assert.deepEqual(events[2].message.content[1], { type: "image", mimeType: "image/png", url });
  assert.equal(JSON.stringify(events).includes(image.data), false, "no base64 reaches a tab");
});

test("terminal failures, new runs, aborts and idle reconciliation cannot revive old partial output", async (t) => {
  let failPrompt = false;
  const { wrapper, emit } = snapshotSession(t, async (command) => {
    if (command.type === "prompt" && failPrompt) throw new Error("prompt rejected");
    if (command.type === "get_state") return { sessionId: "snapshot-life", isStreaming: false, isCompacting: false };
    return {};
  });
  const seed = () => {
    emit({ type: "agent_start" });
    emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "old" }] } });
    emit({ type: "tool_execution_start", toolCallId: "old-tool", toolName: "bash" });
  };
  const assertCleared = () => {
    const snapshot = wrapper.getStreamSnapshot();
    assert.equal(snapshot.streamingMessage, null);
    assert.deepEqual(snapshot.toolEvents, []);
  };
  seed();
  emit({ type: "agent_end", isTerminal: false });
  assert.equal(wrapper.getStreamSnapshot().isPromptRunning, true);
  assert.equal(wrapper.getStreamSnapshot().toolEvents[0].toolCallId, "old-tool");
  emit({ type: "agent_start" });
  assertCleared();
  seed();
  emit({ type: "agent_end", isTerminal: true });
  assertCleared();
  assert.equal(wrapper.getStreamSnapshot().isStreaming, false);
  seed();
  emit({ type: "response", command: "prompt", success: false, error: "provider failed" });
  assertCleared();
  assert.equal(wrapper.isRunning(), false);
  seed();
  await wrapper.send({ type: "abort" });
  assertCleared();
  seed();
  await wrapper.send({ type: "get_state" });
  assertCleared();
  assert.equal(wrapper.getStreamSnapshot().isPromptRunning, false);
  seed();
  failPrompt = true;
  await assert.rejects(wrapper.send({ type: "prompt", message: "retry" }), /prompt rejected/);
  assertCleared();
  await wrapper.destroyAndWait();
  assert.equal(wrapper.getStreamSnapshot().isStreaming, false);
});

test("session identity changes invalidate the stream epoch and all prior partial output", async (t) => {
  let sessionId = "identity-before";
  const { wrapper, emit } = snapshotSession(t, async (command) => {
    if (command.type === "switch_session") { sessionId = "identity-after"; return { cancelled: false }; }
    return { sessionId, sessionFile: `/tmp/${sessionId}.jsonl`, isStreaming: false, isCompacting: false };
  });
  await wrapper.send({ type: "get_state" });
  emit({ type: "agent_start" });
  emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "prior identity" }] } });
  emit({ type: "tool_execution_start", toolCallId: "before", toolName: "bash" });
  const before = wrapper.getStreamSnapshot();
  assert.equal(before.responseObserved, true);
  const result = await wrapper.send({ type: "switch_session", sessionPath: "/tmp/identity-after.jsonl" });
  assert.equal(result.newSessionId, "identity-after");
  const after = wrapper.getStreamSnapshot();
  assert.notEqual(after.cursor.streamId, before.cursor.streamId);
  assert.equal(after.cursor.sequence, 0);
  assert.equal(after.streamingMessage, null);
  assert.deepEqual(after.toolEvents, []);
  assert.equal(after.isPromptRunning, false);
  assert.equal(after.responseObserved, false);
});

test("reload replaces the native stream epoch and subscribes to replacement events", async (t) => {
  const previousBin = process.env.OMP_WEB_OMP_BIN;
  process.env.OMP_WEB_OMP_BIN = process.execPath;
  t.after(() => {
    if (previousBin === undefined) delete process.env.OMP_WEB_OMP_BIN;
    else process.env.OMP_WEB_OMP_BIN = previousBin;
  });
  let transport;
  const replacementCommands = [];
  const spawnReplacement = () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill() { queueMicrotask(() => child.emit("exit", 0, null)); return true; },
    });
    transport = child;
    let pending = "";
    child.stdin.on("data", (chunk) => {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const command = JSON.parse(line);
        replacementCommands.push(command);
        // Answer set_ask_dialog like an omp that predates it.
        child.stdout.write(JSON.stringify(command.type === "set_ask_dialog"
          ? { type: "response", id: command.id, command: command.type, success: false, error: "Unknown command: set_ask_dialog" }
          : {
              type: "response", id: command.id, command: command.type, success: true,
              data: command.type === "get_state"
                ? { sessionId: "restart-session", isStreaming: false, isCompacting: false }
                : {},
            }) + "\n");
      }
    });
    child.stdin.on("end", () => queueMicrotask(() => child.emit("exit", 0, null)));
    queueMicrotask(() => child.stdout.write('{"type":"ready"}\n'));
    return child;
  };
  await mockBuiltin(t, "node:child_process", { spawn: spawnReplacement });
  const { AgentSessionWrapper: ReloadWrapper } = await import(`./rpc-manager.ts?fresh=${isolatedFresh++}`);
  const { wrapper, emit } = snapshotSession(t, undefined, ReloadWrapper);
  emit({ type: "agent_start" });
  emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "old child" }] } });
  const before = wrapper.getStreamSnapshot();
  assert.equal(before.responseObserved, true);
  const restarting = wrapper.send({ type: "reload" });
  assert.equal(wrapper.getStreamSnapshot().streamingMessage, null, "restart clears old output before waiting for the replacement");
  assert.equal(wrapper.getStreamSnapshot().responseObserved, false);
  await assert.rejects(wrapper.send({ type: "get_state" }), { code: "session_restarting" });
  await restarting;
  const askOptIn = replacementCommands.find((command) => command.type === "set_ask_dialog");
  assert.equal(askOptIn?.enabled, true, "the replacement child is re-opted into the ask dialog; a rejection does not fail the restart");
  const after = wrapper.getStreamSnapshot();
  assert.notEqual(after.cursor.streamId, before.cursor.streamId);
  assert.equal(after.cursor.sequence, 0);
  assert.equal(after.streamingMessage, null);
  assert.deepEqual(after.toolEvents, []);
  assert.equal(after.responseObserved, false);
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  transport.stdout.write('{"type":"agent_start"}\n');
  assert.equal(events[0].web.streamId, after.cursor.streamId);
  assert.ok(events[0].web.sequence > after.cursor.sequence);
  await wrapper.destroyAndWait();
});

test("dialog replay keeps sequence ordering and disconnect still settles owned host requests", async (t) => {
  const { wrapper, emit, sentFrames } = snapshotSession(t);
  const firstEvents = [];
  const detachFirst = wrapper.onEvent((event) => firstEvents.push(event));
  await wrapper.send({ type: "set_host_tools", tools: [{ name: "browser" }] });
  emit({ type: "extension_ui_request", id: "dialog", method: "input", title: "Value" });
  emit({ type: "host_tool_call", id: "host", toolName: "browser" });
  const beforeReplay = wrapper.getStreamSnapshot().cursor.sequence;
  const replay = [];
  const detachSecond = wrapper.onEvent((event) => replay.push(event));
  assert.equal(replay[0].id, "dialog");
  assert.ok(replay[0].web.sequence > beforeReplay);
  assert.equal(replay.some((event) => event.type === "host_tool_call"), false, "host work retains its existing owner");
  detachFirst();
  assert.deepEqual(sentFrames, []);
  detachSecond();
  assert.equal(sentFrames[0].type, "host_tool_result");
  assert.equal(sentFrames[0].id, "host");
  assert.equal(sentFrames[0].isError, true);
  emit({ type: "extension_ui_request", method: "cancel", targetId: "dialog" });
  const afterCancel = [];
  wrapper.onEvent((event) => afterCancel.push(event));
  assert.deepEqual(afterCancel, []);
});

test("expired dialogs are not replayed by a later stream subscription", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { wrapper, emit } = snapshotSession(t);
  emit({ type: "extension_ui_request", id: "expired", method: "input", title: "Value", timeout: 100 });
  t.mock.timers.tick(101);
  const received = [];
  wrapper.onEvent((event) => received.push(event));
  assert.deepEqual(received, []);
});

test("native web metadata cannot forge either wire or cached tool snapshot sequencing", async (t) => {
  const { wrapper, emit } = snapshotSession(t);
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  const forged = { streamId: "native-forgery", sequence: Number.MAX_SAFE_INTEGER };
  emit({ type: "tool_execution_start", toolCallId: "tool", toolName: "bash", args: { command: "pwd" }, web: forged });
  const first = wrapper.getStreamSnapshot();
  assert.equal(first.toolEvents[0].web, undefined);
  assert.notEqual(events[0].web.streamId, forged.streamId);
  assert.deepEqual(events[0].web, first.cursor);
  emit({ type: "tool_execution_update", toolCallId: "tool", partialResult: { content: [{ type: "text", text: "workspace" }] }, web: forged });
  // Wait for the wrapper's display-rate fold to flush the update to tabs.
  await new Promise((resolve) => setTimeout(resolve, 60));
  const updated = wrapper.getStreamSnapshot();
  assert.equal(updated.toolEvents[0].web, undefined);
  assert.deepEqual(events[1].web, updated.cursor);
  assert.ok(updated.cursor.sequence > first.cursor.sequence);
  assert.equal(updated.toolEvents[0].toolName, "bash");
  assert.deepEqual(updated.toolEvents[0].args, { command: "pwd" });
});

test("new prompts and interrupts cannot reuse old response evidence before agent_start", async (t) => {
  let release;
  const { wrapper, emit } = snapshotSession(t, (command) => {
    if (command.type === "get_state") return Promise.resolve({ sessionId: "run-evidence", isStreaming: false, isCompacting: false });
    return new Promise((resolve) => { release = () => resolve({ agentInvoked: true }); });
  });
  for (const type of ["prompt", "abort_and_prompt"]) {
    emit({ type: "agent_start" });
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "old answer" }] } });
    assert.equal(wrapper.getStreamSnapshot().responseObserved, true);
    const pending = wrapper.send({ type, message: "next question" });
    assert.equal(wrapper.getStreamSnapshot().responseObserved, false);
    // An old completion while abort_and_prompt is in flight belongs to the
    // interrupted turn, not the replacement prompt.
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "late old answer" }] } });
    emit({ type: "agent_end", isTerminal: true });
    assert.equal(wrapper.getStreamSnapshot().responseObserved, false);
    release();
    await pending;
    emit({ type: "agent_start" });
    emit({ type: "agent_end", isTerminal: true });
    assert.equal((await wrapper.send({ type: "get_state" })).responseObserved, false);
  }
});

test("only visible assistant content supplies current-run response evidence", async (t) => {
  const { wrapper, emit } = snapshotSession(t);
  for (const content of [
    [], " ", [{ type: "thinking", thinking: "reasoning" }],
    [{ type: "toolCall", id: "tool", name: "read", arguments: {} }],
    [{ type: "text", text: " " }],
  ]) {
    emit({ type: "agent_start" });
    emit({ type: "message_end", message: { role: "assistant", content } });
    emit({ type: "agent_end", isTerminal: true });
    assert.equal(wrapper.getStreamSnapshot().responseObserved, false);
  }
  for (const content of ["answer", [{ type: "text", text: "answer" }], [{ type: "image", data: "image" }]]) {
    emit({ type: "agent_start" });
    emit({ type: "message_update", message: { role: "assistant", content } });
    assert.equal(wrapper.getStreamSnapshot().responseObserved, true);
    emit({ type: "agent_start" });
    assert.equal(wrapper.getStreamSnapshot().responseObserved, false);
  }
});

test("startup opts into the ask dialog and still starts when omp rejects the command", async (t) => {
  const commands = [];
  const fakeProc = {
    isAlive: true,
    waitReady: async () => ({ type: "ready", protocolVersion: 2 }),
    negotiateProtocol: async () => {},
    onFrame: () => () => {},
    sendCommand: async (command) => {
      commands.push(command);
      if (command.type === "set_ask_dialog") throw new Error("Unknown command: set_ask_dialog");
      return command.type === "get_state"
        ? { sessionId: "ask-session", isStreaming: false, isCompacting: false }
        : {};
    },
    sendFrame: () => {},
    dispose: async () => {},
  };
  const wrapper = new SnapshotWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();
  t.after(() => wrapper.destroyAndWait());
  await wrapper.waitUntilReady();
  assert.deepEqual(commands.find((command) => command.type === "set_ask_dialog"), { type: "set_ask_dialog", enabled: true });
  assert.equal(wrapper.sessionId, "ask-session");
});

test("ask dialogs stay pending until a well-formed answers payload is forwarded", async (t) => {
  const { wrapper, emit, sentFrames } = snapshotSession(t);
  emit({
    type: "extension_ui_request", id: "ask", method: "ask",
    questions: [{ id: "q", question: "Pick", options: [{ label: "A" }] }],
  });
  for (const answers of [
    "A",
    [null],
    [{ id: 1, selectedOptions: [] }],
    [{ id: "q", selectedOptions: "A" }],
    [{ id: "q", selectedOptions: [1] }],
    [{ id: "q", selectedOptions: [], customInput: 5 }],
  ]) {
    await assert.rejects(
      wrapper.send({ type: "extension_ui_response", id: "ask", answers }),
      { name: "WebRpcError", code: "invalid_ask_answers" },
      JSON.stringify(answers),
    );
  }
  await assert.rejects(
    wrapper.send({ type: "extension_ui_response", id: "ask", value: "A" }),
    { name: "WebRpcError", code: "invalid_ask_answers" },
    "a select-style value cannot answer a pending ask",
  );
  assert.deepEqual(sentFrames, [], "malformed answers never reach omp");
  const replay = [];
  wrapper.onEvent((event) => replay.push(event));
  assert.equal(replay[0]?.method, "ask", "a rejected answer leaves the dialog pending for reconnects");

  const answers = [{ id: "q", selectedOptions: ["A"], customInput: "more" }];
  await wrapper.send({ type: "extension_ui_response", id: "ask", answers });
  assert.deepEqual(sentFrames, [{ type: "extension_ui_response", id: "ask", answers }]);
  const afterAnswer = [];
  wrapper.onEvent((event) => afterAnswer.push(event));
  assert.deepEqual(afterAnswer, []);

  emit({ type: "extension_ui_request", id: "ask2", method: "ask", questions: [{ id: "q", question: "Pick", options: [{ label: "A" }] }] });
  await wrapper.send({ type: "extension_ui_response", id: "ask2", cancelled: true });
  assert.deepEqual(sentFrames.at(-1), { type: "extension_ui_response", id: "ask2", cancelled: true });
});

test("answering a dialog in one tab dismisses it in every other attached tab", async (t) => {
  const { wrapper, emit } = snapshotSession(t);
  const other = [];
  wrapper.onEvent((event) => other.push(event));

  emit({ type: "extension_ui_request", id: "ask", method: "confirm", title: "Keep going?" });
  other.length = 0;

  await wrapper.send({ type: "extension_ui_response", id: "ask", confirmed: true });
  assert.deepEqual(
    other.map(({ type, method, targetId }) => ({ type, method, targetId })),
    [{ type: "extension_ui_request", method: "cancel", targetId: "ask" }],
  );

  other.length = 0;
  await wrapper.send({ type: "extension_ui_response", id: "ask", confirmed: true });
  assert.deepEqual(other, [], "an already-settled dialog emits nothing");

  await wrapper.destroyAndWait();
});

test("a server-owned confirm takes omp's dialog path and its answer stays on the server", async (t) => {
  const { wrapper, feed, delivered } = await notifyingSession(t);
  const sent = [];
  wrapper.proc.sendFrame = (frame) => sent.push(frame);
  const events = [];
  wrapper.onEvent((event) => events.push(event));

  const answer = wrapper.confirmFromServer("Start a session on build-box in /srv/app?");
  assert.deepEqual(delivered, [["input", "Start a session on build-box in /srv/app?"]]);
  const request = events.find((event) => event.type === "extension_ui_request" && event.method === "confirm");
  assert.equal(request.title, "Start a session on build-box in /srv/app?");
  assert.equal(wrapper.isRunning(), true, "a pending dialog keeps the session waiting on the user");
  await wrapper.send({ type: "extension_ui_response", id: request.id, confirmed: true });
  assert.equal(await answer, true);
  assert.deepEqual(sent, [], "omp never sees the server's dialog answer");
  assert.ok(events.some((event) => event.method === "cancel" && event.targetId === request.id), "other tabs drop the dialog");

  const ended = wrapper.confirmFromServer("Second?");
  feed({ type: "agent_end", isTerminal: true, messages: [] });
  assert.equal(await ended, false, "a run that ends settles the dialog as declined");
  assert.equal(wrapper.isRunning(), false);

  const closed = wrapper.confirmFromServer("Third?");
  await wrapper.destroyAndWait();
  assert.equal(await closed, false, "a destroyed session settles the dialog as declined");
  assert.equal(await wrapper.confirmFromServer("Fourth?"), false);
});

// ----------------------------------------------------------------------------
// Disconnect reaper (DISCONNECT_DESTROY_MS)
//
// Most drive the real wrapper through the real timer. The window is injected
// through the constructor's test seam (the 120s default would make every
// assertion here vacuous), and the fake process records dispose() so "the child
// was torn down" is observed directly instead of inferred from isAlive() alone.
// ----------------------------------------------------------------------------

const REAP_MS = 25;
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Long enough that a correct implementation reaps, short enough to stay fast. */
const afterWindow = () => settle(REAP_MS * 8);

function reapedSession(t, sendCommand, windowMs = REAP_MS, host = localHost) {
  const disposed = [];
  const { wrapper, emit } = snapshotSession(t, sendCommand ?? (async () => ({})), SnapshotWrapper, "", windowMs, host);
  // The fake process is a plain object, so record dispose() instead.
  const proc = wrapper.proc;
  const inner = proc.dispose.bind(proc);
  proc.dispose = async () => { disposed.push(Date.now()); return inner(); };
  return { wrapper, emit, disposed };
}

for (const method of ["ask", "confirm", "input"]) {
  test(`a pending ${method} dialog survives disconnect cleanup until answered`, async (t) => {
    const { wrapper, emit, disposed } = reapedSession(t);
    emit({ type: "extension_ui_request", id: "waiting", method, title: "Continue?", questions: [] });
    await afterWindow();
    assert.deepEqual(disposed, [], "waiting for a human is active work, not an abandoned session");
    assert.equal(wrapper.isAlive(), true);
    assert.equal(wrapper.isRunning(), true);
    emit({ type: "extension_ui_request", method: "cancel", targetId: "waiting" });
    await afterWindow();
    assert.equal(disposed.length, 1, "cleanup is allowed after the pending dialog is gone");
  });
}

test("the ten-minute idle backstop also preserves a pending question", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { wrapper, emit, disposed } = reapedSession(t, undefined, 0);
  emit({ type: "extension_ui_request", id: "waiting", method: "ask", questions: [] });
  t.mock.timers.tick(10 * 60 * 1000 + 1);
  assert.equal(wrapper.isAlive(), true);
  assert.deepEqual(disposed, []);
});

test("a session nobody ever subscribed is reaped without an SSE disconnect", async (t) => {
  // The regression this replaces: arming only from the onEvent unsubscribe path
  // meant a session created by /api/agent/new or /api/mcp, and every keystroke
  // that hits the predict_word fast path, never armed the fast reaper at all.
  const { wrapper, disposed } = reapedSession(t);
  assert.equal(wrapper.hasSubscribers(), false, "precondition: no SSE subscriber");
  await afterWindow();
  assert.equal(disposed.length, 1, "an unwatched session is torn down on schedule");
  assert.equal(wrapper.isAlive(), false);
});

test("a session with an attached SSE listener is never reaped, and is reaped after it detaches", async (t) => {
  const { wrapper, disposed } = reapedSession(t);
  const detach = wrapper.onEvent(() => {});
  assert.equal(wrapper.hasSubscribers(), true);
  // Well past the window: destroying here would leave the route's HTTP 200
  // stream half-open and drop the run without a terminal frame.
  await settle(REAP_MS * 4);
  assert.deepEqual(disposed, [], "a watched session survives past the window");
  assert.equal(wrapper.isAlive(), true);

  // A second tab keeps it alive after the first one leaves.
  const detach2 = wrapper.onEvent(() => {});
  detach();
  await settle(REAP_MS * 4);
  assert.deepEqual(disposed, [], "one remaining subscriber still protects it");
  assert.equal(wrapper.isAlive(), true);

  detach2();
  await afterWindow();
  assert.equal(disposed.length, 1, "the last tab leaving starts the reap clock");
  assert.equal(wrapper.isAlive(), false);
});

test("a session that keeps sending commands is not reaped mid-traffic", async (t) => {
  // POSTs to /api/agent/[id] (predict_word on every keystroke, get_state polls
  // while a run is active) reach sessions that have no SSE subscriber at all.
  // Control time: a busy parallel suite can delay a real keepalive past the
  // 25 ms deadline, which correctly reaps the idle wrapper before it is sent.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { wrapper, disposed } = reapedSession(t);
  for (let i = 0; i < 20; i++) {
    t.mock.timers.tick(Math.floor(REAP_MS / 4));
    await wrapper.send({ type: "get_state" });
  }
  assert.deepEqual(disposed, [], "traffic keeps pushing the deadline out");
  assert.equal(wrapper.isAlive(), true);

  t.mock.timers.tick(REAP_MS * 8);
  assert.equal(disposed.length, 1, "once traffic stops the session is reclaimed");
  assert.equal(wrapper.isAlive(), false);
});

test("the reaper never disposes the child under an in-flight command", async (t) => {
  // A command whose response the child still owes: the deadline check alone
  // would fire mid-command and surface as a bogus "Session is no longer
  // running" to whichever route asked.
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const { wrapper, disposed } = reapedSession(t, async () => pending);
  const inflight = wrapper.send({ type: "get_state" });
  await settle(REAP_MS * 5);
  assert.deepEqual(disposed, [], "an awaited command blocks the reap");
  assert.equal(wrapper.isAlive(), true);

  release({ sessionId: "s1" });
  await inflight;
  await afterWindow();
  assert.equal(disposed.length, 1, "the reap resumes once the command settles");
});

for (const fails of [false, true]) {
  test(`a submitted upload survives disconnect during preparation; ${fails ? "failure releases protection and the send fence" : "the prepared prompt reaches omp"}`, async (t) => {
    const { runAgentCommand } = await import("./agent-command.ts");
    const { startUpload } = await import("./uploads.ts");
    const { getHost } = await import("./hosts/hub.ts");
    const { linkHost, until } = await import("./hosts/link-driver.test-helper.mjs");
    const link = await linkHost("Slow upload copy");
    let release;
    const preparation = new Promise((resolve) => { release = resolve; });
    let attaching = false;
    const serving = link.serve({
      uploadStart: () => ({ received: 0, done: true }),
      uploadAttach: async () => {
        attaching = true;
        await preparation;
        if (fails) throw new Error("copy failed");
        return { path: "/remote/s/local/uploads/slow.txt", url: "local://uploads/slow.txt" };
      },
    });
    t.after(async () => { release(); link.drop(); await serving; });
    const id = randomUUID();
    const sessionId = randomUUID();
    await startUpload({ id, hostId: link.id, owner: "open", name: "slow.txt", size: 0, type: "text/plain", sink: { ack() {}, error() {} } });
    const sent = [];
    const { wrapper, disposed } = reapedSession(t, async (command) => {
      if (command.type === "get_state") return { sessionId, sessionFile: "/remote/s.jsonl", isStreaming: false, isCompacting: false };
      sent.push(command);
      return { agentInvoked: false };
    }, REAP_MS, getHost(link.id));
    const detach = wrapper.onEvent(() => {});
    await wrapper.send({ type: "get_state" });
    globalThis.__ompSessions ??= new Map();
    globalThis.__ompSessions.set(sessionId, wrapper);
    t.after(() => { globalThis.__ompSessions.delete(sessionId); globalThis.__ompUploads.delete(id); });

    const submitting = runAgentCommand(sessionId, { type: "prompt", message: "read it", uploads: [id] }, false, "open");
    await until(() => attaching, "upload preparation to start");
    const stop = fails ? runAgentCommand(sessionId, { type: "abort" }, false, "open") : null;
    detach();
    await afterWindow();
    const disposedDuringPreparation = [...disposed];
    const aliveDuringPreparation = wrapper.isAlive();
    release();
    const response = await submitting;
    const stopped = stop ? await stop : null;
    assert.deepEqual(disposedDuringPreparation, [], "preparing a submitted prompt is active command work");
    assert.equal(aliveDuringPreparation, true);
    assert.equal(response.status, fails ? 500 : 200, await response.clone().text());
    if (fails) {
      assert.equal((await response.json()).error, "Slow upload copy: copy failed");
      assert.equal(stopped.status, 200, "the failed attach releases the following Stop");
      assert.deepEqual(sent.map((command) => command.type), ["abort"], "a failed preparation never dispatches the prompt");
    } else {
      assert.deepEqual(sent, [{ type: "prompt", message: "read it\n\nAttached files (this session's local:// directory):\n- [`local://uploads/slow.txt`](/remote/s/local/uploads/slow.txt) (/remote/s/local/uploads/slow.txt, 0 B, text/plain)" }]);
    }
    await afterWindow();
    assert.equal(disposed.length, 1, "normal idle reaping resumes when preparation and dispatch settle");
  });
}

test("a running session is not reaped and is reaped once the run ends", async (t) => {
  const { wrapper, emit, disposed } = reapedSession(t);
  emit({ type: "agent_start" });
  assert.equal(wrapper.isRunning(), true, "precondition: mid-run");
  await settle(REAP_MS * 5);
  assert.deepEqual(disposed, [], "an unwatched run is left alone");
  assert.equal(wrapper.isAlive(), true);

  emit({ type: "agent_end", isTerminal: true });
  assert.equal(wrapper.isRunning(), false);
  await afterWindow();
  assert.equal(disposed.length, 1, "the abandoned run is reclaimed after it ends");
});

test("frames from the child also hold the session open", async (t) => {
  // Deliberately not agent_start: this must hold while nothing is "running",
  // so it can only pass if handleFrame itself records activity. A run's frames
  // are already covered by isRunning() above, which would hide a regression
  // here.
  //
  // A longer window than the group default, and frames driven by their own
  // interval: the property under test is a deadline that keeps moving, not
  // that this test's own timers fire on time. With a 25ms window, asserting
  // between sleeps meant a stalled event loop could reap the session before a
  // late frame arrived, and the test failed at random under a parallel run.
  const WINDOW_MS = 150;
  const { wrapper, emit, disposed } = reapedSession(t, undefined, WINDOW_MS);
  const frames = setInterval(() => emit({ type: "message_update" }), Math.floor(WINDOW_MS / 10));
  t.after(() => clearInterval(frames));

  await settle(WINDOW_MS * 5);
  assert.deepEqual(disposed, [], "frames hold the session open well past the reap window");
  assert.equal(wrapper.isAlive(), true);

  clearInterval(frames);
  await settle(WINDOW_MS * 8);
  assert.equal(disposed.length, 1, "the session is reclaimed once the frames stop");
  assert.equal(wrapper.isAlive(), false);
});

test("closing the last tab starts a fresh window instead of reaping on stale activity", async (t) => {
  // A reload closes the stream and reopens it within a second or two. Reaping
  // on the *last* activity instead of on the detach would kill the child under
  // a tab that is already on its way back, and the reconnected stream would 409
  // ("Session is not managed by omp-web") until a POST respawns it.
  const GRACE_MS = 400;
  const disposed = [];
  const { wrapper } = snapshotSession(t, async () => ({}), SnapshotWrapper, "", GRACE_MS);
  const proc = wrapper.proc;
  const inner = proc.dispose.bind(proc);
  proc.dispose = async () => { disposed.push(Date.now()); return inner(); };

  const detach = wrapper.onEvent(() => {});
  // Well past the window while the tab is open: nothing may be reaped.
  await settle(GRACE_MS * 2);
  assert.deepEqual(disposed, [], "a watched session outlives the window");

  detach();
  await settle(GRACE_MS / 2);
  assert.deepEqual(disposed, [], "detaching grants a fresh window, it does not expose stale activity");
  await settle(GRACE_MS * 2);
  assert.equal(disposed.length, 1, "the window still elapses if no tab comes back");
});

test("a session stuck in its startup handshake is never reaped", async (t) => {
  // READY_TIMEOUT_MS and the disconnect window are the same order of magnitude,
  // so a child that never announces itself must fail through its own startup
  // timeout (which reports a real error) instead of being reaped as "unused".
  const disposed = [];
  const proc = {
    isAlive: true,
    onFrame: () => () => {},
    // Never resolves: the handshake stays open for the life of this test.
    waitReady: () => new Promise(() => {}),
    sendCommand: async () => ({}),
    sendFrame: () => {},
    dispose: async () => {},
  };
  const wrapper = new SnapshotWrapper(proc, process.cwd(), null, false, "", REAP_MS, localHost);
  t.after(() => wrapper.destroyAndWait());
  const inner = proc.dispose.bind(proc);
  proc.dispose = async () => { disposed.push(Date.now()); return inner(); };

  wrapper.start();
  // startRpcSession() runs start() and then waitUntilReady(); the handshake is
  // the second half of that sequence.
  void wrapper.waitUntilReady();
  await settle(REAP_MS * 8);
  assert.deepEqual(disposed, [], "the handshake is in-flight work, not idleness");
  assert.equal(wrapper.isAlive(), true);
});

test("reaping is disabled when the disconnect window is 0", async (t) => {
  const disposed = [];
  const { wrapper } = snapshotSession(t, async () => ({}), SnapshotWrapper, "", 0);
  const proc = wrapper.proc;
  const inner = proc.dispose.bind(proc);
  proc.dispose = async () => { disposed.push(Date.now()); return inner(); };
  await settle(REAP_MS * 8);
  assert.deepEqual(disposed, [], "OMP_WEB_DISCONNECT_DESTROY_MS=0 keeps only the 10min idle backstop");
  assert.equal(wrapper.isAlive(), true);
});

test("neither cleanup timer keeps the event loop alive", async () => {
  // The reaper and the idle timer are cleanup deadlines, not work: an unref'd
  // timer is what lets the dev server and a test runner exit. A ref'd one pins a
  // process that has nothing else pending for the full window.
  const moduleUrl = new URL("./rpc-manager.ts", import.meta.url).href;
  const script = `
    const { AgentSessionWrapper } = await import(${JSON.stringify(moduleUrl)});
    const wrapper = new AgentSessionWrapper(
      { isAlive: true, onFrame: () => () => {}, sendCommand: async () => ({}), sendFrame: () => {}, dispose: async () => {} },
      process.cwd(), null, false, "", 10 * 60 * 1000,
    );
    wrapper.start();
    process.stdout.write("armed\\n");
  `;
  const child = childProcess.spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("child kept the event loop alive")); }, 20_000);
    child.on("error", reject);
    child.on("exit", (exitCode) => { clearTimeout(timer); resolve(exitCode); });
  });
  assert.equal(code, 0, `child exited badly: ${err}`);
  assert.match(out, /armed/, "the wrapper armed its timers before the process should exit");
});

test("SSE subscribers receive folded stream frames, ordered before other events", async () => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { AgentSessionWrapper } = jiti("./rpc-manager.ts");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let frameListener = null;
  const fakeProc = {
    isAlive: true,
    onFrame(listener) {
      frameListener = listener;
      return () => { frameListener = null; };
    },
    sendCommand: async () => ({}),
    sendFrame: () => {},
    dispose: async () => {},
  };
  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();
  const events = [];
  wrapper.onEvent((event) => events.push(event));

  // Stream-rate frames are folded: nothing reaches subscribers per frame.
  frameListener({ type: "message_update", message: { text: "a" } });
  frameListener({ type: "message_update", message: { text: "ab" } });
  frameListener({ type: "tool_execution_update", toolCallId: "t1", partialResult: { output: "1" } });
  frameListener({ type: "tool_execution_update", toolCallId: "t1", partialResult: { output: "12" } });
  assert.deepEqual(events, [], "folded frames must not dispatch per frame");

  // A different frame flushes the folded updates FIRST (latest message,
  // then each tool's latest update), then dispatches itself.
  frameListener({ type: "notice", level: "info", message: "mid" });
  assert.deepEqual(
    events.map((e) => [e.type, e.text ?? e.message?.text ?? e.partialResult?.output ?? e.message]),
    [["message_update", "ab"], ["tool_execution_update", "12"], ["notice", "mid"]],
  );

  // message_end supersedes the buffered partial but keeps tool updates for
  // the scheduled flush (same contract the browser coalescer implements).
  events.length = 0;
  frameListener({ type: "message_update", message: { text: "abc" } });
  frameListener({ type: "tool_execution_update", toolCallId: "t1", partialResult: { output: "123" } });
  frameListener({ type: "message_end", message: { done: true } });
  assert.deepEqual(events.map((e) => e.type), ["message_end"]);
  await sleep(120);
  const folded = events.filter((e) => e.type === "tool_execution_update");
  assert.equal(folded.length, 1, "only the latest tool update is delivered");
  assert.equal(folded[0].partialResult.output, "123");
  assert.equal(events.some((e) => e.type === "message_update" && e.message?.text === "abc"), false);

  // A new burst folds to one frame per display window, latest wins.
  events.length = 0;
  frameListener({ type: "message_update", message: { text: "x" } });
  frameListener({ type: "message_update", message: { text: "xy" } });
  await sleep(120);
  const updates = events.filter((e) => e.type === "message_update");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].message.text, "xy");

  await wrapper.destroyAndWait();
});

test("goal and subagent control commands are forwarded to the child", async () => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { AgentSessionWrapper } = jiti("./rpc-manager.ts");

  const sent = [];
  const fakeProc = {
    isAlive: true,
    onFrame: () => () => {},
    sendCommand: async (command) => {
      sent.push(command);
      return { ok: true, echo: command };
    },
    sendFrame: () => {},
    dispose: async () => {},
  };
  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();

  const goal = await wrapper.send({ type: "goal", op: "create", objective: "Ship it" });
  const cancel = await wrapper.send({ type: "cancel_subagent", subagentId: "sub_1" });
  const steer = await wrapper.send({ type: "steer_subagent", subagentId: "sub_1", message: "slow down" });

  assert.deepEqual(sent.map((c) => c.type), ["goal", "cancel_subagent", "steer_subagent"]);
  assert.equal(sent[0].op, "create");
  // The child's result passes through untouched (the client parses it).
  assert.equal(goal.ok, true);
  assert.equal(cancel.echo.subagentId, "sub_1");
  assert.equal(steer.echo.message, "slow down");

  await wrapper.destroyAndWait();
});

test("abort_and_restore_queue returns omp's withdrawn messages and clears the run like abort", async (t) => {
  const restored = { steering: [{ text: "steer" }], followUp: [{ text: "later" }] };
  const sent = [];
  const { wrapper, emit } = snapshotSession(t, async (command) => {
    sent.push(command.type);
    if (command.type === "abort_and_restore_queue") return restored;
    return { ignored: true };
  });
  emit({ type: "agent_start" });
  assert.deepEqual(await wrapper.send({ type: "abort_and_restore_queue" }), restored);
  assert.equal(await wrapper.send({ type: "abort" }), null, "plain abort still answers nothing");
  assert.deepEqual(sent.filter((type) => type.startsWith("abort")), ["abort_and_restore_queue", "abort"]);
});

test("skill diagnostics cross the wrapper only as parsed public DTOs", async (t) => {
  const privateSnapshot = {
    cwd: "/workspace",
    showStartupDiagnostics: true,
    diagnostics: [{
      name: "review",
      reason: "source-order",
      skills: [{
        name: "review",
        filePath: "/workspace/.agents/skills/review/SKILL.md",
        source: "project",
        pluginName: "tools",
        body: "private prompt",
        _source: { kind: "internal" },
      }],
      duplicates: [{
        skill: {
          name: "review",
          filePath: "/home/me/.agents/skills/review/SKILL.md",
          source: "user",
          frontmatter: { version: 2 },
        },
        retained: {
          name: "review",
          filePath: "/workspace/.agents/skills/review/SKILL.md",
          source: "project",
          containRoot: "/workspace",
        },
      }],
      internal: "hidden",
    }],
    privateField: true,
  };
  const publicSnapshot = {
    cwd: "/workspace",
    showStartupDiagnostics: true,
    diagnostics: [{
      name: "review",
      reason: "source-order",
      skills: [{
        name: "review",
        filePath: "/workspace/.agents/skills/review/SKILL.md",
        source: "project",
        pluginName: "tools",
      }],
      duplicates: [{
        skill: {
          name: "review",
          filePath: "/home/me/.agents/skills/review/SKILL.md",
          source: "user",
        },
        retained: {
          name: "review",
          filePath: "/workspace/.agents/skills/review/SKILL.md",
          source: "project",
        },
      }],
    }],
  };
  let stateDiagnostics = privateSnapshot;
  let directDiagnostics = privateSnapshot;
  let nativeFrame;
  const forwarded = [];
  const fakeProc = {
    isAlive: true,
    onFrame(listener) {
      nativeFrame = listener;
      return () => {};
    },
    async sendCommand(command) {
      forwarded.push(command);
      if (command.type === "get_state") {
        return {
          sessionId: "diagnostics-session",
          isStreaming: false,
          isCompacting: false,
          skillDiagnostics: stateDiagnostics,
        };
      }
      if (command.type === "get_skill_diagnostics") return directDiagnostics;
      if (command.type === "set_skill_startup_diagnostics") {
        return { ...privateSnapshot, showStartupDiagnostics: false };
      }
      return {};
    },
    sendFrame: () => {},
    dispose: async () => {},
  };
  const wrapper = new SnapshotWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();
  t.after(() => wrapper.destroyAndWait());

  const state = await wrapper.send({ type: "get_state" });
  assert.deepEqual(state.skillDiagnostics, publicSnapshot);
  assert.deepEqual(await wrapper.send({ type: "get_skill_diagnostics" }), publicSnapshot);
  assert.deepEqual(
    await wrapper.send({ type: "set_skill_startup_diagnostics", enabled: true }),
    { ...publicSnapshot, showStartupDiagnostics: false },
    "setter replies are stripped to the public DTO",
  );

  const events = [];
  wrapper.onEvent((event) => events.push(event));
  nativeFrame({ type: "skill_diagnostics_update", data: privateSnapshot });
  const event = { ...events.at(-1) };
  delete event.web;
  assert.deepEqual(event, { type: "skill_diagnostics_update", data: publicSnapshot });

  stateDiagnostics = { cwd: "/workspace", showStartupDiagnostics: true, diagnostics: "clean" };
  assert.equal((await wrapper.send({ type: "get_state" })).skillDiagnostics, undefined);
  directDiagnostics = { cwd: "/workspace", showStartupDiagnostics: true, diagnostics: "clean" };
  await assert.rejects(() => wrapper.send({ type: "get_skill_diagnostics" }), /skill diagnostics/i);
  await assert.rejects(
    () => wrapper.send({ type: "set_skill_startup_diagnostics", enabled: "false" }),
    /enabled must be a boolean/i,
  );
  assert.equal(
    forwarded.some((command) => command.type === "set_skill_startup_diagnostics" && command.enabled === "false"),
    false,
    "invalid control data must not reach OMP",
  );
});

test("a session-persistence move re-keys the wrapper without resetting the run", async (t) => {
  let state = { sessionId: "old-id", sessionFile: "/s/old.jsonl", isStreaming: false };
  const { wrapper, emit } = snapshotSession(t, async (command) => (command.type === "get_state" ? { ...state } : {}), SnapshotWrapper, "old-id");
  await wrapper.send({ type: "get_state" });
  const changes = [];
  wrapper.onIdentityChange((oldId, newId, options) => changes.push([oldId, newId, options?.keepOldId === true]));

  emit({ type: "agent_start" });
  state = { sessionId: "new-id", sessionFile: "/s/new.jsonl", isStreaming: true };
  emit({ type: "notice", level: "warning", source: "session-persistence", message: "Session moved to a new file" });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(changes, [["old-id", "new-id", true]]);
  assert.equal(wrapper.sessionId, "new-id");
  assert.equal(wrapper.sessionFile, "/s/new.jsonl");
  assert.equal(wrapper.isRunning(), true, "the in-flight run survives the move");
});

test("a later genuine session switch is not treated as a move", async (t) => {
  let state = { sessionId: "a", sessionFile: "/s/a.jsonl", isStreaming: false };
  const { wrapper, emit } = snapshotSession(t, async (command) => (command.type === "get_state" ? { ...state } : {}), SnapshotWrapper, "a");
  await wrapper.send({ type: "get_state" });
  const changes = [];
  wrapper.onIdentityChange((oldId, newId, options) => changes.push([oldId, newId, options?.keepOldId === true]));

  // A persistence warning that changes nothing must not leave the flag armed.
  emit({ type: "notice", level: "warning", source: "session-persistence", message: "write failed" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(changes, []);

  state = { sessionId: "b", sessionFile: "/s/b.jsonl", isStreaming: false };
  await wrapper.send({ type: "get_state" });
  assert.equal(wrapper.sessionId, "b");
  assert.deepEqual(changes, [], "a plain get_state change is not announced as a move");
});

test("generateTitle uses omp's native generate_title command", async (t) => {
  const sent = [];
  const { wrapper } = snapshotSession(t, async (command) => {
    sent.push(command.type);
    return command.type === "generate_title" ? { title: "  Fix the login bug " } : {};
  });
  assert.equal(await wrapper.generateTitle(), "Fix the login bug");
  assert.deepEqual(sent, ["generate_title"]);
});

test("generateTitle falls back to /rename when generate_title is unknown", async (t) => {
  const sent = [];
  let name;
  const { wrapper } = snapshotSession(t, async (command) => {
    sent.push(command.type === "prompt" ? command.message : command.type);
    if (command.type === "generate_title") throw new Error("Unknown command: generate_title");
    if (command.type === "prompt") { name = "Refactor sidebar"; return { agentInvoked: false }; }
    if (command.type === "get_state") return { sessionId: "s", sessionFile: "/s/s.jsonl", isStreaming: false, sessionName: name };
    return {};
  });
  assert.equal(await wrapper.generateTitle(), "Refactor sidebar");
  assert.ok(sent.includes("/rename"));
  // The unsupported answer is remembered for this child: the second call goes
  // straight to `/rename`. The fake names that run with a fresh title so the
  // poll settles on the new title exactly like a real omp generator would.
  sent.length = 0;
  name = undefined;
  setTimeout(() => { name = "Second rename title"; }, 60);
  assert.equal(await wrapper.generateTitle(), "Second rename title");
  assert.ok(!sent.includes("generate_title"));
});

test("generateTitle never sends /rename while a run is in flight", async (t) => {
  const sent = [];
  const { wrapper, emit } = snapshotSession(t, async (command) => {
    sent.push(command.type === "prompt" ? command.message : command.type);
    if (command.type === "generate_title") throw new Error("Unknown command: generate_title");
    return {};
  });
  emit({ type: "agent_start" });
  assert.equal(await wrapper.generateTitle(), null);
  assert.ok(!sent.includes("/rename"));
});

test("generateTitle returns null — never the stale name — when generation fails", async (t) => {
  const name = "Old title";
  const { wrapper, emit } = snapshotSession(t, async (command) => {
    if (command.type === "generate_title") throw new Error("Unknown command: generate_title");
    if (command.type === "get_state") return { sessionId: "s", sessionFile: "/s/s.jsonl", isStreaming: false, sessionName: name };
    return {};
  });
  // The child echoes the generator's failure as command_output, exactly as omp
  // does; that settles the poll without burning the full timeout.
  setTimeout(() => emit({ type: "command_output", text: "Could not generate a session title. Use /rename <title> to set one." }), 50);
  const started = Date.now();
  assert.equal(await wrapper.generateTitle(), null);
  assert.ok(Date.now() - started < 5000, "the failure echo settles the poll early");
});

test("the web's own /rename output stays out of the chat stream", async (t) => {
  const events = [];
  let name;
  const { wrapper, emit } = snapshotSession(t, async (command) => {
    if (command.type === "generate_title") throw new Error("Unknown command: generate_title");
    if (command.type === "get_state") return { sessionId: "s", sessionFile: "/s/s.jsonl", isStreaming: false, sessionName: name };
    return {};
  });
  const unsubscribe = wrapper.onEvent((event) => events.push(event.type));
  t.after(unsubscribe);
  // The run lands while the poll is in flight: title + confirmation output.
  setTimeout(() => {
    name = "Fresh generated title";
    emit({ type: "command_output", text: 'Renamed session to "Fresh generated title"' });
  }, 50);
  assert.equal(await wrapper.generateTitle(), "Fresh generated title");
  assert.ok(!events.includes("command_output"), "the web-initiated rename echo is not conversation");
  // Outside the rename window command_output is delivered again (other slash commands).
  emit({ type: "command_output", text: "some other command output" });
  assert.ok(events.includes("command_output"));
});

// ── Pre-spawn holder gate (restart fork-storm fix) ─────────────────────────
// omp >= 18.5 lets exactly one process own a session file; a second live
// --resume child forks it into a sibling file on its first write. The gate
// in startRpcSession must therefore run BEFORE the spawn, reap leaked
// previous-instance children, and refuse to steal the file from a holder
// OmpWeb must not stop.

test("startRpcSession gates on live file holders before spawning the child", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  // The gate covers every resume spawn (sessionFile set) and only that —
  // brand-new sessions have no file to be held.
  assert.match(source, /if \(sessionFile\) await releaseStaleSessionHolders\(sessionFile\)/);
  // Before the child is created — after the spawn the file is already forked.
  const startBody = /export async function startRpcSession\([\s\S]*?\n}\n/.exec(source)?.[0] ?? "";
  if (!(startBody.includes("await releaseStaleSessionHolders(sessionFile)") && startBody.includes("spawned = await host.spawnRpc(") && startBody.indexOf("await releaseStaleSessionHolders(sessionFile)") < startBody.indexOf("spawned = await host.spawnRpc("))) {
    assert.fail("the holder gate must run before the child is spawned");
  }
  // Leaked children are terminated together with their orphaned host daemons
  // (the daemon survives its Node owner and never idles down while a child
  // lives — that is what kept stale ownership across restarts), and the
  // spawn waits for the file to actually fall free.
  assert.match(source, /findSessionFileHolders\(sessionFile\)/);
  assert.match(source, /partitionSessionHolders\(holders\)/);
  assert.match(source, /holder\.parentPid/);
  assert.match(source, /await terminateHoldersAndWait\(/);
  // Holders that must not be stopped reject the spawn with typed errors
  // instead of silently letting the child move the file.
  assert.match(source, /"session_held_external"/);
  assert.match(source, /"session_held_stuck"/);
});

test("releaseStaleSessionHolders rejects a terminal holder and leaves it running", async () => {
  const fs = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = fs.mkdtempSync(join(tmpdir(), "omp-gate-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const { releaseStaleSessionHolders, WebRpcError } = await import("./rpc-manager.ts");
  const sessionsDir = join(dir, "sessions", "-gate");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const id = "eeee9999-eeee-4eee-8eee-eeee99999999";
  const file = join(sessionsDir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: dir }) + "\n");
  // Fake terminal holder: a symlink named "omp" pointing at python3 (the
  // /proc pre-filter matches argv[0]'s basename), setsid'd so it is
  // reparented to init — a terminal run, never a web child.
  const holderDir = join(dir, "fakebin");
  fs.mkdirSync(holderDir, { recursive: true });
  const holderBin = join(holderDir, "omp");
  const py = childProcess.spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
  const resolved = childProcess.spawnSync("sh", ["-c", `readlink -f ${JSON.stringify(py)}`], { encoding: "utf8" }).stdout.trim();
  fs.symlinkSync(resolved || py, holderBin);
  const script = join(dir, "holder.py");
  fs.writeFileSync(script, 'import os, time\nwith open(os.environ["PID_FILE"], "w") as f: f.write(str(os.getpid()))\ntime.sleep(15)\n');
  const pidFile = join(dir, "holder.pid");
  const sh = childProcess.spawn("sh", ["-c", `setsid ${holderBin} ${script} --mode rpc-ui --cwd ${dir} --resume ${file} >/dev/null 2>&1 &`], { stdio: "ignore", env: { ...process.env, PID_FILE: pidFile } });
  sh.unref();
  try {
    let holderPid = 0;
    const deadline = Date.now() + 8000;
    while (holderPid === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      try {
        holderPid = Number(fs.readFileSync(pidFile, "utf8").trim());
      } catch {
        // not written yet
      }
    }
    assert.ok(holderPid > 0, "the fake holder must start");
    await assert.rejects(
      () => releaseStaleSessionHolders(file),
      (err) => err instanceof WebRpcError && err.code === "session_held_external",
    );
    // The gate refused: the holder is untouched and still running.
    process.kill(holderPid, 0);
  } finally {
    try {
      process.kill(Number(fs.readFileSync(pidFile, "utf8").trim()), "SIGKILL");
    } catch {
      // already exited
    }
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("live tool-result images reach tabs as media URLs (base64 never crosses the wire)", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-live-media-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  });
  const { wrapper, emit } = snapshotSession(t);
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  const image = { type: "image", data: Buffer.from("png bytes").toString("base64"), mimeType: "image/png" };
  emit({ type: "tool_execution_start", toolCallId: "shot", toolName: "eval" });
  emit({ type: "tool_execution_update", toolCallId: "shot", partialResult: { content: [image] } });
  emit({ type: "message_end", message: { role: "toolResult", toolCallId: "shot", content: [{ type: "text", text: "done" }, image] } });
  // message_end dispatches through the coalescer synchronously; the folded
  // tool update follows on the next display-rate flush.
  const url = events[1].message.content[1].url;
  assert.match(url, /^\/api\/media\/[a-f0-9]{64}$/);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(events[2].partialResult.content[0], { type: "image", mimeType: "image/png", url });
  assert.equal(JSON.stringify(events).includes(image.data), false, "no base64 reaches a tab");
});

/** A wrapper whose omp frames the test drives, with one reachable tab collecting notifications. */
test("after a moved session switches to another conversation, a tab left on the old id no longer silences it", async (t) => {
  const { wrapper, feed, delivered, ompState } = await notifyingSession(t);
  // omp moves the conversation to a new file (session-persistence notice).
  Object.assign(ompState, { sessionId: "moved-session", sessionFile: "/tmp/moved-session.jsonl" });
  feed({ type: "notice", level: "warning", source: "session-persistence", message: "moved" });
  await new Promise((resolve) => setImmediate(resolve));
  // Then the user switches the wrapper to an unrelated session.
  Object.assign(ompState, { sessionId: "other-session", sessionFile: "/tmp/other-session.jsonl" });
  await wrapper.refreshIdentityAfterSessionChange();

  globalThis.__ompNotificationHub.presence.set("tab-0001", {
    clientId: "tab-0001", deviceId: "desk-0001", visible: true, sessionId: "notify-session", seq: 1, lastSeen: Date.now(),
  });
  feed({ type: "agent_start" });
  feed({ type: "session_settled" });
  assert.deepEqual(delivered.filter(([type]) => type === "completed"), [["completed", undefined]]);
});

test("omp frames reach the user as notifications: settled run, pending question", async (t) => {
  const { feed, delivered } = await notifyingSession(t);
  feed({ type: "agent_start" });
  feed({ type: "agent_end", isTerminal: true, messages: [] });
  feed({ type: "prompt_result", agentInvoked: true, status: "completed", sessionSettled: true });
  assert.deepEqual(delivered, [], "completion waits for session_settled");
  feed({ type: "session_settled" });
  feed({ type: "extension_ui_request", id: "q1", method: "confirm", title: "Delete the branch?", message: "" });
  assert.deepEqual(delivered, [["completed", undefined], ["input", "Delete the branch?"]]);
});

test("a crash during a run notifies the user once", async (t) => {
  const { wrapper, feed, delivered } = await notifyingSession(t);
  feed({ type: "agent_start" });
  wrapper.handleProcessExit({ code: 1, signal: null, stderrTail: "out of memory" });
  assert.deepEqual(delivered, [["error", "out of memory"]]);
});

test("a crash after the turn ended but before background work settled still notifies", async (t) => {
  const { wrapper, feed, delivered } = await notifyingSession(t);
  feed({ type: "agent_start" });
  feed({ type: "agent_end", isTerminal: true, messages: [] });
  feed({ type: "prompt_result", agentInvoked: true, status: "completed", sessionSettled: false });
  wrapper.handleProcessExit({ code: 1, signal: null, stderrTail: "killed" });
  assert.deepEqual(delivered, [["error", "killed"]]);
});

test("an asynchronous prompt failure (failed response) notifies the user", async (t) => {
  const { feed, delivered } = await notifyingSession(t);
  feed({ type: "response", id: "p1", command: "prompt", success: false, error: "No API key for provider" });
  assert.deepEqual(delivered, [["error", "No API key for provider"]]);
});

test("a crash of an idle session does not notify", async (t) => {
  const { wrapper, delivered } = await notifyingSession(t);
  wrapper.handleProcessExit({ code: 1, signal: null, stderrTail: "out of memory" });
  assert.deepEqual(delivered, []);
});

// ── Auto-title at session start (web setting autoGenerateSessionTitles) ──

function isolatedAgentDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "ompweb-autotitle-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

class TitleSpyWrapper extends SnapshotWrapper {
  async generateTitle() {
    this.titleCalls = (this.titleCalls ?? 0) + 1;
    // Like the real generator, a successful title is adopted — that is what
    // ends the asking, not a one-shot flag.
    this.adoptSessionName("Investigate sidebar render glitch");
    return "Investigate sidebar render glitch";
  }
}

const settleFirstRun = (emit) => {
  emit({ type: "agent_start" });
  emit({ type: "agent_end", isTerminal: true });
  emit({ type: "prompt_result", agentInvoked: true, status: "completed", sessionSettled: true });
};

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

test("a brand-new session auto-generates its title after the first settled run", async (t) => {
  const dir = isolatedAgentDir(t);
  writeFileSync(join(dir, "omp-web-settings.json"), JSON.stringify({ autoGenerateSessionTitles: true }), "utf8");
  const sessionFile = sessionFileFixture(t);
  const { wrapper, emit } = snapshotSession(t, async (command) => (
    command.type === "get_state"
      ? { sessionId: "s1", sessionFile, isStreaming: false, isCompacting: false }
      : {}
  ), TitleSpyWrapper, "s1");
  await wrapper.send({ type: "get_state" });
  settleFirstRun(emit);
  await nextTick();
  assert.equal(wrapper.titleCalls, 1);
  // A generated title ends the asking: a later completion must not re-title.
  settleFirstRun(emit);
  await nextTick();
  assert.equal(wrapper.titleCalls, 1);
});

test("auto-titling stays OFF by default (no generator call without the setting)", async (t) => {
  isolatedAgentDir(t); // no settings file — the OFF default must suppress
  const sessionFile = sessionFileFixture(t);
  const { wrapper, emit } = snapshotSession(t, async (command) => (
    command.type === "get_state"
      ? { sessionId: "s1", sessionFile, isStreaming: false, isCompacting: false }
      : {}
  ), TitleSpyWrapper, "s1");
  await wrapper.send({ type: "get_state" });
  settleFirstRun(emit);
  await nextTick();
  assert.equal(wrapper.titleCalls, undefined);
});

test("auto-titling never touches resumed sessions (new sessions only)", async (t) => {
  isolatedAgentDir(t);
  let emit;
  const wrapper = new TitleSpyWrapper(
    { isAlive: true, onFrame: (listener) => { emit = listener; return () => {}; }, sendCommand: async () => ({}), sendFrame() {}, dispose: async () => {} },
    "/repo", "/repo/sessions/sess.jsonl", false, "sess-id",
  );
  wrapper.start();
  t.after(() => wrapper.destroyAndWait());
  settleFirstRun(emit);
  await nextTick();
  assert.equal(wrapper.titleCalls, undefined);
});

function sessionFileFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-auto-title-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, "s.jsonl");
  writeFileSync(sessionFile, "{}\n");
  return sessionFile;
}

async function waitUntil(predicate) {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate(), "condition not reached");
}

test("a finished turn titles an untitled session in the background, then stops asking", async (t) => {
  const dir = isolatedAgentDir(t);
  writeFileSync(join(dir, "omp-web-settings.json"), JSON.stringify({ autoGenerateSessionTitles: true }), "utf8");
  const sessionFile = sessionFileFixture(t);
  const sent = [];
  let name;
  const { wrapper, emit } = snapshotSession(t, async (command) => {
    sent.push(command.type === "prompt" ? command.message : command.type);
    if (command.type === "generate_title") throw new Error("Unknown command: generate_title");
    if (command.type === "prompt") { name = "Fix the login bug"; return { agentInvoked: false }; }
    if (command.type === "get_state") return { sessionId: "s", sessionFile, isStreaming: false, isCompacting: false, sessionName: name };
    return {};
  }, SnapshotWrapper, "s");
  await wrapper.send({ type: "get_state" });
  const events = [];
  wrapper.onEvent((event) => events.push(event));

  settleFirstRun(emit);
  await waitUntil(() => sent.includes("/rename"));
  assert.equal(wrapper.isRunning(), false, "the background /rename is not a run");
  await waitUntil(() => wrapper._sessionName === "Fix the login bug");
  // The quiet title run leaks nothing to the chat: the only prompt_result is
  // the settle frame above, and a command_output echo never reaches listeners.
  assert.equal(events.filter((event) => event.type === "command_output").length, 0);
  assert.equal(events.filter((event) => event.type === "prompt_result").length, 1);

  sent.length = 0;
  settleFirstRun(emit);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(!sent.includes("/rename") && !sent.includes("generate_title"), "a titled session is not renamed again");
});

test("auto-titling stops after a few turns omp declines to title", async (t) => {
  const dir = isolatedAgentDir(t);
  writeFileSync(join(dir, "omp-web-settings.json"), JSON.stringify({ autoGenerateSessionTitles: true }), "utf8");
  const sessionFile = sessionFileFixture(t);
  const sent = [];
  const { wrapper, emit } = snapshotSession(t, async (command) => {
    sent.push(command.type);
    if (command.type === "get_state") return { sessionId: "s", sessionFile, isStreaming: false, isCompacting: false };
    return {}; // generate_title without a title: omp declined a low-signal opener
  }, SnapshotWrapper, "s");
  await wrapper.send({ type: "get_state" });
  for (let turn = 0; turn < 5; turn++) {
    settleFirstRun(emit);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(sent.filter((type) => type === "generate_title").length, 3);
});

// ── Mid-run auto-titling (TUI parity: name the session DURING its first run,
//    not only after it settles). The gateway generator is mocked at the top of
//    this file; these tests cover the wrapper's timing and apply rules. ──

function resetEarlyTitleMock() {
  earlyTitle.isLowSignal = true;
  earlyTitle.isWeakPointer = false;
  earlyTitle.result = null;
  earlyTitle.gate = null;
  earlyTitle.calls.length = 0;
  earlyTitle.chainOpts = null;
}

const newSessionState = (extra = {}) => ({
  sessionId: "s1", isStreaming: false, isCompacting: false, ...extra,
});

test("the first run names the session mid-run through the gateway generator", async (t) => {
  const dir = isolatedAgentDir(t);
  writeFileSync(join(dir, "omp-web-settings.json"), JSON.stringify({ autoGenerateSessionTitles: true }), "utf8");
  resetEarlyTitleMock();
  earlyTitle.isLowSignal = false;
  earlyTitle.result = { title: "Fix the login bug", model: "@mocked-chain" };
  const sent = [];
  const { wrapper, emit } = snapshotSession(t, async (command) => {
    sent.push(command.type === "prompt" ? command.message : command.type);
    if (command.type === "get_state") {
      return newSessionState({ model: { provider: "anthropic", id: "claude-sonnet" } });
    }
    return {};
  }, SnapshotWrapper, "s1");
  await wrapper.send({ type: "prompt", message: "Fix the login bug in auth.ts" });
  await waitUntil(() => sent.includes("set_session_name"));
  assert.equal(earlyTitle.calls.length, 1);
  assert.equal(earlyTitle.calls[0].text, "Fix the login bug in auth.ts");
  assert.deepEqual(earlyTitle.chainOpts, { sessionModel: "anthropic/claude-sonnet", generator: undefined });
  assert.equal(wrapper._sessionName, "Fix the login bug");
  // The same run settling afterwards must not stack a quiet `/rename` on it.
  sent.length = 0;
  settleFirstRun(emit);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(!sent.includes("/rename"), "a titled session is not renamed again");
});

test("mid-run titling skips low-signal openers and resumed sessions", async (t) => {
  const dir = isolatedAgentDir(t);
  writeFileSync(join(dir, "omp-web-settings.json"), JSON.stringify({ autoGenerateSessionTitles: true }), "utf8");
  resetEarlyTitleMock(); // isLowSignal stays true: the opener names nothing
  const sent = [];
  const { wrapper } = snapshotSession(t, async (command) => {
    sent.push(command.type);
    if (command.type === "get_state") return newSessionState();
    return {};
  }, SnapshotWrapper, "s1");
  await wrapper.send({ type: "prompt", message: "hi" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(earlyTitle.calls.length, 0, "a bare greeting is not worth naming");
  assert.ok(!sent.includes("set_session_name"));

  // A slash prompt is a command: the wand's `/rename` must never be named
  // from its own text by the gateway (it races the real title run). Tested
  // on a FRESH wrapper so the one-shot flag cannot be what stops it.
  earlyTitle.isLowSignal = false; // the content gates are not what stops it
  const slash = snapshotSession(t, async (command) => {
    if (command.type === "get_state") return newSessionState();
    return {};
  }, SnapshotWrapper, "s1");
  await slash.wrapper.send({ type: "prompt", message: "/rename" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(earlyTitle.calls.length, 0, "a slash command is not a task to name");

  // A resumed conversation is never named from its opener.
  const resumed = new SnapshotWrapper(
    { isAlive: true, onFrame: () => () => {}, sendCommand: async () => ({}), sendFrame() {}, dispose: async () => {} },
    "/repo", "/repo/sessions/sess.jsonl", false, "sess-id", undefined, localHost,
  );
  resumed.start();
  t.after(() => resumed.destroyAndWait());
  earlyTitle.isLowSignal = false;
  await resumed.send({ type: "prompt", message: "Fix the login bug in auth.ts" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(earlyTitle.calls.length, 0, "resumed sessions keep only the settle path");
});

test("the settle path waits for an in-flight mid-run attempt, then takes naming over when it fails", async (t) => {
  const dir = isolatedAgentDir(t);
  writeFileSync(join(dir, "omp-web-settings.json"), JSON.stringify({ autoGenerateSessionTitles: true }), "utf8");
  resetEarlyTitleMock();
  earlyTitle.isLowSignal = false;
  let release;
  earlyTitle.gate = new Promise((resolve) => { release = resolve; });
  const sessionFile = sessionFileFixture(t);
  const sent = [];
  let name;
  const { wrapper, emit } = snapshotSession(t, async (command) => {
    sent.push(command.type === "prompt" ? command.message : command.type);
    if (command.type === "generate_title") throw new Error("Unknown command: generate_title");
    if (command.type === "prompt") {
      // Only the quiet `/rename` names the session — the first prompt is the
      // run, so an unchanged-vs-renamed title comparison can tell them apart.
      if (command.message === "/rename") name = "Renamed after settle";
      return { agentInvoked: command.message !== "/rename" };
    }
    if (command.type === "get_state") return { ...newSessionState(), sessionFile, sessionName: name };
    return {};
  }, SnapshotWrapper, "s1");
  // Prime identity like the client's cold-start get_state does (the settle
  // path's file gate needs the handshake's sessionFile).
  await wrapper.send({ type: "get_state" });
  await wrapper.send({ type: "prompt", message: "Fix the login bug in auth.ts" });
  // The run finishes while the generator is still working (the mock is held
  // on `earlyTitle.gate`): the settle hook must not race a second generator.
  settleFirstRun(emit);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(!sent.includes("/rename"), "the settle path waits for the in-flight early attempt");
  release();
  // The early attempt yields nothing — naming hands back to the settle path.
  await waitUntil(() => sent.includes("/rename"));
  await waitUntil(() => wrapper._sessionName === "Renamed after settle");
  assert.equal(earlyTitle.calls.length, 1, "the early attempt ran exactly once");
});

test("a title that arrives elsewhere outranks the mid-run result", async (t) => {
  const dir = isolatedAgentDir(t);
  writeFileSync(join(dir, "omp-web-settings.json"), JSON.stringify({ autoGenerateSessionTitles: true }), "utf8");
  resetEarlyTitleMock();
  earlyTitle.isLowSignal = false;
  earlyTitle.result = { title: "Late generated", model: "@mocked-chain" };
  let release;
  earlyTitle.gate = new Promise((resolve) => { release = resolve; });
  const sent = [];
  const { wrapper, emit } = snapshotSession(t, async (command) => {
    sent.push(command.type);
    if (command.type === "get_state") return newSessionState();
    return {};
  }, SnapshotWrapper, "s1");
  await wrapper.send({ type: "prompt", message: "Fix the login bug in auth.ts" });
  emit({ type: "session_info_update", title: "Named in the terminal" });
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(!sent.includes("set_session_name"), "a name that arrived elsewhere wins");
  assert.equal(wrapper._sessionName, "Named in the terminal");
});

test("mid-run titling stays off when the web setting is off", async (t) => {
  isolatedAgentDir(t); // no settings file — the OFF default must suppress
  resetEarlyTitleMock();
  earlyTitle.isLowSignal = false;
  const { wrapper } = snapshotSession(t, async (command) => {
    if (command.type === "get_state") return newSessionState();
    return {};
  }, SnapshotWrapper, "s1");
  await wrapper.send({ type: "prompt", message: "Fix the login bug in auth.ts" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(earlyTitle.calls.length, 0);
});

test("the first prompt text is captured once for the session-list meta", async (t) => {
  const { wrapper } = snapshotSession(t, async () => ({ ok: true }));
  await wrapper.send({ type: "prompt", message: "Fix the\nsidebar   render" });
  assert.equal(wrapper.firstPrompt, "Fix the sidebar render");
  await wrapper.send({ type: "prompt", message: "second turn" });
  assert.equal(wrapper.firstPrompt, "Fix the sidebar render");
});

// ---------------------------------------------------------------------------
// Wedged-run watchdog: an omp worker can deadlock after its final message and
// never emit the terminal agent_end while still answering get_state with
// isStreaming:true forever (observed on 18.12.6, maintenance routing). The
// wrapper must detect it from frozen PROGRESS, settle a swallowed terminal
// locally, and never auto-restart the child.
// ---------------------------------------------------------------------------

function withFastStallWindows(t) {
  const prev = [process.env.OMP_WEB_STALL_CHECK_MS, process.env.OMP_WEB_STALL_SILENCE_MS];
  process.env.OMP_WEB_STALL_CHECK_MS = "60";
  process.env.OMP_WEB_STALL_SILENCE_MS = "150";
  t.after(() => {
    const [check, silence] = prev;
    if (check === undefined) delete process.env.OMP_WEB_STALL_CHECK_MS; else process.env.OMP_WEB_STALL_CHECK_MS = check;
    if (silence === undefined) delete process.env.OMP_WEB_STALL_SILENCE_MS; else process.env.OMP_WEB_STALL_SILENCE_MS = silence;
  });
}

test("the stall watchdog warns once when a live run goes silent with messageCount frozen, and never restarts the child", async (t) => {
  withFastStallWindows(t);
  const { createJiti } = await import("jiti");
  const { AgentSessionWrapper } = createJiti(import.meta.url)("./rpc-manager.ts");
  const events = [];
  let frameListener = null;
  let disposed = false;
  const fakeProc = {
    isAlive: true,
    onFrame(listener) { frameListener = listener; return () => { frameListener = null; }; },
    async sendCommand(command) {
      if (command.type === "get_state") return { isStreaming: true, isCompacting: false, messageCount: 7, hasPendingAsyncWork: true };
      return {};
    },
    sendFrame: () => {},
    dispose: async () => { disposed = true; },
  };
  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.onEvent((event) => events.push(event));
  wrapper.start();
  t.after(() => wrapper.destroyAndWait());

  frameListener({ type: "agent_start" });
  // Silence window 150ms + two 60ms probe ticks; poll well past the deadline.
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !events.some((e) => e.type === "notice" && e.stall === "suspected")) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const stallNotices = events.filter((e) => e.type === "notice" && e.stall === "suspected");
  assert.equal(stallNotices.length, 1, "a stalled run must be announced exactly once");
  assert.match(stallNotices[0].message, /\/reload/);
  assert.match(stallNotices[0].message, /background work reported pending/);

  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.stalledSuspected, true, "the web state must carry the stall flag");
  assert.equal(wrapper.isRunning(), true, "the watchdog must not fake-settle a child that still claims streaming");
  assert.equal(disposed, false, "the watchdog must never recycle the child by itself");

  // Late child activity proves progress: the flag clears and re-arms.
  frameListener({ type: "message_end", message: { role: "assistant", content: [] } });
  const state2 = await wrapper.send({ type: "get_state" });
  assert.equal(state2.stalledSuspected, false, "child activity must clear the stall suspicion");
  assert.ok(events.some((e) => e.type === "notice" && /resumed/.test(String(e.message))), "resuming progress announces the recovery");
});

test("the stall watchdog completes a run locally when the child says the run ended (swallowed terminal agent_end)", async (t) => {
  withFastStallWindows(t);
  const { createJiti } = await import("jiti");
  const { AgentSessionWrapper } = createJiti(import.meta.url)("./rpc-manager.ts");
  const events = [];
  let frameListener = null;
  const fakeProc = {
    isAlive: true,
    onFrame(listener) { frameListener = listener; return () => { frameListener = null; }; },
    async sendCommand(command) {
      if (command.type === "get_state") return { isStreaming: false, isCompacting: false, messageCount: 5 };
      return {};
    },
    sendFrame: () => {},
    dispose: async () => {},
  };
  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.onEvent((event) => events.push(event));
  wrapper.start();
  t.after(() => wrapper.destroyAndWait());

  frameListener({ type: "agent_start" });
  assert.equal(wrapper.isRunning(), true);
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && wrapper.isRunning()) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(wrapper.isRunning(), false, "a child reporting no run must settle the wrapper-side run");
  const terminal = events.filter((e) => e.type === "agent_end" && e.isTerminal === true);
  assert.equal(terminal.length, 1, "clients must receive the swallowed terminal agent_end exactly once");
});

test("the stall watchdog stays silent while child frames keep arriving (long legitimate tool)", async (t) => {
  withFastStallWindows(t);
  const { createJiti } = await import("jiti");
  const { AgentSessionWrapper } = createJiti(import.meta.url)("./rpc-manager.ts");
  const events = [];
  let frameListener = null;
  let probes = 0;
  const fakeProc = {
    isAlive: true,
    onFrame(listener) { frameListener = listener; return () => { frameListener = null; }; },
    async sendCommand(command) {
      if (command.type === "get_state") { probes += 1; return { isStreaming: true, isCompacting: false, messageCount: 7 }; }
      return {};
    },
    sendFrame: () => {},
    dispose: async () => {},
  };
  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.onEvent((event) => events.push(event));
  wrapper.start();
  t.after(() => wrapper.destroyAndWait());

  frameListener({ type: "agent_start" });
  // Frames every 80ms keep the 150ms silence window perpetually open.
  for (let i = 0; i < 9; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 80));
    frameListener({ type: "tool_execution_update", toolCallId: "t1", partial: { content: [] } });
  }
  assert.equal(events.filter((e) => e.stall === "suspected").length, 0, "steady child progress must never trigger the stall notice");
  assert.equal(probes, 0, "the watchdog must not even probe while frames arrive");
});

test("the stall watchdog disarms on the terminal agent_end and probes nothing after the run", async (t) => {
  withFastStallWindows(t);
  const { createJiti } = await import("jiti");
  const { AgentSessionWrapper } = createJiti(import.meta.url)("./rpc-manager.ts");
  let frameListener = null;
  let probes = 0;
  const fakeProc = {
    isAlive: true,
    onFrame(listener) { frameListener = listener; return () => { frameListener = null; }; },
    async sendCommand(command) {
      if (command.type === "get_state") { probes += 1; return { isStreaming: false, isCompacting: false, messageCount: 9 }; }
      return {};
    },
    sendFrame: () => {},
    dispose: async () => {},
  };
  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.onEvent(() => {});
  wrapper.start();
  t.after(() => wrapper.destroyAndWait());

  frameListener({ type: "agent_start" });
  frameListener({ type: "agent_end", isTerminal: true });
  frameListener({ type: "prompt_result", agentInvoked: true, status: "completed", sessionSettled: true });
  // The completion dispatch may build its payload with its own get_state read
  // (legitimate). The watchdog must add NOTHING after the run disarms: zero
  // the counter once the settle traffic has landed, then watch a quiet window
  // longer than the armed watchdog's silence deadline would allow.
  await new Promise((resolve) => setTimeout(resolve, 100));
  probes = 0;
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(probes, 0, "a settled run must never be probed again (watchdog disarmed with the run)");
});

test("server agent tools are answered by the server, not the browser (#275)", async (t) => {
  // Enable the off-by-default gate via the isolated settings file, and
  // drop the cached settings so this test's gate value is actually read.
  globalThis.__ompWebSettingsCache = undefined;
  const dir = isolatedAgentDir(t);
  const settingsPath = join(dir, "omp-web-settings.json");
  writeFileSync(settingsPath, JSON.stringify({ agentToolsEnabled: true, agentEnv: {} }));
  t.after(() => {
    globalThis.__ompWebSettingsCache = undefined;
    try { rmSync(settingsPath); } catch { /* already gone */ }
  });

  const sentCommands = [];
  const { wrapper, emit, sentFrames } = snapshotSession(
    t,
    async (command) => { sentCommands.push(command); return {}; },
    SnapshotWrapper,
    "agent-source",
  );
  // A UI registration must not drop the server tools (send() merges them).
  await wrapper.send({ type: "set_host_tools", tools: [{ name: "open_url" }] });
  const registration = sentCommands.find((c) => c.type === "set_host_tools");
  assert.ok(registration.tools.some((tool) => tool.name === "list_sessions"));
  assert.ok(registration.tools.some((tool) => tool.name === "send_to_session"));

  // A tab watching this session must NOT receive the call: the server
  // answers it itself, with no browser involved.
  const own = [];
  const detach = wrapper.onEvent((event) => own.push(event));
  emit({ type: "host_tool_call", id: "list-1", toolName: "list_sessions", arguments: {} });
  // The server answers asynchronously (first listAllSessions() pays module init);
  // wait for the answer on a bounded poll — a fixed sleep raced the first read.
  const answeredBy = Date.now() + 2000;
  while (sentFrames.length === 0 && Date.now() < answeredBy) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(own.some((event) => event.type === "host_tool_call"), false);
  assert.equal(sentFrames.length, 1);
  assert.equal(sentFrames[0].id, "list-1");
  assert.equal(sentFrames[0].isError, false);
  assert.deepEqual(JSON.parse(sentFrames[0].result.content[0].text), { sessions: [] });
  detach();
});

test("server agent tools are rejected when the gate is off (#275)", async (t) => {
  globalThis.__ompWebSettingsCache = undefined;
  t.after(() => { globalThis.__ompWebSettingsCache = undefined; });
  const { emit, sentFrames } = snapshotSession(t, undefined, SnapshotWrapper, "agent-source-off");
  emit({ type: "host_tool_call", id: "off-1", toolName: "list_sessions", arguments: {} });
  assert.deepEqual(sentFrames.map((f) => [f.id, f.isError]), [["off-1", true]]);
  assert.match(sentFrames[0].result.content[0].text, /disabled/);
});

test("waitForTurnEnd resolves on terminal agent_end and rejects on timeout (#275)", async (t) => {
  const { wrapper, emit } = snapshotSession(t, undefined, SnapshotWrapper, "waiter");
  const done = wrapper.waitForTurnEnd(1000);
  emit({ type: "agent_end", isTerminal: true });
  await done;
  await assert.rejects(() => wrapper.waitForTurnEnd(20), /Timed out/);
  const promptDone = wrapper.waitForTurnEnd(1000);
  emit({ type: "prompt_result" });
  await promptDone;
});

// ---------------------------------------------------------------------------
// History edit (edit_message) — ported from upstream f7d4066e's wrapper-level
// suite. The fake process is editHarness()'s own multi-listener variant (the
// edit flow subscribes proc.onFrame twice, so the shared single-listener
// snapshotSession fake cannot carry it); asserts on internals the local
// wrapper does not expose (stream snapshots, session caches) are dropped.
// ---------------------------------------------------------------------------


test("MCP toggles run native commands, serialize prompts, and reload only after success", async (t) => {
  let dispatch;
  const commands = [];
  const { wrapper, emit } = snapshotSession(t, async (command) => {
    commands.push(command);
    if (command.type === "prompt") dispatch = () => emit({ type: "command_output", text: 'Server "volatility" disabled (user config).' });
    return {};
  });
  let restarts = 0;
  wrapper.restart = async () => { restarts++; };
  const pending = wrapper.changeMcp("disable", "volatility");
  await Promise.resolve();
  await assert.rejects(wrapper.send({ type: "prompt", message: "ordinary question" }), { code: "session_busy" });
  await assert.rejects(wrapper.changeMcp("enable", "frida"), { code: "session_busy" });
  dispatch();
  await pending;
  assert.equal(restarts, 1);
  assert.deepEqual(commands.filter(c => c.type === "prompt"), [{ type: "prompt", message: "/mcp disable volatility" }]);
  await assert.rejects(wrapper.changeMcp("enable", "bad\n/mcp reload"), /Invalid MCP server name/);
  assert.equal(wrapper.isRunning(), false);
});

test("MCP command errors cannot report success or reload a session", async (t) => {
  let output;
  const { wrapper, emit } = snapshotSession(t, async (command) => {
    if (command.type === "prompt") output = () => emit({ type: "command_output", text: "Failed to enable MCP server: access denied" });
    return {};
  });
  wrapper.restart = async () => { assert.fail("must not restart on failed write"); };
  const pending = wrapper.changeMcp("enable", "volatility");
  await Promise.resolve(); output();
  await assert.rejects(pending, { code: "mcp_change_failed" });
  assert.equal(wrapper.isRunning(), false);
  emit({ type: "agent_start" });
  await assert.rejects(wrapper.changeMcp("disable", "volatility"), { code: "session_busy" });
});

function controlReply(requestId, result) {
  return { type: "extension_ui_request", method: "notify", message: `omp-web-edit:${JSON.stringify({ requestId, ...result })}` };
}

async function drain() {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function editHarness(t, sendCommand, sessionId) {
  const frameListeners = new Set();
  const sentFrames = [];
  const fake = {
    isAlive: true,
    onFrame(listener) { frameListeners.add(listener); return () => frameListeners.delete(listener); },
    sendCommand,
    sendFrame(frame) { sentFrames.push(frame); },
    dispose: async () => {},
  };
  // Wrappers built directly need an online host; the daemon's machine host is one.
  const wrapper = new SnapshotWrapper(fake, process.cwd(), null, false, sessionId, undefined, localHost);
  wrapper.start();
  t.after(() => wrapper.destroyAndWait());
  return {
    wrapper, fake, sentFrames,
    get listenerCount() { return frameListeners.size; },
    emit: (event) => { for (const listener of [...frameListeners]) listener(event); },
  };
}

async function editableSession(t, onEdit) {
  const dir = isolatedAgentDir(t);
  const commands = [];
  const state = {
    sessionId: "edit-same-session", sessionFile: join(dir, "edit-same-session.jsonl"),
    isStreaming: false, isCompacting: false, queuedMessageCount: 0, isSettled: true, hasPendingAsyncWork: false,
  };
  const { promise: started, resolve: didStart } = Promise.withResolvers();
  let harness;
  const baseSend = async (command) => {
    commands.push(command);
    if (command.type === "get_state") return { ...state };
    if (command.type === "get_available_commands") {
      return { commands: [{ name: "omp-web-edit", source: "extension" }, { name: "public-command", source: "extension" }] };
    }
    if (command.type === "prompt" && command.message.startsWith("/omp-web-edit ")) {
      const request = JSON.parse(command.message.slice("/omp-web-edit ".length));
      didStart(request);
      if (onEdit) return onEdit(request, harness);
      harness.emit(controlReply(request.requestId, { sessionId: state.sessionId, cancelled: false, leafId: "edit-marker" }));
      return undefined;
    }
    if (command.type === "branch") return { cancelled: true };
    return {};
  };
  const sendCommandRef = { current: baseSend };
  const base = editHarness(t, (...args) => sendCommandRef.current(...args), state.sessionId);
  harness = {
    ...base,
    get listenerCount() { return base.listenerCount; },
    commands, state, started, dir, sendCommandRef,
  };
  await harness.wrapper.send({ type: "get_state" });
  commands.length = 0;
  return harness;
}

test("a same-ID edit emits one history change and refreshes the sidebar", async (t) => {
  const { subscribeRunningSessions } = await import("./rpc-manager.ts");
  const session = await editableSession(t);
  const { wrapper, emit, state, commands } = session;
  const observed = [[], []];
  for (const events of observed) wrapper.onEvent((event) => events.push(event));
  const running = [];
  t.after(subscribeRunningSessions((update) => running.push(update)));
  const identityChanges = [];
  wrapper.onIdentityChange((...args) => identityChanges.push(args));
  assert.deepEqual(await wrapper.send({ type: "edit_message", entryId: "u2" }), {
    sessionId: state.sessionId, cancelled: false, leafId: "edit-marker",
  });
  assert.equal(wrapper.sessionId, state.sessionId);
  assert.equal(wrapper.sessionFile, state.sessionFile);
  assert.deepEqual(identityChanges, []);
  assert.equal(commands.some((command) => command.type === "branch" || command.type === "new_session"), false);
  for (const events of observed) {
    assert.deepEqual(events.map((event) => ({ type: event.type, leafId: event.leafId })), [{ type: "session_history_changed", leafId: "edit-marker" }]);
  }
  assert.ok(running.some((update) => update.refreshSessionList), "the sidebar is refreshed even though the session ID does not change");
  assert.equal(wrapper.isRunning(), false);
  assert.equal(session.listenerCount, 1, "both Edit listeners leave after completion");
});

for (const cancelled of [false, true]) {
  test(`native no-data prompt acknowledgement retains the edit fence until its correlated result (cancelled=${cancelled})`, async (t) => {
    const session = await editableSession(t, () => {});
    const events = [];
    session.wrapper.onEvent((event) => events.push(event));
    let settled = false;
    const editing = session.wrapper.send({ type: "edit_message", entryId: "u2" });
    void editing.then(() => { settled = true; }, () => { settled = true; });
    const request = await session.started;
    await drain();
    assert.equal(settled, false);
    assert.equal(session.wrapper.isEditingHistory(), true);
    await assert.rejects(session.wrapper.send({ type: "fork", entryId: "u1" }), { code: "session_busy" });
    const result = { sessionId: session.state.sessionId, cancelled, leafId: cancelled ? "original-leaf" : "delayed-marker" };
    session.emit(controlReply(request.requestId, result));
    assert.deepEqual(await editing, result);
    assert.equal(session.wrapper.isEditingHistory(), false);
    assert.equal(session.wrapper.isAlive(), true);
    assert.deepEqual(events.filter((event) => event.type === "session_history_changed").map((event) => event.leafId), cancelled ? [] : ["delayed-marker"]);
  });
}

test("an ownership-moved edit follows native identity aliases and emits one usable history change", async (t) => {
  const session = await editableSession(t, (request, current) => {
    current.state.sessionId = "native-relocated-edit";
    current.state.sessionFile = join(current.dir, "native-relocated-edit.jsonl");
    current.emit({ type: "notice", source: "session-persistence", level: "warning", message: "Session moved to a new file" });
    current.emit(controlReply(request.requestId, { sessionId: current.state.sessionId, cancelled: false, leafId: "relocated-marker" }));
  });
  const { wrapper } = session;
  const oldId = wrapper.sessionId;
  const oldFile = wrapper.sessionFile;
  const changes = [];
  wrapper.onIdentityChange((from, to, options) => changes.push([from, to, options]));
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  assert.deepEqual(await wrapper.send({ type: "edit_message", entryId: "u2" }), {
    sessionId: "native-relocated-edit", cancelled: false, leafId: "relocated-marker",
  });
  assert.notEqual(session.state.sessionFile, oldFile);
  assert.equal(wrapper.sessionId, session.state.sessionId);
  assert.equal(wrapper.sessionFile, session.state.sessionFile);
  assert.deepEqual(changes, [[oldId, session.state.sessionId, { keepOldId: true }]]);
  assert.deepEqual(events.filter((event) => event.type === "session_history_changed").map((event) => event.leafId), ["relocated-marker"]);
  assert.equal(session.commands.some((command) => command.type === "branch" || command.type === "new_session" || command.type === "switch_session"), false);
  assert.equal(wrapper.isEditingHistory(), false);
});

test("cancellation after evidenced native moves preserves the final identity without a history change", async (t) => {
  const session = await editableSession(t, async (request, current) => {
    for (const id of ["first-native-edit-move", "second-native-edit-move"]) {
      current.state.sessionId = id;
      current.state.sessionFile = join(current.dir, `${id}.jsonl`);
      current.emit({ type: "notice", source: "session-persistence", level: "warning", message: "Session moved to a new file" });
      await drain();
    }
    current.emit(controlReply(request.requestId, { sessionId: current.state.sessionId, cancelled: true, leafId: "unchanged-leaf" }));
  });
  const changes = [];
  const events = [];
  session.wrapper.onIdentityChange((...args) => changes.push(args));
  session.wrapper.onEvent((event) => events.push(event));
  assert.deepEqual(await session.wrapper.send({ type: "edit_message", entryId: "u2" }), {
    sessionId: "second-native-edit-move", cancelled: true, leafId: "unchanged-leaf",
  });
  assert.equal(session.wrapper.sessionId, "second-native-edit-move");
  assert.deepEqual(changes.map(([from, to, options]) => [from, to, options?.keepOldId]), [
    ["edit-same-session", "first-native-edit-move", true],
    ["first-native-edit-move", "second-native-edit-move", true],
  ]);
  assert.equal(events.some((event) => event.type === "session_history_changed"), false);
  assert.equal(session.wrapper.isAlive(), true);
});

test("prior native aliases cannot authorize a later unrelated switch during Edit", async (t) => {
  const session = await editableSession(t, (request, current) => {
    current.state.sessionId = "unrelated-after-prior-move";
    current.state.sessionFile = join(current.dir, "unrelated-after-prior-move.jsonl");
    current.emit(controlReply(request.requestId, { sessionId: current.state.sessionId, cancelled: false, leafId: "wrong-leaf" }));
  });
  session.state.sessionId = "previously-moved-edit-session";
  session.state.sessionFile = join(session.dir, "previously-moved-edit-session.jsonl");
  session.emit({ type: "notice", source: "session-persistence", level: "warning", message: "Session moved to a new file" });
  await drain();
  assert.equal(session.wrapper.sessionId, "previously-moved-edit-session");
  const events = [];
  session.wrapper.onEvent((event) => events.push(event));
  await assert.rejects(session.wrapper.send({ type: "edit_message", entryId: "u2" }), { code: "session_changed" });
  assert.equal(events.some((event) => event.type === "session_history_changed"), false);
  assert.equal(session.wrapper.isEditingHistory(), false);
});

for (const cancelled of [false, true]) {
  test(`a changed reply and native state without migration evidence are an unrelated switch (cancelled=${cancelled})`, async (t) => {
    const { wrapper } = await editableSession(t, (request, current) => {
      current.state.sessionId = "unrelated-native-session";
      current.state.sessionFile = join(current.dir, "unrelated-native-session.jsonl");
      current.emit(controlReply(request.requestId, { sessionId: current.state.sessionId, cancelled, leafId: "unrelated-leaf" }));
    });
    const events = [];
    wrapper.onEvent((event) => events.push(event));
    await assert.rejects(wrapper.send({ type: "edit_message", entryId: "u2" }), { code: "session_changed" });
    assert.equal(events.some((event) => event.type === "session_history_changed"), false);
    assert.equal(wrapper.isEditingHistory(), false);
    assert.equal(wrapper.isRunning(), false);
  });
}

test("an input-hook agent invocation fails Edit without clearing the actual run's fence", async (t) => {
  const session = await editableSession(t, (_request, current) => {
    current.state.isSettled = false;
    current.state.isStreaming = true;
    current.emit({ type: "agent_start" });
  });
  const events = [];
  session.wrapper.onEvent((event) => events.push(event));
  await assert.rejects(session.wrapper.send({ type: "edit_message", entryId: "u2" }), /input hook invoked the agent/);
  assert.equal(session.wrapper.isEditingHistory(), false);
  assert.equal(session.wrapper.isRunning(), true, "the native run remains authoritative after edit rejection");
  assert.equal(events.some((event) => event.type === "session_history_changed"), false);
  await assert.rejects(session.wrapper.send({ type: "edit_message", entryId: "u1" }), { code: "session_busy" });
  session.emit({ type: "agent_end", isTerminal: true });
  assert.equal(session.wrapper.isRunning(), false);
});

test("a hook acknowledgement before agent_start stops the child before releasing Edit", async (t) => {
  const { promise: disposal, resolve: finishDisposal } = Promise.withResolvers();
  t.after(finishDisposal);
  const session = await editableSession(t, () => ({ agentInvoked: true }));
  const { promise: disposing, resolve: didDispose } = Promise.withResolvers();
  session.fake.dispose = () => { didDispose(); return disposal; };
  const events = [];
  session.wrapper.onEvent((event) => events.push(event));
  let settled = false;
  const editing = session.wrapper.send({ type: "edit_message", entryId: "u2" });
  void editing.then(() => { settled = true; }, () => { settled = true; });
  const rejection = assert.rejects(editing, /input hook invoked the agent/);
  await disposing;
  assert.equal(settled, false, "Edit must await the actual child exit");
  assert.equal(session.wrapper.isEditingHistory(), true);
  assert.equal(session.wrapper.isAlive(), false, "the child is no longer reusable during shutdown");
  await assert.rejects(session.wrapper.send({ type: "edit_message", entryId: "u1" }), /no longer running/);
  await assert.rejects(session.wrapper.send({ type: "switch_session", sessionPath: "/other.jsonl" }), /no longer running/);
  session.emit({ type: "agent_start" });
  assert.equal(session.wrapper.isRunning(), false, "a deferred start from the disposed child is not admitted");
  assert.equal(events.some((event) => event.type === "agent_start" || event.type === "session_history_changed"), false);
  finishDisposal();
  await rejection;
  assert.equal(session.wrapper.isEditingHistory(), false);
});

for (const errorAt of ["before-reply", "after-reply", "post-state"]) {
  test(`native persistence errors stay visible and defeat success through confirmation (${errorAt})`, async (t) => {
    const notice = { type: "notice", source: "session-persistence", level: "error", message: "Native append failed: permission denied" };
    const session = await editableSession(t, (request, current) => {
      if (errorAt === "before-reply") current.emit(notice);
      current.emit(controlReply(request.requestId, { sessionId: current.state.sessionId, cancelled: false, leafId: "marker" }));
      if (errorAt === "after-reply") current.emit(notice);
    });
    if (errorAt === "post-state") {
      const base = session.sendCommandRef.current;
      let states = 0;
      session.sendCommandRef.current = async (command, ...rest) => {
        if (command.type === "get_state" && ++states === 2) session.emit(notice);
        return base(command, ...rest);
      };
    }
    const events = [];
    session.wrapper.onEvent((event) => events.push(event));
    await assert.rejects(session.wrapper.send({ type: "edit_message", entryId: "u2" }), /Native append failed: permission denied/);
    assert.equal(events.filter((event) => event.type === "notice" && event.message === notice.message).length, 1);
    assert.equal(events.some((event) => event.type === "session_history_changed"), false);
    assert.equal(session.wrapper.isEditingHistory(), false);
    assert.equal(session.wrapper.isRunning(), false);
    assert.equal(session.listenerCount, 1, "only the wrapper's ordinary native listener remains");
    assert.equal(await session.wrapper.send({ type: "prompt", message: "after failed edit" }), null);
  });
}

for (const result of [
  { sessionId: "edit-same-session", cancelled: false, leafId: "marker" },
  { sessionId: "edit-same-session", cancelled: true, leafId: "original-leaf" },
  { error: "navigation hook rejected after append failed" },
]) {
  test(`a persistence notice after no-data ack keeps second mutations fenced until handler completion (${JSON.stringify(result)})`, async (t) => {
    const notice = { type: "notice", source: "session-persistence", level: "error", message: "Native append failed while navigation was suspended" };
    const session = await editableSession(t, () => {});
    const events = [];
    session.wrapper.onEvent((event) => events.push(event));
    let settled = false;
    const editing = session.wrapper.send({ type: "edit_message", entryId: "u2" });
    void editing.then(() => { settled = true; }, () => { settled = true; });
    const rejection = assert.rejects(editing, { message: notice.message });
    const request = await session.started;
    await drain();
    session.emit(notice);
    session.emit(controlReply("unrelated-edit", result));
    await drain();
    assert.equal(settled, false, "a write-error notice cannot finish a suspended navigation handler");
    assert.equal(session.wrapper.isEditingHistory(), true);
    assert.equal(session.listenerCount, 3, "both Edit listeners remain until correlated completion");
    const sentBefore = session.commands.length;
    for (const command of [
      { type: "prompt", message: "another tab after native error" },
      { type: "fork", entryId: "u1" },
      { type: "switch_session", sessionPath: "/other.jsonl" },
    ]) {
      await assert.rejects(session.wrapper.send(command), { code: "session_busy" });
    }
    assert.equal(session.commands.length, sentBefore, "the native error admits no second mutation");
    session.emit(controlReply(request.requestId, result));
    await rejection;
    assert.equal(session.wrapper.isEditingHistory(), false);
    assert.equal(session.wrapper.isAlive(), true, "confirmed handler completion needs no child teardown");
    assert.equal(session.listenerCount, 1, "both Edit listeners leave after correlated completion");
    assert.equal(events.filter((event) => event.type === "notice" && event.message === notice.message).length, 1);
    assert.equal(events.some((event) => event.type === "session_history_changed" || event.type === "extension_ui_request"), false);
    assert.equal(await session.wrapper.send({ type: "prompt", message: "after completed failed edit" }), null);
  });
}

for (const result of [
  { sessionId: "edit-same-session", cancelled: true, leafId: "old-leaf" },
  { error: "The edit target must be a user message" },
]) {
  test(`cancelled/failed edits emit no history mutation and release the fence (${JSON.stringify(result)})`, async (t) => {
    const session = await editableSession(t, (request, current) => current.emit(controlReply(request.requestId, result)));
    const { wrapper } = session;
    const events = [];
    wrapper.onEvent((event) => events.push(event));
    if (result.error) await assert.rejects(wrapper.send({ type: "edit_message", entryId: "u2" }), /target must be a user message/);
    else assert.deepEqual(await wrapper.send({ type: "edit_message", entryId: "u2" }), result);
    assert.deepEqual(events, []);
    assert.equal(wrapper.isRunning(), false);
    assert.equal(session.listenerCount, 1, "cancelled/failed edits remove both operation listeners");
    assert.equal(await wrapper.send({ type: "prompt", message: "a subsequent real prompt" }), null, "the edit fence is released");
  });
}

for (const busyState of [{ isStreaming: true }, { isCompacting: true }, { queuedMessageCount: 1 }, { hasPendingAsyncWork: true }, { isSettled: false }]) {
  test(`authoritative native busy state rejects an edit before any prompt (${JSON.stringify(busyState)})`, async (t) => {
    const { wrapper, commands, state } = await editableSession(t);
    Object.assign(state, busyState);
    assert.equal(wrapper.isRunning(), false, "the wrapper has not seen a native busy event");
    await assert.rejects(wrapper.send({ type: "edit_message", entryId: "u2" }), { code: "session_busy" });
    assert.deepEqual(commands.map((command) => command.type), ["get_state"]);
    assert.equal(wrapper.isRunning(), false);
  });
}

test("an OMP without authoritative settlement cannot edit history", async (t) => {
  const { wrapper, commands, state } = await editableSession(t);
  delete state.isSettled;
  await assert.rejects(wrapper.send({ type: "edit_message", entryId: "u2" }), { code: "session_edit_unsupported" });
  assert.deepEqual(commands.map((command) => command.type), ["get_state"]);
  assert.equal(wrapper.isEditingHistory(), false);
});

for (const entryId of [undefined, null, "", "   ", 7]) {
  test(`invalid edit target IDs never reach OMP (${JSON.stringify(entryId)})`, async (t) => {
    const { wrapper, commands } = await editableSession(t);
    await assert.rejects(wrapper.send({ type: "edit_message", entryId }), { code: "invalid_edit_target" });
    assert.deepEqual(commands, []);
    assert.equal(wrapper.isRunning(), false);
  });
}

test("an edit fences prompts and history changes from every client until its correlated result", async (t) => {
  const { promise: gate, resolve: release } = Promise.withResolvers();
  const session = await editableSession(t, async (request, current) => {
    await gate;
    current.emit(controlReply(request.requestId, { sessionId: current.state.sessionId, cancelled: false, leafId: "marker" }));
  });
  const editing = session.wrapper.send({ type: "edit_message", entryId: "u2" });
  await session.started;
  assert.equal(session.wrapper.isEditingHistory(), true);
  assert.equal(session.wrapper.isRunning(), false, "local edits must not be resumed as interrupted model turns");
  const fenced = [
    { type: "edit_message", entryId: "u1" },
    { type: "prompt", message: "another tab" },
    { type: "steer", message: "steer" },
    { type: "follow_up", message: "queued" },
    { type: "fork", entryId: "u1" },
    { type: "new_session" }, { type: "switch_session", sessionPath: "/other.jsonl" },
    { type: "compact" }, { type: "reload" }, { type: "bash", command: "echo hi" },
    { type: "abort_and_prompt", message: "replace" }, { type: "abort" },
    { type: "set_session_name", name: "rename" }, { type: "set_model", provider: "x", modelId: "y" },
    { type: "remove_queued_message", messageId: "queued" },
  ];
  const sentBefore = session.commands.length;
  for (const command of fenced) await assert.rejects(session.wrapper.send(command), { code: "session_busy" });
  await assert.rejects(session.wrapper.getMcpList(), { code: "session_busy" });
  await assert.rejects(session.wrapper.generateTitle(), { code: "session_busy" });
  assert.equal(session.commands.length, sentBefore, "no fenced mutation reaches the shared child");
  await session.wrapper.send({ type: "get_state" });
  await session.wrapper.send({ type: "get_messages" });
  await session.wrapper.send({ type: "extension_ui_response", id: "navigation-hook-dialog", cancelled: true });
  assert.equal(session.sentFrames.at(-1).id, "navigation-hook-dialog", "navigation hooks may still receive dialog answers");
  release();
  assert.equal((await editing).leafId, "marker");
  assert.equal(await session.wrapper.send({ type: "prompt", message: "after edit" }), null);
});

test("the mutation fence is acquired before the edit's native-state preflight can resolve", async (t) => {
  const { wrapper, state, commands, sendCommandRef } = await editableSession(t);
  const original = sendCommandRef.current;
  const { promise: gate, resolve: release } = Promise.withResolvers();
  let preflight = true;
  sendCommandRef.current = async (command, ...rest) => {
    if (command.type === "get_state" && preflight) { preflight = false; await gate; }
    return original(command, ...rest);
  };
  const editing = wrapper.send({ type: "edit_message", entryId: "u2" });
  await assert.rejects(wrapper.send({ type: "prompt", message: "racing preflight" }), { code: "session_busy" });
  await assert.rejects(wrapper.send({ type: "fork", entryId: "u1" }), { code: "session_busy" });
  assert.deepEqual(commands, []);
  release();
  assert.equal((await editing).sessionId, state.sessionId);
});

test("a pending Fork prevents an edit, while independent Fork retains its native branch contract", async (t) => {
  const { wrapper, commands, sendCommandRef } = await editableSession(t);
  const original = sendCommandRef.current;
  const { promise: gate, resolve: release } = Promise.withResolvers();
  sendCommandRef.current = async (command, ...rest) => command.type === "branch" ? gate : original(command, ...rest);
  const forking = wrapper.send({ type: "fork", entryId: "u2" });
  await assert.rejects(wrapper.send({ type: "edit_message", entryId: "u2" }), { code: "session_busy" });
  assert.equal(commands.some((command) => command.type === "get_available_commands" || command.type === "prompt"), false);
  release({ cancelled: true });
  assert.deepEqual(await forking, { cancelled: true });
  sendCommandRef.current = original;
  assert.equal((await wrapper.send({ type: "edit_message", entryId: "u2" })).cancelled, false);
});

test("independent Fork still sends native branch and returns a new session ID and its editable text", async (t) => {
  const commands = [];
  let sessionId = "original-fork-session";
  const dir = isolatedAgentDir(t);
  const { wrapper } = editHarness(t, async (command) => {
    commands.push(command);
    if (command.type === "branch") {
      sessionId = "new-fork-session";
      return { cancelled: false, text: "the forked prompt" };
    }
    if (command.type === "get_state") return { sessionId, sessionFile: join(dir, `${sessionId}.jsonl`), isStreaming: false, isCompacting: false };
    return {};
  }, sessionId);
  await wrapper.send({ type: "get_state" });
  commands.length = 0;
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  assert.deepEqual(await wrapper.send({ type: "fork", entryId: "u2" }), {
    cancelled: false, newSessionId: "new-fork-session", text: "the forked prompt",
  });
  assert.deepEqual(commands.map((command) => command.type), ["branch", "get_state"]);
  assert.equal(wrapper.sessionId, "new-fork-session");
  assert.equal(events.some((event) => event.type === "session_history_changed"), false);
});

for (const field of ["sessionId", "sessionFile"]) {
  test(`an identity mismatch in ${field} never looks like a successful same-session edit`, async (t) => {
    const { wrapper, state, commands } = await editableSession(t);
    state[field] = "different";
    await assert.rejects(wrapper.send({ type: "edit_message", entryId: "u2" }), { code: "session_changed" });
    assert.deepEqual(commands.map((command) => command.type), ["get_state"]);
  });
}

test("native identity is checked again after navigation rather than trusting the extension's reply alone", async (t) => {
  const { wrapper } = await editableSession(t, (request, current) => {
    current.state.sessionFile = join(current.dir, "unexpected-fork.jsonl");
    current.emit(controlReply(request.requestId, { sessionId: current.state.sessionId, cancelled: false, leafId: "marker" }));
  });
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  await assert.rejects(wrapper.send({ type: "edit_message", entryId: "u2" }), { code: "session_changed" });
  assert.deepEqual(events, []);
  assert.equal(wrapper.isRunning(), false);
});

test("a timed-out navigation disposes the old child before releasing the edit fence", async (t) => {
  const { wrapper, started } = await editableSession(t, () => {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const editing = wrapper.send({ type: "edit_message", entryId: "u2" });
  const rejection = assert.rejects(editing, { code: "session_unresponsive" });
  await started;
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(15_000);
  await rejection;
  assert.equal(wrapper.isAlive(), false);
  assert.equal(wrapper.isRunning(), false);
  await assert.rejects(wrapper.send({ type: "prompt", message: "cannot race a late navigation" }), /no longer running/);
});

for (const timeoutAt of ["prompt-ack", "handler-result"]) {
  test(`a persistence notice cannot release Edit before timed-out child teardown (${timeoutAt})`, async (t) => {
    const { RpcCommandTimeoutError } = await import("./omp/rpc-process.ts");
    const notice = { type: "notice", source: "session-persistence", level: "error", message: "Native append failed before edit handler completion" };
    const { promise: disposal, resolve: finishDisposal } = Promise.withResolvers();
    t.after(finishDisposal);
    const session = await editableSession(t, (_request, current) => {
      if (timeoutAt === "handler-result") return undefined;
      current.emit(notice);
      return new Promise((_, reject) => {
        setTimeout(() => reject(new RpcCommandTimeoutError("prompt", 15_000)), 15_000);
      });
    });
    const { promise: disposing, resolve: didDispose } = Promise.withResolvers();
    session.wrapper.proc.dispose = () => { didDispose(); return disposal; };
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const events = [];
    session.wrapper.onEvent((event) => events.push(event));
    let settled = false;
    const editing = session.wrapper.send({ type: "edit_message", entryId: "u2" });
    void editing.then(() => { settled = true; }, () => { settled = true; });
    const rejection = assert.rejects(editing, { message: notice.message });
    const request = await session.started;
    await new Promise((resolve) => setImmediate(resolve));
    if (timeoutAt === "handler-result") {
      session.emit(notice);
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(settled, false, "the persistence notice does not confirm handler completion");
    assert.equal(session.wrapper.isEditingHistory(), true);
    assert.equal(session.wrapper.isAlive(), true);
    const mutations = [
      { type: "prompt", message: "next mutation" },
      { type: "fork", entryId: "u1" },
      { type: "switch_session", sessionPath: "/other.jsonl" },
    ];
    const sentBefore = session.commands.length;
    for (const command of mutations) await assert.rejects(session.wrapper.send(command), { code: "session_busy" });
    assert.equal(session.commands.length, sentBefore);
    t.mock.timers.tick(15_000);
    await disposing;
    assert.equal(session.wrapper.isEditingHistory(), true);
    assert.equal(settled, false, "the original write error is returned only after the child has stopped");
    assert.equal(session.wrapper.isAlive(), false);
    for (const command of mutations) await assert.rejects(session.wrapper.send(command), /no longer running/);
    session.emit(controlReply(request.requestId, { sessionId: session.state.sessionId, cancelled: false, leafId: "too-late-marker" }));
    session.emit({ type: "agent_start" });
    assert.equal(session.wrapper.isRunning(), false);
    assert.equal(events.some((event) => event.type === "agent_start" || event.type === "session_history_changed"), false);
    assert.equal(events.filter((event) => event.type === "notice" && event.message === notice.message).length, 1);
    finishDisposal();
    await rejection;
    assert.equal(session.wrapper.isEditingHistory(), false);
    assert.equal(session.listenerCount, 0);
  });
}

test("internal edit replies are hidden even when late, but public notices and commands still flow", async (t) => {
  const { wrapper, feed, delivered } = await notifyingSession(t);
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  feed(controlReply("not-pending", { error: "internal failure" }));
  const replay = [];
  wrapper.onEvent((event) => replay.push(event));
  assert.deepEqual(events, []);
  assert.deepEqual(replay, []);
  assert.deepEqual(delivered, []);
  feed({ type: "extension_ui_request", id: "public-notice", method: "notify", message: "Public extension notice", notifyType: "info" });
  assert.equal(events.at(-1).message, "Public extension notice");
  feed({ type: "available_commands_update", commands: [{ name: "omp-web-edit", source: "extension" }, { name: "public-command", source: "extension" }] });
  assert.deepEqual(events.at(-1).commands, [{ name: "public-command", source: "extension" }]);
  const editable = await editableSession(t);
  assert.deepEqual(await editable.wrapper.send({ type: "get_commands" }), {
    commands: [{ name: "public-command", source: "extension" }],
  });
});

test("a timed-out navigation disposes the old child before releasing the edit fence", async (t) => {
  const { wrapper, started } = await editableSession(t, () => {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const editing = wrapper.send({ type: "edit_message", entryId: "u2" });
  const rejection = assert.rejects(editing, { code: "session_unresponsive" });
  await started;
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(15_000);
  await rejection;
  assert.equal(wrapper.isAlive(), false);
  assert.equal(wrapper.isRunning(), false);
  await assert.rejects(wrapper.send({ type: "prompt", message: "cannot race a late navigation" }), /no longer running/);
});

test("initial spawn and reload both keep same-session editing available through the loaded bridge", async (t) => {
  const previousBin = process.env.OMP_WEB_OMP_BIN;
  process.env.OMP_WEB_OMP_BIN = process.execPath;
  t.after(() => {
    if (previousBin === undefined) delete process.env.OMP_WEB_OMP_BIN;
    else process.env.OMP_WEB_OMP_BIN = previousBin;
  });
  const { writeFileSync } = await import("node:fs");
  const dir = isolatedAgentDir(t);
  const sessionId = "edit-spawn-and-reload";
  const sessionFile = join(dir, "edit-spawn-and-reload.jsonl");
  writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: dir }) + "\n");
  t.after(() => rmSync(sessionFile, { force: true }));
  const { SESSION_EDIT_EXTENSION_PATH } = await import("./hosts/local-host.ts");
  const spawns = [];
  let editCount = 0;
  const spawnReplacement = (file, args) => {
    spawns.push({ file, args });
    const extensionIndex = args.lastIndexOf("--extension");
    const bridgeLoaded = extensionIndex >= 0 && args[extensionIndex + 1] === SESSION_EDIT_EXTENSION_PATH;
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill() { queueMicrotask(() => child.emit("exit", 0, null)); return true; },
    });
    let pending = "";
    child.stdin.on("data", (chunk) => {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const command = JSON.parse(line);
        let data = {};
        if (command.type === "get_state") data = { sessionId, sessionFile, isStreaming: false, isCompacting: false, queuedMessageCount: 0, isSettled: true, hasPendingAsyncWork: false };
        if (command.type === "get_available_commands") data = { commands: bridgeLoaded ? [{ name: "omp-web-edit", source: "extension" }] : [] };
        if (command.type === "prompt") {
          assert.equal(bridgeLoaded, true, "an unloaded internal command must not fall through as a model prompt");
          const { requestId } = JSON.parse(command.message.slice("/omp-web-edit ".length));
          const result = controlReply(requestId, { sessionId, cancelled: false, leafId: `spawn-marker-${++editCount}` });
          // Native extension dispatch acknowledges without data; navigation's
          // correlated notification can arrive on a later event-loop turn.
          setImmediate(() => child.stdout.write(JSON.stringify(result) + "\n"));
          data = undefined;
        }
        child.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data }) + "\n");
      }
    });
    child.stdin.on("end", () => queueMicrotask(() => child.emit("exit", 0, null)));
    queueMicrotask(() => child.stdout.write('{"type":"ready"}\n'));
    return child;
  };
  await mockBuiltin(t, "node:child_process", { spawn: spawnReplacement });
  const { startRpcSession } = await import(`./rpc-manager.ts?fresh=${isolatedFresh++}`);
  // The daemon's machine host spawns the (mocked) omp in this process.
  const { localHost: spawningHost } = await import(`./hosts/local-host.ts?fresh=${isolatedFresh++}`);
  const { session, realSessionId } = await startRpcSession(sessionId, sessionFile, dir, undefined, undefined, undefined, undefined, spawningHost);
  t.after(() => session.destroyAndWait());
  const events = [];
  session.onEvent((event) => events.push(event));
  assert.equal(realSessionId, sessionId);
  assert.deepEqual(await session.send({ type: "edit_message", entryId: "u2" }), { sessionId, cancelled: false, leafId: "spawn-marker-1" });
  await session.send({ type: "reload" });
  assert.deepEqual(await session.send({ type: "edit_message", entryId: "u2" }), { sessionId, cancelled: false, leafId: "spawn-marker-2" });
  assert.equal(spawns.length, 2);
  assert.equal(session.sessionId, sessionId);
  assert.equal(session.sessionFile, sessionFile);
  assert.deepEqual(events.filter((event) => event.type === "session_history_changed").map((event) => event.leafId), ["spawn-marker-1", "spawn-marker-2"]);
  assert.equal(events.some((event) => event.type === "extension_ui_request"), false);
  await session.destroyAndWait();
});

test("a resumed session omp moved during startup stays routable by the requested id", async (t) => {
  const requestedId = "startup-move-requested";
  const movedId = "startup-move-forked";
  const newId = "startup-move-new";
  const { dir, current, children } = await startupMoveHarness(t, movedId, newId);
  const requestedFile = join(dir, `${requestedId}.jsonl`);
  const { startRpcSession, getRpcSession } = await import(`./rpc-manager.ts?fresh=${isolatedFresh++}`);
  // This machine is reached through its daemon; spawn the scripted child directly.
  const { localHost: stdioHost } = await import(`./hosts/local-host.ts?fresh=${isolatedFresh++}`);
  const { session, realSessionId } = await startRpcSession(requestedId, requestedFile, dir, undefined, undefined, null, undefined, stdioHost);
  t.after(() => session.destroyAndWait());
  assert.equal(realSessionId, movedId);
  assert.equal(getRpcSession(movedId), session);
  assert.equal(getRpcSession(requestedId), session, "a client holding the requested id must still reach the wrapper");
  // A new conversation on the same wrapper must not stay reachable under the startup alias.
  await session.send({ type: "new_session" });
  assert.equal(current.sessionId, newId);
  assert.equal(getRpcSession(newId), session);
  assert.equal(getRpcSession(requestedId), undefined, "the startup alias names the old conversation");
  assert.equal(getRpcSession(movedId), undefined);
  await session.destroyAndWait();
  assert.equal(getRpcSession(newId), undefined);
  assert.equal(children.length, 1);
});

test("a tab still on the id omp moved away from during startup counts as viewing the conversation", async (t) => {
  const requestedId = "startup-move-viewed";
  const { dir, children } = await startupMoveHarness(t, "startup-move-viewed-fork", "startup-move-viewed-new");
  const { delivered, restore } = await reachableTab();
  const { startRpcSession } = await import(`./rpc-manager.ts?fresh=${isolatedFresh++}`);
  const { localHost: stdioHost } = await import(`./hosts/local-host.ts?fresh=${isolatedFresh++}`);
  const { session } = await startRpcSession(requestedId, join(dir, `${requestedId}.jsonl`), dir, undefined, undefined, null, undefined, stdioHost);
  t.after(async () => {
    await session.destroyAndWait();
    restore();
  });
  globalThis.__ompNotificationHub.presence.set("tab-0001", {
    clientId: "tab-0001", deviceId: "desk-0001", visible: true, sessionId: requestedId, seq: 1, lastSeen: Date.now(),
  });
  for (const type of ["agent_start", "session_settled"]) children[0].stdout.write(JSON.stringify({ type }) + "\n");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(delivered, [], "a visible tab on the requested id is watching this run");
});

/**
 * Fake omp children for `startRpcSession`: the first `get_state` already reports the forked
 * identity (omp moved the resumed session during startup) and `new_session` switches `current`.
 * Import rpc-manager and local-host fresh afterwards so they bind the fake spawn.
 */
async function startupMoveHarness(t, movedId, newId) {
  const dir = isolatedAgentDir(t);
  const previousBin = process.env.OMP_WEB_OMP_BIN;
  process.env.OMP_WEB_OMP_BIN = process.execPath;
  const current = { sessionId: movedId, sessionFile: join(dir, `${movedId}.jsonl`) };
  const children = [];
  const spawnMoved = () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill() { queueMicrotask(() => child.emit("exit", 0, null)); return true; },
    });
    children.push(child);
    let pending = "";
    child.stdin.on("data", (chunk) => {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const command = JSON.parse(line);
        if (command.type === "new_session") Object.assign(current, { sessionId: newId, sessionFile: join(dir, `${newId}.jsonl`) });
        const data = command.type === "get_state"
          ? { ...current, isStreaming: false, isCompacting: false }
          : {};
        child.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data }) + "\n");
      }
    });
    child.stdin.on("end", () => queueMicrotask(() => child.emit("exit", 0, null)));
    queueMicrotask(() => child.stdout.write('{"type":"ready"}\n'));
    return child;
  };
  await mockBuiltin(t, "node:child_process", { spawn: spawnMoved });
  t.after(() => {
    if (previousBin === undefined) delete process.env.OMP_WEB_OMP_BIN;
    else process.env.OMP_WEB_OMP_BIN = previousBin;
  });
  return { dir, current, children };
}

test("independent Fork still sends native branch and returns a new session ID and its editable text", async (t) => {
  const commands = [];
  let sessionId = "original-fork-session";
  const dir = isolatedAgentDir(t);
  const { wrapper } = snapshotSession(t, async (command) => {
    commands.push(command);
    if (command.type === "branch") {
      sessionId = "new-fork-session";
      return { cancelled: false, text: "the forked prompt" };
    }
    if (command.type === "get_state") return { sessionId, sessionFile: join(dir, `${sessionId}.jsonl`), isStreaming: false, isCompacting: false };
    return {};
  }, SnapshotWrapper, sessionId);
  await wrapper.send({ type: "get_state" });
  commands.length = 0;
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  assert.deepEqual(await wrapper.send({ type: "fork", entryId: "u2" }), {
    cancelled: false, newSessionId: "new-fork-session", text: "the forked prompt",
  });
  assert.deepEqual(commands.map((command) => command.type), ["branch", "get_state"]);
  assert.equal(wrapper.sessionId, "new-fork-session");
  assert.equal(events.some((event) => event.type === "session_history_changed"), false);
});
test("server agent tools are answered by the server, not the browser (#275)", async (t) => {
  // Enable the off-by-default gate via the isolated settings file, and
  // drop the cached settings so this test's gate value is actually read.
  globalThis.__ompWebSettingsCache = undefined;
  const dir = isolatedAgentDir(t);
  const settingsPath = join(dir, "omp-web-settings.json");
  writeFileSync(settingsPath, JSON.stringify({ agentToolsEnabled: true, agentEnv: {} }));
  t.after(() => {
    globalThis.__ompWebSettingsCache = undefined;
    try { rmSync(settingsPath); } catch { /* already gone */ }
  });

  const sentCommands = [];
  const { wrapper, emit, sentFrames } = snapshotSession(
    t,
    async (command) => { sentCommands.push(command); return {}; },
    SnapshotWrapper,
    "agent-source",
  );
  // A UI registration must not drop the server tools (send() merges them).
  await wrapper.send({ type: "set_host_tools", tools: [{ name: "open_url" }] });
  const registration = sentCommands.find((c) => c.type === "set_host_tools");
  assert.ok(registration.tools.some((tool) => tool.name === "list_sessions"));
  assert.ok(registration.tools.some((tool) => tool.name === "send_to_session"));

  // A tab watching this session must NOT receive the call: the server
  // answers it itself, with no browser involved.
  const own = [];
  const detach = wrapper.onEvent((event) => own.push(event));
  emit({ type: "host_tool_call", id: "list-1", toolName: "list_sessions", arguments: {} });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(own.some((event) => event.type === "host_tool_call"), false);
  assert.equal(sentFrames.length, 1);
  assert.equal(sentFrames[0].id, "list-1");
  assert.equal(sentFrames[0].isError, false);
  assert.deepEqual(JSON.parse(sentFrames[0].result.content[0].text), { sessions: [] });
  detach();
});

test("server agent tools are rejected when the gate is off (#275)", async (t) => {
  globalThis.__ompWebSettingsCache = undefined;
  t.after(() => { globalThis.__ompWebSettingsCache = undefined; });
  const { emit, sentFrames } = snapshotSession(t, undefined, SnapshotWrapper, "agent-source-off");
  emit({ type: "host_tool_call", id: "off-1", toolName: "list_sessions", arguments: {} });
  assert.deepEqual(sentFrames.map((f) => [f.id, f.isError]), [["off-1", true]]);
  assert.match(sentFrames[0].result.content[0].text, /disabled/);
});

test("waitForTurnEnd resolves on terminal agent_end and rejects on timeout (#275)", async (t) => {
  const { wrapper, emit } = snapshotSession(t, undefined, SnapshotWrapper, "waiter");
  const done = wrapper.waitForTurnEnd(1000);
  emit({ type: "agent_end", isTerminal: true });
  await done;
  await assert.rejects(() => wrapper.waitForTurnEnd(20), /Timed out/);
  const promptDone = wrapper.waitForTurnEnd(1000);
  emit({ type: "prompt_result" });
  await promptDone;
});

test("wrapper spawns through its host", async (t) => {
  const { startRpcSession } = await import("./rpc-manager.ts");
  const requests = [];
  const invalidated = [];
  let emitLine;
  // In-memory child: answers every command and announces readiness.
  const transport = {
    lines: [],
    write(line, callback) {
      const command = JSON.parse(line);
      const data = command.type === "get_state"
        ? { sessionId: "s1-real", sessionFile: "/nonexistent/s1-real.jsonl", isStreaming: false, isCompacting: false }
        : {};
      queueMicrotask(() => emitLine(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data })));
      callback(null);
    },
    onLine(listener) { emitLine = listener; queueMicrotask(() => listener('{"type":"ready"}')); },
    onStderr() {},
    onExit(listener) { this.exit = listener; },
    endInput() { queueMicrotask(() => this.exit?.(0, null)); },
    killTree() { queueMicrotask(() => this.exit?.(null, "SIGTERM")); },
  };
  const fakeHost = {
    id: "fake",
    label: "Fake",
    status: () => "online",
    onStatus: () => () => {},
    async spawnRpc(request) {
      requests.push(request);
      return { transport, cwd: request.cwd, fellBack: false, launchAdvisor: false };
    },
    sessionFileExists: async () => false,
    invalidateSessionLists(sessionFile) { invalidated.push(sessionFile); },
    autoApproveExtension: () => false,
  };
  const { session } = await startRpcSession("s1", "", "/w", undefined, false, null, undefined, fakeHost);
  t.after(() => session.destroyAndWait());
  assert.deepEqual(requests, [{ cwd: "/w", recordedCwd: null, sessionFile: "", toolNames: undefined, advisor: false, spawnModel: undefined }]);
  assert.equal(session.host, fakeHost);
  invalidated.length = 0;
  emitLine(JSON.stringify({ type: "agent_end", isTerminal: true }));
  assert.deepEqual(invalidated, ["/nonexistent/s1-real.jsonl"]);
});

test("reload keeps the live child when its host cannot check the session file", async (t) => {
  const { startRpcSession } = await import("./rpc-manager.ts");
  let emitLine;
  let stopped = false;
  const transport = {
    write(line, callback) {
      const command = JSON.parse(line);
      const data = command.type === "get_state"
        ? { sessionId: "s2-real", sessionFile: "/nonexistent/s2-real.jsonl", isStreaming: false, isCompacting: false }
        : {};
      queueMicrotask(() => emitLine(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data })));
      callback(null);
    },
    onLine(listener) { emitLine = listener; queueMicrotask(() => listener('{"type":"ready"}')); },
    onStderr() {},
    onExit(listener) { this.exit = listener; },
    endInput() { stopped = true; queueMicrotask(() => this.exit?.(0, null)); },
    killTree() { stopped = true; queueMicrotask(() => this.exit?.(null, "SIGTERM")); },
  };
  // The link is up but the host does not answer in time (a 504).
  let unanswered = false;
  const remoteHost = {
    id: "remote",
    label: "Laptop",
    status: () => "online",
    onStatus: () => () => {},
    spawnRpc: async (request) => ({ transport, cwd: request.cwd, fellBack: false, launchAdvisor: false }),
    sessionFileExists: async () => {
      if (unanswered) throw new Error("Laptop did not answer sessionFileExists in time");
      return false;
    },
    invalidateSessionLists() {},
    autoApproveExtension: () => false,
  };
  const { session } = await startRpcSession("s2", "", "/w", undefined, false, null, undefined, remoteHost);
  t.after(() => session.destroyAndWait());
  unanswered = true;
  await assert.rejects(session.send({ type: "reload" }), /Laptop did not answer/);
  assert.equal(stopped, false, "the old child must not be stopped");
  assert.equal(session.isAlive(), true);
  // Still subscribed: the child's frames keep reaching the UI.
  const events = [];
  session.onEvent((event) => events.push(event.type));
  emitLine(JSON.stringify({ type: "agent_start" }));
  assert.deepEqual(events, ["agent_start"]);
  await session.send({ type: "get_state" });
});

test("a session whose host is offline refuses sends with host_offline and reports the link state", async () => {
  const { startRpcSession } = await import("./rpc-manager.ts");
  let emitLine;
  const transport = {
    write(line, callback) {
      const command = JSON.parse(line);
      const data = command.type === "get_state"
        ? { sessionId: "s-offline", sessionFile: "/nonexistent/s-offline.jsonl", isStreaming: false, isCompacting: false }
        : {};
      queueMicrotask(() => emitLine(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data })));
      callback(null);
    },
    onLine(listener) { emitLine = listener; queueMicrotask(() => listener('{"type":"ready"}')); },
    onStderr() {},
    onExit(listener) { this.exit = listener; },
    endInput() { queueMicrotask(() => this.exit?.(0, null)); },
    killTree() { queueMicrotask(() => this.exit?.(null, "SIGTERM")); },
  };
  let status = "online";
  const statusListeners = new Set();
  const remoteHost = {
    id: "laptop",
    label: "Laptop",
    status: () => status,
    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    spawnRpc: async (request) => ({ transport, cwd: request.cwd, fellBack: false, launchAdvisor: false }),
    sessionFileExists: async () => false,
    invalidateSessionLists() {},
    autoApproveExtension: () => false,
  };
  const { session } = await startRpcSession("s-offline", "", "/w", undefined, false, null, undefined, remoteHost);
  const events = [];
  session.onEvent((event) => events.push(event));
  status = "offline";
  for (const listener of statusListeners) listener("offline");
  await assert.rejects(session.send({ type: "prompt", message: "hi" }), (error) => {
    assert.equal(error.code, "host_offline");
    assert.match(error.message, /^Laptop is offline/);
    assert.equal(error.delivery, "refused", "checked before anything was sent");
    return true;
  });
  assert.equal(session.isAlive(), true, "a down link is not an exited child");
  assert.deepEqual(events.filter((event) => event.type === "host_status").map(({ hostId, status }) => ({ hostId, status })), [{ hostId: "laptop", status: "offline" }]);
  await session.destroyAndWait();
  assert.equal(statusListeners.size, 0, "a destroyed session stops listening to its host");
});

test("a running remote session is listed with its host, so the sidebar groups its placeholder there", async () => {
  const { getRunningRpcSessions, startRpcSession } = await import("./rpc-manager.ts");
  let emitLine;
  const transport = {
    write(line, callback) {
      const command = JSON.parse(line);
      const data = command.type === "get_state" ? { sessionId: "s-remote-run", sessionFile: "/nonexistent/s-remote-run.jsonl", isStreaming: false, isCompacting: false } : {};
      queueMicrotask(() => emitLine(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data })));
      callback(null);
    },
    onLine(listener) { emitLine = listener; queueMicrotask(() => listener('{"type":"ready"}')); },
    onStderr() {},
    onExit(listener) { this.exit = listener; },
    endInput() { queueMicrotask(() => this.exit?.(0, null)); },
    killTree() { queueMicrotask(() => this.exit?.(null, "SIGTERM")); },
  };
  const remoteHost = {
    id: "laptop",
    label: "Laptop",
    status: () => "online",
    onStatus: () => () => {},
    spawnRpc: async (request) => ({ transport, cwd: request.cwd, fellBack: false, launchAdvisor: false }),
    sessionFileExists: async () => false,
    invalidateSessionLists() {},
    autoApproveExtension: () => false,
  };
  const { session } = await startRpcSession("s-remote-run", "", "/srv/app", undefined, false, null, undefined, remoteHost);
  await session.send({ type: "prompt", message: "hi" });
  assert.deepEqual(getRunningRpcSessions().find((running) => running.id === "s-remote-run"), { id: "s-remote-run", cwd: "/srv/app", hostId: "laptop" });
  await session.destroyAndWait();
});

test("a reload whose host drops while the old child exits fails host_offline and spawns nothing beside it", async () => {
  const { getRpcSession, startRpcSession } = await import("./rpc-manager.ts");
  let emitLine;
  const transport = {
    write(line, callback) {
      const command = JSON.parse(line);
      const data = command.type === "get_state" ? { sessionId: "s-reload-drop", sessionFile: "/nonexistent/s-reload-drop.jsonl", isStreaming: false, isCompacting: false } : {};
      queueMicrotask(() => emitLine(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data })));
      callback(null);
    },
    onLine(listener) { emitLine = listener; queueMicrotask(() => listener('{"type":"ready"}')); },
    onStderr() {},
    onExit(listener) { this.exit = listener; },
    // Behind a dropped link the kill only waits in the outbox: the child exits when the link returns.
    endInput() {},
    killTree() {},
  };
  let status = "online";
  const statusListeners = new Set();
  const setStatus = (next) => {
    status = next;
    for (const listener of [...statusListeners]) listener(next);
  };
  let spawns = 0;
  const remoteHost = {
    id: "laptop",
    label: "Laptop",
    status: () => status,
    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    spawnRpc: async (request) => {
      spawns += 1;
      return { transport, cwd: request.cwd, fellBack: false, launchAdvisor: false };
    },
    sessionFileExists: async () => false,
    invalidateSessionLists() {},
    autoApproveExtension: () => false,
  };
  const { session } = await startRpcSession("s-reload-drop", "", "/w", undefined, false, null, undefined, remoteHost);
  const reloading = session.send({ type: "reload" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  setStatus("offline");
  await assert.rejects(reloading, (error) => error.code === "host_offline");
  assert.equal(session.isAlive(), true, "the wrapper outlives the outage");
  setStatus("online");
  // The old child may still run there: nothing may reach it or start beside it.
  await assert.rejects(session.send({ type: "get_state" }), (error) => error.code === "host_offline");
  assert.equal(spawns, 1);
  // Its exit arrives with the link: only now may the next request start a fresh child.
  transport.exit(0, null);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(session.isAlive(), false);
  assert.equal(getRpcSession("s-reload-drop"), undefined);
  assert.equal(spawns, 1);
});

test("a command written before the host link dropped resolves once the link returns", async (t) => {
  const { startRpcSession } = await import("./rpc-manager.ts");
  const hub = await import("./hosts/hub.ts");
  const { linkHost, until } = await import("./hosts/link-driver.test-helper.mjs");
  const timings = { ...hub.linkTimings };
  const link = await linkHost("Flaky box");
  let session;
  t.after(async () => {
    Object.assign(hub.linkTimings, timings);
    // Ends the link, which exits its channels, so the wrapper can finish disposing.
    hub.closeHostLink(link.id);
    await session?.destroyAndWait();
  });

  let ch;
  let holdNextGetState = false;
  let held = null;
  const respond = (command) => JSON.stringify({
    type: "response",
    id: command.id,
    command: command.type,
    success: true,
    data: command.type === "get_state" ? { sessionId: "s-flaky", sessionFile: "/nonexistent/s-flaky.jsonl", isStreaming: false, isCompacting: false } : {},
  });
  // The omp child behind the daemon: answers each command, except one get_state held across the drop.
  const omp = async (message) => {
    if (message.type !== "stdin") return;
    const command = JSON.parse(message.line);
    if (holdNextGetState && command.type === "get_state") {
      holdNextGetState = false;
      held = command;
      return;
    }
    await link.post({ type: "stdout", ch, line: respond(command) });
  };
  const ops = {
    async spawn(args) {
      ch = args.ch;
      await link.post({ type: "stdout", ch, line: '{"type":"ready"}' });
      return { cwd: args.cwd, fellBack: false, launchAdvisor: false, autoApproveExtension: false };
    },
    sessionFileExists: () => false,
    invalidateSessionLists: () => null,
  };
  link.serve(ops, omp);
  ({ session } = await startRpcSession("s-flaky", "", "/w", undefined, false, null, undefined, hub.getHost(link.id)));
  const statuses = [];
  session.onEvent((event) => {
    if (event.type === "host_status") statuses.push(event.status);
  });

  holdNextGetState = true;
  const pending = session.send({ type: "get_state" });
  await until(() => held, "the get_state to reach omp");
  // The link drops with the command applied but unanswered.
  hub.linkTimings.offlineMs = 30;
  await link.post();
  await link.drop();
  await until(() => hub.getHost(link.id).status() === "offline", "the host to go offline");
  hub.linkTimings.offlineMs = timings.offlineMs;

  await link.dial({ channels: [{ ch, sessionId: null, cwd: "/w", pending: [] }] });
  link.serve(ops, omp);
  await link.post({ type: "stdout", ch, line: respond(held) });
  const state = await pending;
  assert.equal(state.sessionId, "s-flaky");
  assert.deepEqual(statuses, ["offline", "online"]);
  assert.equal(session.isAlive(), true);
});

test("a run whose remote child vanished while the link was down resumes on that host", async (t) => {
  const { getRpcSession, startRpcSession } = await import("./rpc-manager.ts");
  const { RESUME_PROMPT } = await import("./session-resume.ts");
  const { saveWebServerSettings } = await import("./web-settings.ts");
  const hub = await import("./hosts/hub.ts");
  const { linkHost, until } = await import("./hosts/link-driver.test-helper.mjs");
  const id = "11111111-2222-4333-8444-777777777777";
  const sessionFile = `/remote/sessions/${id}.jsonl`;
  const timings = { ...hub.linkTimings };
  saveWebServerSettings({ autoResumeSessions: true });
  const link = await linkHost("Rebooting box");
  t.after(async () => {
    saveWebServerSettings({ autoResumeSessions: false });
    Object.assign(hub.linkTimings, timings);
    hub.closeHostLink(link.id);
    await getRpcSession(id)?.destroyAndWait();
  });

  const spawns = [];
  const prompts = [];
  const respond = (command) => JSON.stringify({
    type: "response",
    id: command.id,
    command: command.type,
    success: true,
    data: command.type === "get_state" ? { sessionId: id, sessionFile, isStreaming: false, isCompacting: false } : {},
  });
  const omp = async (message) => {
    if (message.type !== "stdin") return;
    const command = JSON.parse(message.line);
    if (command.type === "prompt") prompts.push({ ch: message.ch, message: command.message });
    await link.post({ type: "stdout", ch: message.ch, line: respond(command) });
  };
  const ops = {
    async spawn(args) {
      spawns.push(args);
      await link.post({ type: "stdout", ch: args.ch, line: '{"type":"ready"}' });
      return { cwd: args.cwd, fellBack: false, launchAdvisor: false, autoApproveExtension: false };
    },
    listSessions: () => [{ path: sessionFile, id, cwd: "/w", created: "c", modified: "m", messageCount: 1, firstMessage: "hi" }],
    sessionFileExists: () => true,
    invalidateSessionLists: () => null,
  };
  link.serve(ops, omp);
  const { session } = await startRpcSession(id, sessionFile, "/w", undefined, false, "/w", undefined, hub.getHost(link.id));
  await link.post({ type: "stdout", ch: spawns[0].ch, line: '{"type":"agent_start"}' });
  await until(() => session.isRunning(), "the run to start");

  hub.linkTimings.offlineMs = 30;
  await link.post();
  await link.drop();
  await until(() => hub.getHost(link.id).status() === "offline", "the host to go offline");
  hub.linkTimings.offlineMs = timings.offlineMs;
  // The link returns without the child: it died while the host was unreachable.
  await link.dial({ channels: [] });
  link.serve(ops, omp);
  await until(() => prompts.some((prompt) => prompt.message === RESUME_PROMPT), "the resume prompt");

  assert.equal(session.isAlive(), false);
  assert.equal(spawns.length, 2);
  assert.deepEqual([spawns[1].sessionFile, spawns[1].recordedCwd], [sessionFile, "/w"]);
  assert.equal(prompts.find((prompt) => prompt.message === RESUME_PROMPT).ch, spawns[1].ch);
  assert.equal(getRpcSession(id).isAlive(), true);
});

/** The omp child behind a LinkDriver: answers every command on its channel. */
function ompOverLink(link, sessionId, sessionFile = `/nonexistent/${sessionId}.jsonl`) {
  return async (message) => {
    if (message.type !== "stdin") return;
    const command = JSON.parse(message.line);
    const data = command.type === "get_state" ? { sessionId, sessionFile, isStreaming: false, isCompacting: false, isSettled: true, queuedMessageCount: 0 } : {};
    await link.post({ type: "stdout", ch: message.ch, line: JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data }) });
  };
}

function spawnOverLink(link, spawns = []) {
  return {
    async spawn(args) {
      spawns.push(args);
      await link.post({ type: "stdout", ch: args.ch, line: '{"type":"ready"}' });
      return { cwd: args.cwd, fellBack: false, launchAdvisor: false, autoApproveExtension: false };
    },
    sessionFileExists: () => true,
    invalidateSessionLists: () => null,
  };
}

test("a session the host still runs an orphan child for spawns only after the orphan exits", async (t) => {
  const { startRpcSession } = await import("./rpc-manager.ts");
  const hub = await import("./hosts/hub.ts");
  const { linkHost } = await import("./hosts/link-driver.test-helper.mjs");
  const id = "11111111-2222-4333-8444-888888888888";
  const sessionFile = `/remote/sessions/${id}.jsonl`;
  // This server restarted while the host kept running the session's child (one it cannot adopt: no replay listed).
  const link = await linkHost("Survivor box", { channels: [{ ch: "orphan", sessionId: id, cwd: "/w", pending: null }] });
  let session;
  t.after(async () => {
    hub.closeHostLink(link.id);
    await session?.destroyAndWait();
  });
  const spawns = [];
  link.serve(spawnOverLink(link, spawns), ompOverLink(link, id, sessionFile));
  const starting = startRpcSession(id, sessionFile, "/w", undefined, false, "/w", undefined, hub.getHost(link.id));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(spawns.length, 0, "no second child while the orphan may still write the file");
  await link.post({ type: "exit", ch: "orphan", code: null, signal: "SIGTERM" });
  ({ session } = await starting);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].sessionFile, sessionFile);
});

test("a prompt whose ack is lost to a quiet link answers host_offline and keeps the child", async (t) => {
  const { startRpcSession } = await import("./rpc-manager.ts");
  const hub = await import("./hosts/hub.ts");
  const { linkHost } = await import("./hosts/link-driver.test-helper.mjs");
  const link = await linkHost("Lidded laptop");
  let session;
  t.after(async () => {
    hub.closeHostLink(link.id);
    await session?.destroyAndWait();
  });
  const kills = [];
  const promptSent = Promise.withResolvers();
  const answer = ompOverLink(link, "s-lid");
  const omp = async (message) => {
    if (message.type === "kill") kills.push(message);
    // The lid closes as the prompt goes down: it is never acked.
    if (message.type === "stdin" && JSON.parse(message.line).type === "prompt") return promptSent.resolve();
    await answer(message);
  };
  const spawns = [];
  const ops = spawnOverLink(link, spawns);
  link.serve(ops, omp);
  ({ session } = await startRpcSession("s-lid", "", "/w", undefined, false, null, undefined, hub.getHost(link.id)));

  // Real timings: the prompt ack timeout and the offline window are both 30 s,
  // so the ack times out as (or before) the host is marked offline.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const sending = session.send({ type: "prompt", message: "hi" });
  await promptSent.promise;
  t.mock.timers.tick(30_000);
  // The frame left before the link went quiet: it may still run there.
  await assert.rejects(sending, (error) => error.code === "host_offline" && error.delivery === "unknown");
  t.mock.timers.reset();
  assert.deepEqual(kills, [], "the child is not recycled");
  assert.equal(session.isAlive(), true);

  // The lid opens: the daemon redials with the child still running.
  await link.drop();
  await link.dial({ channels: [{ ch: spawns[0].ch, sessionId: null, cwd: "/w", pending: [] }] });
  link.serve(ops, omp);
  assert.equal((await session.send({ type: "get_state" })).sessionId, "s-lid");
  assert.deepEqual(kills, [], "no kill was queued for the reconnect either");
  assert.equal(session.isAlive(), true);
});

test("an edit that times out with no uplink since dispatch answers host_offline and sends no kill", async (t) => {
  const { startRpcSession } = await import("./rpc-manager.ts");
  const hub = await import("./hosts/hub.ts");
  const { linkHost } = await import("./hosts/link-driver.test-helper.mjs");
  const link = await linkHost("Editing box");
  let session;
  t.after(async () => {
    hub.closeHostLink(link.id);
    await session?.destroyAndWait();
  });
  const kills = [];
  const catalogAsked = Promise.withResolvers();
  const answer = ompOverLink(link, "s-edit");
  const omp = async (message) => {
    if (message.type === "kill") kills.push(message);
    // The link drops right after the edit preflight: the catalog request is never answered.
    if (message.type === "stdin" && JSON.parse(message.line).type === "get_available_commands") return catalogAsked.resolve();
    await answer(message);
  };
  link.serve(spawnOverLink(link), omp);
  ({ session } = await startRpcSession("s-edit", "", "/w", undefined, false, null, undefined, hub.getHost(link.id)));

  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const editing = session.send({ type: "edit_message", entryId: "e1" });
  await catalogAsked.promise;
  // EDIT_TIMEOUT_MS: well inside the 30 s offline window, so the host still looks online.
  t.mock.timers.tick(15_000);
  await assert.rejects(editing, (error) => error.code === "host_offline");
  t.mock.timers.reset();
  assert.equal(hub.getHost(link.id).status(), "online");
  assert.deepEqual(kills, [], "the child is not recycled");
  assert.equal(session.isAlive(), true);
});

test("a prompt that times out after the host sent uplink traffic is recycled as before", async (t) => {
  const { startRpcSession } = await import("./rpc-manager.ts");
  const hub = await import("./hosts/hub.ts");
  const { linkHost } = await import("./hosts/link-driver.test-helper.mjs");
  const link = await linkHost("Wedged omp box");
  let session;
  t.after(async () => {
    hub.closeHostLink(link.id);
    await session?.destroyAndWait();
  });
  const kills = [];
  const promptSent = Promise.withResolvers();
  const answer = ompOverLink(link, "s-wedged");
  const omp = async (message) => {
    if (message.type === "kill") {
      kills.push(message);
      return link.post({ type: "exit", ch: message.ch, code: null, signal: "SIGTERM" });
    }
    // omp takes the prompt and never acks it.
    if (message.type === "stdin" && JSON.parse(message.line).type === "prompt") return promptSent.resolve();
    await answer(message);
  };
  link.serve(spawnOverLink(link), omp);
  ({ session } = await startRpcSession("s-wedged", "", "/w", undefined, false, null, undefined, hub.getHost(link.id)));

  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const sending = session.send({ type: "prompt", message: "hi" });
  await promptSent.promise;
  t.mock.timers.tick(1_000);
  // A pong after dispatch: the link is alive, so omp itself is what went quiet.
  await link.post();
  t.mock.timers.tick(29_000);
  await assert.rejects(sending, (error) => error.code === "session_unresponsive");
  t.mock.timers.reset();
  assert.equal(kills.length > 0, true, "the wedged child is recycled");
  assert.equal(session.isAlive(), false);
});

/** A wrapper whose host link starts down; `linkReturns()` brings it back. */
async function wrapperBehindDownLink(sessionId, disconnectDestroyMs) {
  const { AgentSessionWrapper } = await import("./rpc-manager.ts");
  let status = "offline";
  let statusChanged;
  const host = {
    id: "lid",
    label: "Lid",
    status: () => status,
    onStatus(listener) {
      statusChanged = listener;
      return () => {};
    },
    async spawnRpc() {
      throw new Error("not used");
    },
    sessionFileExists: async () => true,
    invalidateSessionLists() {},
    autoApproveExtension: () => false,
  };
  const proc = {
    isAlive: true,
    onFrame: () => () => {},
    sendCommand: async () => ({ sessionId, sessionFile: "", isStreaming: false, isCompacting: false }),
    sendFrame() {},
    dispose: async () => {},
  };
  const wrapper = new AgentSessionWrapper(proc, "/w", null, false, sessionId, disconnectDestroyMs, host);
  wrapper.start();
  return {
    wrapper,
    linkReturns() {
      status = "online";
      statusChanged("online");
    },
  };
}

test("the disconnect reaper waits while the host link is down and runs once it returns", async () => {
  const { until } = await import("./hosts/link-driver.test-helper.mjs");
  const { wrapper, linkReturns } = await wrapperBehindDownLink("s-reap", 20);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(wrapper.isAlive(), true, "a down link is not an abandoned session");
  linkReturns();
  await until(() => !wrapper.isAlive(), "the reaper once the link returns");
});

test("the idle timer waits while the host link is down and runs once it returns", async (t) => {
  await import("./rpc-manager.ts");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  // Reaping off (0): only the idle timer (IDLE_DESTROY_MS, 10 minutes) can dispose it.
  const { wrapper, linkReturns } = await wrapperBehindDownLink("s-idle", 0);
  t.mock.timers.tick(10 * 60 * 1000);
  assert.equal(wrapper.isAlive(), true, "a down link is not an idle session");
  linkReturns();
  t.mock.timers.tick(10 * 60 * 1000);
  assert.equal(wrapper.isAlive(), false);
  t.mock.timers.reset();
});

/** An omp child that answers every command; get_state reports `sessionId`, idle. */
function scriptedTransport(sessionId) {
  const transport = {
    sent: [],
    write(line, callback) {
      const command = JSON.parse(line);
      transport.sent.push(command.type);
      const data = command.type === "get_state" ? { sessionId, sessionFile: `/nonexistent/${sessionId}.jsonl`, isStreaming: false, isCompacting: false } : {};
      queueMicrotask(() => transport.emit(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data })));
      callback(null);
    },
    onLine(listener) {
      transport.emit = listener;
      queueMicrotask(() => listener('{"type":"ready"}'));
    },
    onStderr() {},
    onExit(listener) { transport.exit = listener; },
    endInput() { queueMicrotask(() => transport.exit?.(0, null)); },
    killTree() { queueMicrotask(() => transport.exit?.(null, "SIGTERM")); },
  };
  return transport;
}

/** A host whose link status the test sets; it spawns `transport`. */
function scriptedHost(id, transport) {
  let status = "online";
  const listeners = new Set();
  return {
    id,
    label: id,
    status: () => status,
    onStatus(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setStatus(next) {
      status = next;
      for (const listener of [...listeners]) listener(next);
    },
    spawnRpc: async (request) => ({ transport, cwd: request.cwd, fellBack: false, launchAdvisor: false }),
    sessionFileExists: async () => false,
    invalidateSessionLists() {},
    autoApproveExtension: () => false,
  };
}

/** A running session on `host`; `events` collects the types it emits. */
async function runningRemoteSession(t, sessionId, transport, host) {
  const { startRpcSession } = await import("./rpc-manager.ts");
  const { until } = await import("./hosts/link-driver.test-helper.mjs");
  const { session } = await startRpcSession(sessionId, "", "/w", undefined, false, null, undefined, host);
  t.after(() => session.destroyAndWait());
  const events = [];
  session.onEvent((event) => events.push(event.type));
  transport.emit('{"type":"agent_start"}');
  await until(() => session.isRunning(), "the run to start");
  transport.sent.length = 0;
  return { session, events, until };
}

test("a `!` reply read just before agent_end is deferred even when both arrive in one batch", async (t) => {
  const transport = scriptedTransport("s-bash-batch");
  const autoReply = transport.write;
  let bashId;
  transport.write = (line, callback) => {
    const command = JSON.parse(line);
    if (command.type !== "bash") return autoReply(line, callback);
    bashId = command.id;
    callback(null);
  };
  const { session, until } = await runningRemoteSession(t, "s-bash-batch", transport, scriptedHost("batch-box", transport));
  const reply = session.send({ type: "bash", command: "date" });
  await until(() => bashId, "the bash command to go out");
  // One host-link batch: the reply, then the turn's end, applied in one go.
  transport.emit(JSON.stringify({ type: "response", id: bashId, command: "bash", success: true, data: { output: "x", exitCode: 0, cancelled: false, truncated: false } }));
  transport.emit('{"type":"agent_end","isTerminal":true}');
  assert.equal((await reply).deferred, true);
});

test("a run that ended while the host link was down ends for clients once it returns", async (t) => {
  const transport = scriptedTransport("s-gap");
  const host = scriptedHost("gap-box", transport);
  const { session, events, until } = await runningRemoteSession(t, "s-gap", transport, host);
  // omp's agent_end is lost with the link.
  host.setStatus("offline");
  host.setStatus("online");
  await until(() => events.includes("agent_end"), "the synthesized agent_end");
  assert.ok(transport.sent.includes("get_state"), "the reconnect reconciles with get_state");
  assert.equal(session.isRunning(), false);
});

test("a resync from the host reconciles the session", async (t) => {
  const transport = scriptedTransport("s-resync");
  let resync;
  // Duck-typed like RemoteRpcTransport: no class identity across bundles.
  transport.onResync = (listener) => { resync = listener; };
  const host = scriptedHost("resync-box", transport);
  const { session, events, until } = await runningRemoteSession(t, "s-resync", transport, host);
  assert.equal(typeof resync, "function", "the session listens for resync");
  resync();
  await until(() => events.includes("agent_end"), "the reconcile's agent_end");
  assert.ok(transport.sent.includes("get_state"));
  assert.equal(session.isRunning(), false);
});

test("restartAllRpcSessions restarts only this machine's sessions", async (t) => {
  const { restartAllRpcSessions, startRpcSession } = await import("./rpc-manager.ts");
  const localTransport = scriptedTransport("s-restart-local");
  const remoteTransport = scriptedTransport("s-restart-remote");
  const local = await startRpcSession("s-restart-local", "", "/w", undefined, false, null, undefined, scriptedHost("local", localTransport));
  const remote = await startRpcSession("s-restart-remote", "", "/w", undefined, false, null, undefined, scriptedHost("laptop", remoteTransport));
  t.after(() => remote.session.destroyAndWait());
  await restartAllRpcSessions();
  assert.equal(local.session.isAlive(), false);
  assert.equal(remote.session.isAlive(), true, "an omp update on this machine leaves a remote run alone");
});

test("disposing a session whose host goes offline mid-wait returns instead of waiting for the link", async (t) => {
  const { startRpcSession } = await import("./rpc-manager.ts");
  const transport = scriptedTransport("s-bounded");
  // The kill waits in the link outbox: the child exits only once the link returns.
  transport.endInput = () => {};
  transport.killTree = () => {};
  const host = scriptedHost("bounded-box", transport);
  const { session } = await startRpcSession("s-bounded", "", "/w", undefined, false, null, undefined, host);
  t.after(() => transport.exit?.(null, "SIGTERM"));
  const disposing = session.destroyAndWait();
  host.setStatus("offline");
  let guard;
  await Promise.race([disposing, new Promise((_, reject) => { guard = setTimeout(() => reject(new Error("destroyAndWait waited for the link")), 2_000); })]);
  clearTimeout(guard);
  assert.equal(session.isAlive(), false);
});

test("a resume that failed while its host went offline blocks a retry until its child exits", async (t) => {
  const { startRpcSession } = await import("./rpc-manager.ts");
  const id = "11111111-2222-4333-8444-aaaaaaaaaaaa";
  const sessionFile = `/remote/sessions/${id}.jsonl`;
  const first = scriptedTransport(id);
  // The kill waits in the link outbox: this child exits only when the test says so.
  first.endInput = () => {};
  first.killTree = () => {};
  let firstExited = false;
  const exitFirst = () => {
    if (firstExited) return;
    firstExited = true;
    first.exit(null, "SIGTERM");
  };
  const host = scriptedHost("resume-box", first);
  const answer = first.write;
  first.write = (line, callback) => {
    const command = JSON.parse(line);
    if (command.type !== "get_state") return answer(line, callback);
    // The link drops during the handshake and its get_state fails.
    host.setStatus("offline");
    queueMicrotask(() => first.emit(JSON.stringify({ type: "response", id: command.id, command: "get_state", success: false, error: "link lost" })));
    callback(null);
  };
  const second = scriptedTransport(id);
  const transports = [first, second];
  let spawns = 0;
  host.spawnRpc = async (request) => ({ transport: transports[spawns++], cwd: request.cwd, fellBack: false, launchAdvisor: false });
  let retried;
  t.after(async () => {
    exitFirst();
    await retried?.session.destroyAndWait();
  });

  await assert.rejects(startRpcSession(id, sessionFile, "/w", undefined, false, "/w", undefined, host));
  assert.equal(spawns, 1);
  host.setStatus("online");
  const retry = startRpcSession(id, sessionFile, "/w", undefined, false, "/w", undefined, host);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(spawns, 1, "no second --resume child while the first may still write the session file");
  exitFirst();
  retried = await retry;
  assert.equal(spawns, 2);
  assert.equal(retried.session.isAlive(), true);
});

/**
 * An omp child a previous run of this server spawned: already past `ready`, so
 * it never sends one. It answers every command except `silent` ones (the test
 * answers those with `answer`); get_state reports `sessionId` plus `state`.
 * `held` lines reach the first reader at once. With `exitOnKill: false` a kill
 * waits in the link outbox: the child exits when the test calls `exit`.
 */
function adoptedTransport(sessionId, { state = {}, held = [], silent = [], exitOnKill = true } = {}) {
  const transport = {
    sent: [],
    frames: [],
    kills: 0,
    write(line, callback) {
      const command = JSON.parse(line);
      transport.sent.push(command.type);
      transport.frames.push(command);
      callback(null);
      // Replies to dialogs and host calls are frames, not commands: nothing answers them.
      if (silent.includes(command.type) || command.type.endsWith("_result") || command.type === "extension_ui_response") return;
      transport.answer(command);
    },
    answer(command, reply = {}) {
      const data = command.type === "negotiate_protocol" ? { protocolVersion: 2 }
        : command.type === "get_state" ? { sessionId, sessionFile: `/nonexistent/${sessionId}.jsonl`, isStreaming: false, isCompacting: false, ...state }
          : {};
      queueMicrotask(() => transport.emit(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data, ...reply })));
    },
    onLine(listener) {
      transport.emit = listener;
      for (const line of held) listener(line);
    },
    onStderr() {},
    onExit(listener) { transport.exit = listener; },
    endInput() {
      transport.kills += 1;
      if (exitOnKill) queueMicrotask(() => transport.exit?.(0, null));
    },
    killTree() {
      transport.kills += 1;
      if (exitOnKill) queueMicrotask(() => transport.exit?.(null, "SIGTERM"));
    },
  };
  return transport;
}

function adoptionHost(id, transport) {
  const host = scriptedHost(id, transport);
  host.spawnRpc = async () => {
    throw new Error("adoption must not spawn");
  };
  return host;
}

const hostToolResults = (transport) => transport.frames.filter((frame) => frame.type === "host_tool_result");
/** Frames reach the transport through RpcProcess's write queue. */
const flushWrites = () => new Promise((resolve) => setImmediate(resolve));

test("adoptRpcSession re-syncs a live child with no spawn and no ready wait", async (t) => {
  const { adoptRpcSession, getExitedRpcSession, getRpcSession } = await import("./rpc-manager.ts");
  const id = "11111111-2222-4333-8444-adadadadad01";
  // A crash record from before the restart.
  globalThis.__ompExitedSessions ??= new Map();
  globalThis.__ompExitedSessions.set(id, { id, cwd: "/w", at: Date.now(), code: null, signal: "SIGTERM", detail: "" });
  // This server restarted mid chunk sequence: the tail is dropped, not a protocol error.
  const bytes = Buffer.from(JSON.stringify({ type: "message_update", text: "x".repeat(1024 * 1024) }));
  const tail = { type: "rpc_chunk", chunkId: "lost", index: 3, count: 5, byteLength: bytes.byteLength, data: bytes.subarray(3 * 262144, 4 * 262144).toString("base64") };
  const transport = adoptedTransport(id, { state: { isStreaming: true }, held: [JSON.stringify(tail)] });
  const session = await adoptRpcSession({ host: adoptionHost("adopt-box", transport), transport, sessionId: id, cwd: "/w", replay: [] });
  t.after(() => session.destroyAndWait());

  assert.deepEqual(transport.sent, ["negotiate_protocol", "set_subagent_subscription", "set_ask_dialog", "set_event_filter", "get_state", "get_subagents", "get_btw_history"]);
  assert.equal(session.isRunning(), true, "omp reported a run in progress");
  assert.equal(session.sessionFile, `/nonexistent/${id}.jsonl`);
  assert.equal(getRpcSession(id), session);
  assert.equal(getExitedRpcSession(id), undefined, "the run goes on: no crash record");
  assert.equal(transport.kills, 0);
});

test("an adopted child's open requests come back: an ask for the next tab, a host tool call for an open tab", async (t) => {
  const { adoptRpcSession } = await import("./rpc-manager.ts");
  const id = "11111111-2222-4333-8444-adadadadad02";
  const transport = adoptedTransport(id);
  const calls = [];
  const leave = subscribeHostToolCalls((call) => calls.push(call));
  t.after(leave);
  const ask = { type: "extension_ui_request", id: "q1", method: "ask", questions: [{ id: "q", question: "Pick", options: [{ label: "A" }] }] };
  const call = { type: "host_tool_call", id: "h1", toolName: "open_url", arguments: { url: "https://a.test" } };
  const session = await adoptRpcSession({
    host: adoptionHost("replay-box", transport),
    transport,
    sessionId: id,
    cwd: "/w",
    replay: [JSON.stringify(ask), JSON.stringify(call)],
  });
  t.after(async () => {
    await session.destroyAndWait();
  });

  // Registered with the wrapper the restart lost: routed to the open tab, not rejected.
  assert.deepEqual(calls, [{ sessionId: id, hostId: "replay-box", cwd: "/w", id: "h1", toolName: "open_url", arguments: { url: "https://a.test" } }]);
  await flushWrites();
  assert.deepEqual(hostToolResults(transport), []);
  const events = [];
  session.onEvent((event) => events.push(event));
  assert.deepEqual(events.map((event) => [event.type, event.id]), [["extension_ui_request", "q1"]]);
  assert.equal(session.isRunning(), true, "the run waits on its user");
});

test("with no tab open at hello, host tool calls wait for the first tab to attach until a tab registers its tools", async (t) => {
  const { adoptRpcSession } = await import("./rpc-manager.ts");
  const id = "11111111-2222-4333-8444-adadadadad04";
  const transport = adoptedTransport(id);
  const call = { type: "host_tool_call", id: "h1", toolName: "open_url", arguments: { url: "https://a.test" } };
  const session = await adoptRpcSession({ host: adoptionHost("tabless-box", transport), transport, sessionId: id, cwd: "/w", replay: [JSON.stringify(call)] });
  t.after(() => session.destroyAndWait());
  await flushWrites();
  assert.deepEqual(hostToolResults(transport), [], "not rejected for want of a tab");
  assert.equal(session.isRunning(), true);
  // omp calls again before any tab is back.
  transport.emit(JSON.stringify({ type: "host_tool_call", id: "h2", toolName: "read_clipboard", arguments: {} }));
  await flushWrites();
  assert.deepEqual(hostToolResults(transport), []);

  const first = [];
  session.onEvent((event) => first.push(event));
  assert.deepEqual(first.map((event) => [event.type, event.id]), [["host_tool_call", "h1"], ["host_tool_call", "h2"]]);
  const second = [];
  session.onEvent((event) => second.push(event));
  assert.deepEqual(second, [], "a call reaches one tab only");
  await session.send({ type: "host_tool_result", id: "h1", result: { content: [] } });
  await flushWrites();
  assert.deepEqual(hostToolResults(transport).map((frame) => frame.id), ["h1"]);

  // The tab registers its tools: omp now knows only those.
  await session.send({ type: "set_host_tools", tools: [{ name: "open_url" }] });
  transport.emit(JSON.stringify({ type: "host_tool_call", id: "h3", toolName: "read_clipboard", arguments: {} }));
  await flushWrites();
  assert.deepEqual(hostToolResults(transport).map((frame) => [frame.id, frame.isError]), [["h1", undefined], ["h3", true]]);
  assert.equal(first.some((event) => event.id === "h3"), false);
});

test("a replayed host tool call no tab comes back for is settled after the disconnect window", async (t) => {
  const { adoptRpcSession } = await import("./rpc-manager.ts");
  const id = "11111111-2222-4333-8444-adadadadad05";
  const transport = adoptedTransport(id);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const call = { type: "host_tool_call", id: "h1", toolName: "open_url", arguments: {} };
  const session = await adoptRpcSession({ host: adoptionHost("abandoned-box", transport), transport, sessionId: id, cwd: "/w", replay: [JSON.stringify(call)] });
  t.after(() => session.destroyAndWait());
  t.mock.timers.tick(119_000);
  await flushWrites();
  assert.deepEqual(hostToolResults(transport), []);
  // DISCONNECT_DESTROY_MS.
  t.mock.timers.tick(1_000);
  await flushWrites();
  assert.deepEqual(hostToolResults(transport).map((frame) => [frame.id, frame.isError, frame.result.content[0].text]), [["h1", true, "No omp-web tab reconnected to answer this host tool"]]);
});

test("replayed server agent tools that change things are not run twice; list_sessions is", async (t) => {
  const { adoptRpcSession } = await import("./rpc-manager.ts");
  const { until } = await import("./hosts/link-driver.test-helper.mjs");
  globalThis.__ompWebSettingsCache = undefined;
  const dir = isolatedAgentDir(t);
  const settingsPath = join(dir, "omp-web-settings.json");
  writeFileSync(settingsPath, JSON.stringify({ agentToolsEnabled: true, agentEnv: {} }));
  const id = "11111111-2222-4333-8444-adadadadad06";
  const transport = adoptedTransport(id);
  const replay = [
    { type: "host_tool_call", id: "n1", toolName: "new_session", arguments: { cwd: "/w" } },
    { type: "host_tool_call", id: "s1", toolName: "send_to_session", arguments: { sessionId: "other", message: "hi" } },
    { type: "host_tool_call", id: "l1", toolName: "list_sessions", arguments: {} },
  ].map((call) => JSON.stringify(call));
  const session = await adoptRpcSession({ host: adoptionHost("agent-tools-box", transport), transport, sessionId: id, cwd: "/w", replay });
  t.after(async () => {
    await session.destroyAndWait();
    globalThis.__ompWebSettingsCache = undefined;
    rmSync(settingsPath, { force: true });
  });
  await until(() => hostToolResults(transport).length === 3, "every replayed agent tool answered");
  const unknown = "omp-web restarted while this ran; the outcome is unknown, check with list_sessions before retrying";
  assert.deepEqual(hostToolResults(transport).map((frame) => [frame.id, frame.isError, frame.result.content[0].text === unknown]), [
    ["n1", true, true],
    ["s1", true, true],
    ["l1", false, false],
  ]);
});

test("an agent tool omp called during the adoption handshake is live, not replayed", async (t) => {
  const { adoptRpcSession } = await import("./rpc-manager.ts");
  // The gate is off: a live call gets the gate's answer, a replayed one "outcome unknown".
  globalThis.__ompWebSettingsCache = undefined;
  t.after(() => { globalThis.__ompWebSettingsCache = undefined; });
  const id = "11111111-2222-4333-8444-adadadadad0a";
  const live = { type: "host_tool_call", id: "live1", toolName: "new_session", arguments: { cwd: "/w" } };
  const replayed = { type: "host_tool_call", id: "r1", toolName: "new_session", arguments: { cwd: "/w" } };
  const transport = adoptedTransport(id, { held: [JSON.stringify(live)] });
  const session = await adoptRpcSession({ host: adoptionHost("handshake-tools-box", transport), transport, sessionId: id, cwd: "/w", replay: [JSON.stringify(replayed)] });
  t.after(() => session.destroyAndWait());
  await flushWrites();
  assert.deepEqual(hostToolResults(transport).map((frame) => [frame.id, frame.result.content[0].text.startsWith("omp-web restarted"), /disabled/.test(frame.result.content[0].text)]), [
    ["r1", true, false],
    ["live1", false, true],
  ]);
});

test("an internal turn waiter neither takes an adopted session's parked host calls nor settles them", async (t) => {
  const { adoptRpcSession } = await import("./rpc-manager.ts");
  const id = "11111111-2222-4333-8444-adadadadad0b";
  const transport = adoptedTransport(id);
  const call = { type: "host_tool_call", id: "h1", toolName: "open_url", arguments: {} };
  const session = await adoptRpcSession({ host: adoptionHost("waiter-box", transport), transport, sessionId: id, cwd: "/w", replay: [JSON.stringify(call)] });
  t.after(() => session.destroyAndWait());
  // An agent tool's waited delivery watches the session; no tab does.
  const waiting = session.waitForTurnEnd(5_000);
  transport.emit(JSON.stringify({ type: "host_tool_call", id: "h2", toolName: "open_url", arguments: {} }));
  transport.emit(JSON.stringify({ type: "agent_end", isTerminal: true }));
  await waiting;
  await flushWrites();
  assert.deepEqual(hostToolResults(transport), [], "the waiter leaving settles nothing");

  const tab = [];
  session.onEvent((event) => tab.push(event));
  assert.deepEqual(tab.map((event) => [event.type, event.id]), [["host_tool_call", "h1"], ["host_tool_call", "h2"]]);
});

test("a start during adoption joins it; an adopted child is not replaced over --advisor, and a second child is refused", async (t) => {
  const { adoptRpcSession, getRpcSession, startRpcSession } = await import("./rpc-manager.ts");
  const { until } = await import("./hosts/link-driver.test-helper.mjs");
  const id = "11111111-2222-4333-8444-adadadadad07";
  const sessionFile = `/nonexistent/${id}.jsonl`;
  const transport = adoptedTransport(id, { silent: ["get_state"] });
  const host = adoptionHost("joined-box", transport);
  const adopting = adoptRpcSession({ host, transport, sessionId: id, cwd: "/w", replay: [] });
  await until(() => transport.sent.includes("get_state"), "the adoption's get_state");
  // A tab opens the session meanwhile, with the advisor toggle on.
  const starting = startRpcSession(id, sessionFile, "/w", undefined, true, "/w", undefined, host);
  transport.answer(transport.frames.find((frame) => frame.type === "get_state"));
  const session = await adopting;
  t.after(() => session.destroyAndWait());
  assert.equal((await starting).session, session, "the start joined the adoption");

  const again = await startRpcSession(id, sessionFile, "/w", undefined, true, "/w", undefined, host);
  assert.equal(again.session, session, "an idle adopted child is kept: its --advisor flag is unknown");
  assert.equal(session.isAlive(), true);

  const stray = adoptedTransport(id);
  await assert.rejects(adoptRpcSession({ host, transport: stray, sessionId: id, cwd: "/w", replay: [] }), /already started/);
  assert.equal(stray.kills, 1, "the second child is killed");
  assert.equal(getRpcSession(id), session);
  assert.equal(session.isAlive(), true);
});

test("an adopted child that turns out to run a session another wrapper holds is killed, not registered", async (t) => {
  const { adoptRpcSession, getRpcSession } = await import("./rpc-manager.ts");
  const holderId = "11111111-2222-4333-8444-adadadadad0c";
  const listedId = "11111111-2222-4333-8444-adadadadad0d";
  const first = adoptedTransport(holderId);
  const holder = await adoptRpcSession({ host: adoptionHost("holder-box", first), transport: first, sessionId: holderId, cwd: "/w", replay: [] });
  t.after(() => holder.destroyAndWait());
  // The host listed this child under the session it last reported; omp has switched to the holder's since.
  const stale = adoptedTransport(listedId, { state: { sessionId: holderId } });
  await assert.rejects(
    adoptRpcSession({ host: adoptionHost("stale-box", stale), transport: stale, sessionId: listedId, cwd: "/w", replay: [] }),
    /already started/,
  );
  assert.ok(stale.kills > 0, "the second writer is killed");
  assert.equal(getRpcSession(holderId), holder);
  assert.equal(holder.isAlive(), true);
});

test("an adoption whose get_state times out rejects and kills the child", async (t) => {
  const { adoptRpcSession, getRpcSession } = await import("./rpc-manager.ts");
  const id = "11111111-2222-4333-8444-adadadadad03";
  const transport = adoptedTransport(id, { silent: ["get_state"] });
  const asked = Promise.withResolvers();
  const write = transport.write;
  transport.write = (line, callback) => {
    write(line, callback);
    if (JSON.parse(line).type === "get_state") asked.resolve();
  };
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const adopting = adoptRpcSession({ host: adoptionHost("wedged-adopt-box", transport), transport, sessionId: id, cwd: "/w", replay: [] });
  await asked.promise;
  t.mock.timers.tick(5_000);
  await assert.rejects(adopting, (error) => error.name === "RpcCommandTimeoutError" && error.command === "get_state");
  assert.ok(transport.kills > 0, "the child is killed");
  assert.equal(getRpcSession(id), undefined);
});

test("an adoption that failed while its host went offline blocks a start until its child exits", async (t) => {
  const { adoptRpcSession, getRpcSession, startRpcSession } = await import("./rpc-manager.ts");
  const { until } = await import("./hosts/link-driver.test-helper.mjs");
  const id = "11111111-2222-4333-8444-adadadadad08";
  const sessionFile = `/nonexistent/${id}.jsonl`;
  const transport = adoptedTransport(id, { silent: ["get_state"], exitOnKill: false });
  const host = adoptionHost("dropping-adopt-box", transport);
  let spawns = 0;
  let retried;
  t.after(async () => {
    transport.exit?.(null, "SIGTERM");
    await retried?.session.destroyAndWait();
  });
  const adopting = adoptRpcSession({ host, transport, sessionId: id, cwd: "/w", replay: [] });
  await until(() => transport.sent.includes("get_state"), "the adoption's get_state");
  host.setStatus("offline");
  transport.answer(transport.frames.find((frame) => frame.type === "get_state"), { success: false, error: "link lost" });
  await assert.rejects(adopting, /link lost/);
  assert.equal(getRpcSession(id)?.isAlive(), false, "kept registered while its child may still write the file");

  host.setStatus("online");
  host.spawnRpc = async (request) => {
    spawns += 1;
    return { transport: scriptedTransport(id), cwd: request.cwd, fellBack: false, launchAdvisor: false };
  };
  const retry = startRpcSession(id, sessionFile, "/w", undefined, false, "/w", undefined, host);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(spawns, 0, "no second child while the adopted one may still write the session file");
  transport.exit(null, "SIGTERM");
  retried = await retry;
  assert.equal(spawns, 1);
  assert.equal(retried.session.isAlive(), true);
});

test("an adoption whose output outgrows channelBufferBytes before the replay fails and kills the child", async (t) => {
  const { adoptRpcSession, getRpcSession } = await import("./rpc-manager.ts");
  const { LINK_LIMITS } = await import("./hosts/link-protocol.ts");
  const saved = LINK_LIMITS.channelBufferBytes;
  LINK_LIMITS.channelBufferBytes = 1_000;
  t.after(() => { LINK_LIMITS.channelBufferBytes = saved; });
  const id = "11111111-2222-4333-8444-adadadadad09";
  const transport = adoptedTransport(id, { held: [JSON.stringify({ type: "message_update", text: "x".repeat(2_000) })] });
  await assert.rejects(
    adoptRpcSession({ host: adoptionHost("chatty-adopt-box", transport), transport, sessionId: id, cwd: "/w", replay: [] }),
    /exceeded 1000 bytes/,
  );
  assert.ok(transport.kills > 0, "the child is killed");
  assert.equal(getRpcSession(id), undefined);
});

// omp's delta message updates (set_event_filter messageUpdates "delta", lib/message-delta.ts).
const deltaFixture = (await readFile(new URL("../tests/fixtures/omp-delta-stream.ndjson", import.meta.url), "utf8"))
  .trim().split("\n").map((line) => JSON.parse(line));
/** One recorded assistant message: thinking, text, then a read call with streamed JSON arguments. */
const replyFrames = deltaFixture.filter((frame) => frame.messageId === "msg-2");
const replyEnd = replyFrames.at(-1);
const without = (object, key) => {
  const copy = { ...object };
  delete copy[key];
  return copy;
};
const textDelta = (messageId, contentIndex, delta) => ({ type: "message_update", messageId, message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex, delta } });

/** A wrapper through its startup handshake; `filterReply` answers set_event_filter. */
async function deltaSession(t, filterReply = (command) => ({ events: null, messageUpdates: command.messageUpdates })) {
  const commands = [];
  const frameListeners = new Set();
  const wrapper = new SnapshotWrapper({
    isAlive: true,
    waitReady: async () => ({ type: "ready", protocolVersion: 2 }),
    negotiateProtocol: async () => {},
    onFrame(listener) { frameListeners.add(listener); return () => frameListeners.delete(listener); },
    sendCommand: async (command) => {
      commands.push(command);
      if (command.type === "set_event_filter") return filterReply(command);
      return command.type === "get_state" ? { sessionId: "delta-session", isStreaming: true, isCompacting: false } : {};
    },
    sendFrame: () => {},
    dispose: async () => {},
  }, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();
  t.after(() => wrapper.destroyAndWait());
  await wrapper.waitUntilReady();
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  return {
    wrapper,
    events,
    filters: () => commands.filter((command) => command.type === "set_event_filter").map(({ events: selection, messageUpdates }) => ({ events: selection, messageUpdates })),
    emit: (frame) => { for (const listener of frameListeners) listener(structuredClone(frame)); },
  };
}

test("startup asks omp for delta message updates, and delta frames go out as they came while the snapshot is the whole message", async (t) => {
  const { events, filters, emit, wrapper } = await deltaSession(t);
  assert.deepEqual(filters(), [{ events: null, messageUpdates: "delta" }]);
  const updates = replyFrames.filter((frame) => frame.type === "message_update");
  emit({ type: "agent_start" });
  for (const frame of replyFrames.slice(0, -1)) emit(frame);
  const forwarded = events.filter((event) => event.type === "message_update");
  assert.deepEqual(forwarded.map((event) => without(event, "web")), updates, "deltas reach tabs unchanged");
  const { streamingMessage } = wrapper.getStreamSnapshot();
  const committed = replyEnd.message.content.map((block) => without(block, "intent"));
  assert.deepEqual(streamingMessage.content, committed);
  assert.equal(wrapper.getStreamSnapshot().responseObserved, true, "rebuilt text counts as a response");
  emit(replyEnd);
  assert.equal(wrapper.getStreamSnapshot().streamingMessage, null);
  assert.deepEqual(filters(), [{ events: null, messageUpdates: "delta" }], "nothing to recover");
});

test("a tab that attaches mid-message gets the whole message before the next delta", async (t) => {
  const { emit, wrapper } = await deltaSession(t);
  const toolDelta = replyFrames.findIndex((frame) => frame.assistantMessageEvent?.type === "toolcall_delta");
  for (const frame of replyFrames.slice(0, toolDelta + 2)) emit(frame);
  const seen = [];
  wrapper.onEvent((event) => seen.push(event));
  assert.equal(seen.length, 1);
  const [snapshot] = seen;
  assert.equal(snapshot.type, "message_update");
  assert.equal(snapshot.messageId, "msg-2");
  assert.deepEqual(snapshot.message, wrapper.getStreamSnapshot().streamingMessage);
  assert.deepEqual(snapshot.message.content[2].arguments, { path: "note.txt", i: "Reading" }, "streamed arguments so far");
  assert.equal(snapshot.message.content[2].partialJson, '{"path": "note.txt", "i": "Reading');
  assert.equal(snapshot.web.sequence, wrapper.getStreamSnapshot().cursor.sequence);
  emit(replyFrames[toolDelta + 2]);
  assert.deepEqual(seen.slice(1).map((event) => event.assistantMessageEvent.delta), [" note file"]);
});

test("a delta with no base is held back and omp sends full updates until the message ends", async (t) => {
  const { events, filters, emit, wrapper } = await deltaSession(t);
  emit(textDelta("msg-9", 0, "lost"));
  await settle(0);
  assert.deepEqual(events.filter((event) => event.type === "message_update"), [], "never forward a delta nobody can apply");
  assert.deepEqual(filters().map((filter) => filter.messageUpdates), ["delta", "full"]);
  emit(textDelta("msg-9", 0, "still lost"));
  await settle(0);
  assert.deepEqual(filters().map((filter) => filter.messageUpdates), ["delta", "full"], "one switch per loss");
  const full = { type: "message_update", messageId: "msg-9", message: { role: "assistant", content: [{ type: "text", text: "lost and found" }] }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " found", partial: {} } };
  emit(full);
  assert.equal(events.at(-1).message.content[0].text, "lost and found");
  assert.deepEqual(wrapper.getStreamSnapshot().streamingMessage.content, full.message.content);
  emit({ type: "message_end", messageId: "msg-9", message: { role: "assistant", content: [{ type: "text", text: "lost and found" }] } });
  await settle(0);
  assert.deepEqual(filters().map((filter) => filter.messageUpdates), ["delta", "full", "delta"], "deltas again from the next message");
});

test("frames lost on the host link drop the base: the next delta recovers through full updates", async (t) => {
  const { events, filters, emit, wrapper } = await deltaSession(t);
  for (const frame of replyFrames.slice(0, 4)) emit(frame);
  const before = events.length;
  await wrapper.reconcileAfterGap();
  emit(replyFrames[4]);
  await settle(0);
  assert.equal(events.slice(before).some((event) => event.type === "message_update"), false);
  assert.deepEqual(filters().map((filter) => filter.messageUpdates), ["delta", "full"]);
});

test("an omp that opens blocks without their shell (before 18.13.2) stays on full updates", async (t) => {
  const { filters, emit } = await deltaSession(t);
  emit({ type: "message_start", messageId: "msg-2", message: { role: "assistant", content: [] } });
  emit({ type: "message_update", messageId: "msg-2", message: { role: "assistant" }, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  await settle(0);
  emit({ type: "message_end", messageId: "msg-2", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } });
  await settle(0);
  assert.deepEqual(filters().map((filter) => filter.messageUpdates), ["delta", "full"]);
});

for (const [name, filterReply] of [
  ["rejects set_event_filter", () => { throw new Error("Unknown command: set_event_filter"); }],
  ["ignores messageUpdates", () => ({ events: null })],
]) {
  test(`an omp that ${name} keeps full updates, forwarded as they came`, async (t) => {
    const { events, filters, emit, wrapper } = await deltaSession(t, filterReply);
    assert.equal(wrapper.sessionId, "delta-session");
    const full = { type: "message_update", messageId: "msg-2", message: { role: "assistant", content: [{ type: "text", text: "hi" }] }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi", partial: {} } };
    emit({ type: "message_start", messageId: "msg-2", message: { role: "assistant", content: [] } });
    emit(full);
    emit({ type: "message_end", messageId: "msg-2", message: full.message });
    await settle(0);
    assert.deepEqual(events.filter((event) => event.type === "message_update").map((event) => without(event, "web")), [full]);
    assert.deepEqual(filters().map((filter) => filter.messageUpdates), ["delta"], "asked once, never again");
  });
}

test("an adopted child streaming mid-message recovers its message through full updates", async (t) => {
  const { adoptRpcSession } = await import("./rpc-manager.ts");
  const id = "11111111-2222-4333-8444-adadadadad10";
  // The previous server had this child on deltas; its message started before this server.
  const transport = adoptedTransport(id, { state: { isStreaming: true }, held: [JSON.stringify(textDelta("msg-4", 0, "mid"))] });
  const answer = transport.answer;
  transport.answer = (command, reply) => answer(command, command.type === "set_event_filter" ? { data: { events: null, messageUpdates: command.messageUpdates } } : reply);
  const session = await adoptRpcSession({ host: adoptionHost("delta-adopt-box", transport), transport, sessionId: id, cwd: "/w", replay: [] });
  t.after(() => session.destroyAndWait());
  const events = [];
  session.onEvent((event) => events.push(event));
  await flushWrites();
  assert.deepEqual(transport.frames.filter((frame) => frame.type === "set_event_filter").map((frame) => frame.messageUpdates), ["delta", "full"]);
  assert.equal(session.getStreamSnapshot().streamingMessage, null, "no guessed message");
  transport.emit(JSON.stringify({ type: "message_update", messageId: "msg-4", message: { role: "assistant", content: [{ type: "text", text: "the middle" }] }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "dle", partial: {} } }));
  assert.equal(session.getStreamSnapshot().streamingMessage.content[0].text, "the middle");
  assert.equal(events.at(-1).message.content[0].text, "the middle");
  transport.emit(JSON.stringify({ type: "message_end", messageId: "msg-4", message: { role: "assistant", content: [{ type: "text", text: "the middle." }] } }));
  await flushWrites();
  assert.deepEqual(transport.frames.filter((frame) => frame.type === "set_event_filter").map((frame) => frame.messageUpdates), ["delta", "full", "delta"]);
});

test("a full update never becomes a delta base: a delta after it recovers through full updates", async (t) => {
  const { events, filters, emit, wrapper } = await deltaSession(t);
  // Adopted mid-message: this message only ever had full updates.
  emit({ type: "message_update", messageId: "msg-4", message: { role: "assistant", content: [{ type: "toolCall", id: "c", name: "write", arguments: { path: "a.ts" } }] }, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "x", partial: {} } });
  const before = events.length;
  emit({ type: "message_update", messageId: "msg-4", message: { role: "assistant" }, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '", "content": "hi"}' } });
  await settle(0);
  assert.equal(events.length, before, "not forwarded");
  assert.deepEqual(wrapper.getStreamSnapshot().streamingMessage.content[0].arguments, { path: "a.ts" }, "the arguments are not lost");
  assert.deepEqual(filters().map((filter) => filter.messageUpdates), ["delta", "full"]);
  // A message whose start was seen: a full update ahead of the stream replaces its base too.
  emit({ type: "message_end", messageId: "msg-4", message: { role: "assistant", content: [] } });
  emit({ type: "message_start", messageId: "msg-5", message: { role: "assistant", content: [] } });
  emit({ type: "message_update", messageId: "msg-5", message: { role: "assistant", content: [{ type: "text", text: "Hello world" }] }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello", partial: {} } });
  const ahead = events.length;
  emit(textDelta("msg-5", 0, " world"));
  await settle(0);
  assert.equal(events.length, ahead, "never Hello world world");
});

test("a set_event_filter that fails does not leave deltas dropped: the next lost delta asks again, and the session stays on full", async (t) => {
  let failures = 1;
  const { filters, emit } = await deltaSession(t, (command) => {
    if (command.messageUpdates === "full" && failures-- > 0) throw new Error("omp went away");
    return { events: null, messageUpdates: command.messageUpdates };
  });
  emit(textDelta("msg-9", 0, "lost"));
  await settle(0);
  emit(textDelta("msg-9", 0, "lost again"));
  await settle(0);
  assert.deepEqual(filters().map((filter) => filter.messageUpdates), ["delta", "full", "full"]);
  emit({ type: "message_end", messageId: "msg-9", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
  await settle(0);
  assert.deepEqual(filters().map((filter) => filter.messageUpdates), ["delta", "full", "full"], "no switch back to deltas");
});

test("a delta for a message that already ended has no base", async (t) => {
  const { events, filters, emit } = await deltaSession(t);
  for (const frame of replyFrames) emit(frame);
  const before = events.length;
  emit(textDelta("msg-2", 1, " late"));
  await settle(0);
  assert.equal(events.length, before);
  assert.deepEqual(filters().map((filter) => filter.messageUpdates), ["delta", "full"]);
});
