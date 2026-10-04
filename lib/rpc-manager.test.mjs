import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";
import childProcess from "node:child_process";
import { fileURLToPath } from "node:url";

// rpc-manager.ts drives the user's `omp` binary over NDJSON (lib/omp/rpc-process)
// instead of embedding a Bun-only SDK. Most coverage is source-contract; the
// disconnect-reaper tests below load the real wrapper through jiti.

const runtimeJiti = createJiti(import.meta.url);
const { AgentSessionWrapper: SnapshotWrapper } = runtimeJiti("./rpc-manager.ts");

// Process-boundary fakes exercise the real wrapper without invoking the user's
// installed agent.
function snapshotSession(t, sendCommand = async () => ({}), Wrapper = SnapshotWrapper, sessionId = "", disconnectDestroyMs) {
  let emit;
  const sentFrames = [];
  const wrapper = new Wrapper({
    isAlive: true,
    onFrame(listener) { emit = listener; return () => {}; },
    sendCommand,
    sendFrame(frame) { sentFrames.push(frame); },
    dispose: async () => {},
  }, process.cwd(), null, false, sessionId, ...(disconnectDestroyMs === undefined ? [] : [disconnectDestroyMs]));
  wrapper.start();
  t.after(() => wrapper.destroyAndWait());
  return { wrapper, sentFrames, emit: (event) => emit(event) };
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
  assert.match(source, /this\.pendingHostTools\.set\(id, event\)/);
  assert.match(source, /case "set_host_tools":/);
  assert.match(source, /case "host_tool_result":/);
  // Unregistered tools / no attached listener are settled with an error so
  // the agent turn cannot hang waiting for a response.
  assert.match(source, /type: "host_tool_result"/);
  assert.match(source, /isError: true/);
  // A disconnected UI rejects outstanding host tool calls.
  assert.match(source, /rejectPendingHostTools\(/);
  assert.match(source, /listeners\.length === 0/);
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

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd());
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

test("RPC process cleanup reaps Windows child trees as well as POSIX groups", async () => {
  const source = await readFile(new URL("./omp/rpc-process.ts", import.meta.url), "utf8");
  assert.match(source, /process\.platform === "win32"/);
  assert.match(source, /taskkill/);
  assert.match(source, /process\.kill\(-pid/);
});

test("existing sessions resume deterministically via --resume <file>", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const spawnArgs = source.slice(
    source.indexOf("export function buildSessionSpawnArgs"),
    source.indexOf("function toImageContents"),
  );

  assert.match(spawnArgs, /"--resume", sessionFile/);
  assert.match(spawnArgs, /"--no-tools"/);
  assert.match(spawnArgs, /"--tools"/);
  assert.match(spawnArgs, /if \(advisor\) args\.push\("--advisor"\)/);
  assert.match(spawnArgs, /"--advisor"/);
});

test("pi tool preset names translate to omp builtin names", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

  // omp renamed find->glob and dropped ls (tools/builtin-names.ts).
  assert.match(source, /find: "glob"/);
  assert.match(source, /DROPPED_TOOL_NAMES = new Set\(\["ls"\]\)/);
});

test("commands with no omp equivalent fail with a clear unsupported error", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const unsupported = source.slice(
    source.indexOf("const UNSUPPORTED_COMMANDS"),
    source.indexOf("const TOOL_NAME_ALIASES"),
  );

  for (const command of ["navigate_tree", "clear_queue", "get_tools", "set_tools"]) {
    assert.match(unsupported, new RegExp(`${command}:`));
  }
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

  assert.match(agentStart, /invalidateSessionListCache\(\)/);
  assert.match(agentStart, /refreshSessionList = true/);
  assert.match(source, /notifyRunningChange\(\{ refreshSessionList \}\)/);
  assert.match(source, /snapshot === lastRunningSnapshot && !refreshSessionList/);
});

test("live MCP status uses only OMP's local /mcp list command", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const method = source.slice(source.indexOf("async getMcpList()"), source.indexOf("private buildWebState"));

  assert.match(method, /message: "\/mcp list"/);
  assert.match(method, /mcp_list_timeout/);
  assert.match(source, /case "command_output":/);
  assert.match(source, /Wait for the current run to finish/);
});

test("`!!` shell commands are rejected instead of silently entering context", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const bashCase = source.slice(source.indexOf('case "bash": {'), source.indexOf("default: {"));

  // omp's RPC bash is `{type:"bash", command}` only — there is no exclusion
  // option, so honoring `!!` is impossible and must fail loudly.
  assert.match(bashCase, /command\.excludeFromContext === true/);
  assert.match(bashCase, /WebRpcError\(BASH_EXCLUDE_MESSAGE, "bash_exclude_unsupported"\)/);
  assert.doesNotMatch(bashCase, /excludeFromContext: /);
});

test("auto-compaction results carry the same estimatedTokensAfter as manual compact", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const autoCase = source.slice(
    source.indexOf('case "auto_compaction_end":'),
    source.indexOf('case "session_info_update":'),
  );

  assert.match(autoCase, /patchEstimatedTokensAfter\(event\.result\)/);
  // Both paths must go through the one estimator, not duplicate the formula.
  assert.equal(source.match(/estimatedTokensAfter = Math\.round/g)?.length, 1);
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

    const wrapper = new AgentSessionWrapper(fakeProc, process.cwd());
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

    const wrapper = new AgentSessionWrapper(fakeProc, process.cwd());
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
  const onEvent = source.slice(source.indexOf("onEvent(listener: EventListener)"), source.indexOf("onDestroy(cb:"));

  assert.match(onEvent, /expiresAt !== undefined && expiresAt <= now/);
  assert.match(onEvent, /this\.forgetPendingUiRequest\(id\)/);
  // The expiry also fires on its own so a long-lived session stops holding it.
  assert.match(source, /setTimeout\(\(\) => this\.forgetPendingUiRequest\(id\), timeout\)/);
});

test("restart rejects concurrent commands and disposes a failed replacement", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const restart = source.slice(source.indexOf("private async restart()"), source.indexOf("async send(command"));

  assert.match(restart, /if \(this\.restarting\) throw new WebRpcError\(RESTARTING_MESSAGE, "session_restarting"\)/);
  assert.match(restart, /void proc\.dispose\(\)/);
  // send() must refuse while the child is being swapped out.
  const send = source.slice(source.indexOf("async send(command"), source.indexOf('case "prompt": {'));
  assert.match(send, /if \(this\.restarting\) throw new WebRpcError\(RESTARTING_MESSAGE, "session_restarting"\)/);
});

test("restart restores the subagent event subscription before reading replacement state", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const restart = source.slice(source.indexOf("private async restart()"), source.indexOf("async send(command"));
  const subscription = restart.indexOf('type: "set_subagent_subscription", level: "events"');
  const state = restart.indexOf('type: "get_state"');

  assert.ok(subscription >= 0, "restart must restore subagent subscription");
  assert.ok(state >= 0, "restart must read replacement state");
  assert.ok(subscription < state, "subscription must be restored before replacement state is read");
});

test("resolveSpawnCwd uses the recorded directory when it exists, falls back otherwise", async () => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { resolveSpawnCwd, resolveSpawnCwdResult } = jiti("./rpc-manager.ts");
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
});

test("missing terminal agent_end clears isPromptRunning on raw idle get_state", async () => {
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

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd());
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

test("prompt ack pending does not let raw idle get_state clear promptRunning", async () => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { AgentSessionWrapper } = jiti("./rpc-manager.ts");

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

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd());
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

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd());
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
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { AgentSessionWrapper } = jiti("./rpc-manager.ts");

  let forwarded = false;
  const fakeProc = {
    isAlive: true,
    onFrame: () => () => {},
    sendCommand: async () => { forwarded = true; return {}; },
    sendFrame: () => {},
    dispose: async () => {},
  };

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd());
  wrapper.start();

  await assert.rejects(
    wrapper.send({ type: "abort_and_prompt", message: "Hi", images: [{ type: "text", text: "nope" }] }),
    /Each attachment must be an image/,
  );
  assert.equal(forwarded, false, "an invalid attachment must never reach omp");
  await wrapper.destroyAndWait();
});

test("get_state timeout recycles wrapper and produces session_unresponsive WebRpcError", async () => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { AgentSessionWrapper, WebRpcError } = jiti("./rpc-manager.ts");
  const { RpcCommandTimeoutError } = jiti("./omp/rpc-process.ts");

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

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd());
  wrapper.start();

  await assert.rejects(
    wrapper.send({ type: "get_state" }),
    (err) => {
      assert.ok(err instanceof WebRpcError || err.name === "WebRpcError");
      assert.equal(err.code, "session_unresponsive");
      return true;
    },
  );

  assert.equal(disposed, true);
  assert.equal(wrapper.isAlive(), false);
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

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd());
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
});

test("buildSessionSpawnArgs maps tool presets to spawn flags", async () => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { buildSessionSpawnArgs } = jiti("./rpc-manager.ts");

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

test("unexpected child exit is retained until a replacement session clears it", async (t) => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const {
    AgentSessionWrapper,
    clearExitedRpcSession,
    getExitedRpcSession,
  } = jiti("./rpc-manager.ts");
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

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd());
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
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { AgentSessionWrapper, getExitedRpcSession } = jiti("./rpc-manager.ts");
  globalThis.__ompExitedSessions = new Map();
  t.after(() => { delete globalThis.__ompExitedSessions; });

  const fakeProc = {
    isAlive: true,
    onFrame: () => () => {},
    sendFrame: () => {},
    dispose: async () => {},
  };
  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "resume-before-ready");
  wrapper.start();
  wrapper.handleProcessExit({ code: 1, signal: null, stderrTail: "startup failed" });

  assert.equal(getExitedRpcSession("resume-before-ready").detail, "startup failed");
  await wrapper.destroyAndWait();
});

test("answering a dialog in one tab dismisses it in every other attached tab", async () => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { AgentSessionWrapper } = jiti("./rpc-manager.ts");

  let frameListener = null;
  const sentFrames = [];
  const fakeProc = {
    isAlive: true,
    onFrame(listener) {
      frameListener = listener;
      return () => { frameListener = null; };
    },
    sendCommand: async () => ({
      sessionId: "ask-cancel-session",
      sessionFile: "/tmp/ask-cancel-session.jsonl",
      isStreaming: false,
      isCompacting: false,
    }),
    sendFrame: (frame) => sentFrames.push(frame),
    dispose: async () => {},
  };

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd());
  wrapper.start();

  const other = [];
  wrapper.onEvent((event) => other.push(event));

  frameListener({ type: "extension_ui_request", id: "ask", method: "confirm", title: "Keep going?" });
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

// ----------------------------------------------------------------------------
// Disconnect reaper (DISCONNECT_DESTROY_MS)
//
// These drive the real wrapper through the real timer. The window is injected
// through the constructor's test seam (the 120s default would make every
// assertion here vacuous), and the fake process records dispose() so "the child
// was torn down" is observed directly instead of inferred from isAlive() alone.
// ----------------------------------------------------------------------------

const REAP_MS = 25;
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Long enough that a correct implementation reaps, short enough to stay fast. */
const afterWindow = () => settle(REAP_MS * 8);

function reapedSession(t, sendCommand, windowMs = REAP_MS) {
  const disposed = [];
  const { wrapper, emit } = snapshotSession(t, sendCommand ?? (async () => ({})), SnapshotWrapper, "", windowMs);
  // The fake process is a plain object, so record dispose() instead.
  const proc = wrapper.proc;
  const inner = proc.dispose.bind(proc);
  proc.dispose = async () => { disposed.push(Date.now()); return inner(); };
  return { wrapper, emit, disposed };
}

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
  const { wrapper, disposed } = reapedSession(t);
  const keepAlive = setInterval(() => { void wrapper.send({ type: "get_state" }); }, Math.floor(REAP_MS / 4));
  t.after(() => clearInterval(keepAlive));
  await settle(REAP_MS * 5);
  assert.deepEqual(disposed, [], "traffic keeps pushing the deadline out");
  assert.equal(wrapper.isAlive(), true);

  clearInterval(keepAlive);
  await afterWindow();
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
  const wrapper = new SnapshotWrapper(proc, process.cwd(), null, false, "", REAP_MS);
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
  // timer is what lets `next dev` and a test runner exit. A ref'd one pins a
  // process that has nothing else pending for the full window.
  const moduleUrl = new URL("./rpc-manager.ts", import.meta.url).href;
  const script = `
    import { createJiti } from "jiti";
    const { AgentSessionWrapper } = await createJiti(import.meta.url).import(${JSON.stringify(moduleUrl)});
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
  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd());
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
  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd());
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
