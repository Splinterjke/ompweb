import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// rpc-manager.ts drives the user's `omp` binary over NDJSON (lib/omp/rpc-process)
// instead of embedding a Bun-only SDK. These are source-contract tests (the
// module cannot be imported from .mjs without a TS loader).

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

test("service restart re-prompts only sessions whose agent turn was active", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const snapshot = source.slice(
    source.indexOf("function activeSessionSnapshot"),
    source.indexOf("function persistActiveSessionsForRestart"),
  );
  const restore = source.slice(
    source.indexOf("export async function restoreActiveRpcSessions"),
    source.indexOf("// ----------------------------------------------------------------------------\n// Running-status broadcaster"),
  );

  assert.match(snapshot, /turnActive: session\.hasActiveTurn\(\)/);
  assert.match(source, /hasActiveTurn\(\): boolean/);
  assert.match(source, /this\.promptRunning \|\| this\.streaming/);
  assert.match(restore, /if \(saved\.turnActive\)/);
  assert.match(restore, /type: "prompt", message: INTERRUPTED_TURN_RECOVERY_PROMPT/);
  assert.match(source, /Do not repeat completed side effects/);
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

  // conversation_completed stays bound to the terminal agent_end branch only.
  const agentEnd = source.slice(source.indexOf('case "agent_end":'), source.indexOf('case "prompt_result":'));
  assert.match(agentEnd, /dispatchChatEvent\("conversation_completed"/);
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
    await sleep(300);
    assert.equal(lastRun(), null, "interrupted turn must not dispatch conversation_completed");

    // 2) The next genuine run still dispatches conversation_completed (the
    //    pending-interrupt flag was consumed by the interrupted turn's end).
    await wrapper.send({ type: "prompt", message: "Again" });
    frameListener({ type: "agent_start" });
    await sleep(50);
    frameListener({ type: "agent_end", isTerminal: true });
    const first = lastRun();
    assert.ok(first, "genuine completion must dispatch conversation_completed");

    // 3) A no-op abort (nothing running) must not swallow the next
    //    completion: agent_start clears the stale pending-interrupt flag.
    await wrapper.send({ type: "abort" });
    await wrapper.send({ type: "prompt", message: "Third" });
    frameListener({ type: "agent_start" });
    await sleep(50);
    frameListener({ type: "agent_end", isTerminal: true });
    assert.ok(lastRun() > first, "no-op abort must not suppress the next completion");

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
