import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { mock } from "bun:test";
import test from "node:test";
import { createJiti } from "jiti";

// The mid-run titling unit tests in rpc-manager.test.mjs run against a
// duck-typed proc; this one drives the SAME wrapper through the real
// RpcProcess NDJSON layer, so the `set_session_name` frame's wire shape and
// the handshake's identity application are proven end to end (no network).

const jiti = createJiti(import.meta.url);
const { RpcProcess } = jiti("./omp/rpc-process.ts");

const earlyTitle = { result: null, chainOpts: null, calls: [] };
mock.module("./omp/title-generator.ts", () => ({
  isLowSignalOpener: () => false,
  isWeakPointerOpener: () => false,
  buildTitleModelChain: (opts) => {
    earlyTitle.chainOpts = opts;
    return ["@mocked-chain"];
  },
  generateOpenerTitle: async (request) => {
    earlyTitle.calls.push(request);
    return earlyTitle.result;
  },
  TITLE_ROLE_SELECTORS: ["@tiny", "@commit", "@smol"],
}));

const { AgentSessionWrapper } = await import("./rpc-manager.ts");
const { localHost } = await import("./hosts/local-host.ts");

function scriptedProcess(t, sessionFile) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr: new PassThrough(),
    pid: 4321,
    kill() {
      queueMicrotask(() => child.emit("exit", 0, null));
      return true;
    },
  });
  const commands = [];
  let partial = "";
  const answer = (command) => {
    commands.push(command);
    if (command.type === "negotiate_protocol") {
      return { protocolVersion: 2 };
    }
    if (command.type === "get_state") {
      return { sessionId: "s1", sessionFile, isStreaming: false, isCompacting: false, model: { provider: "anthropic", id: "claude-sonnet" } };
    }
    if (command.type === "prompt") return { agentInvoked: true };
    return {};
  };
  stdin.on("data", (chunk) => {
    partial += chunk.toString("utf8");
    const lines = partial.split("\n");
    partial = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      const command = JSON.parse(line);
      stdout.write(`${JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: answer(command) })}\n`);
    }
  });
  stdin.on("end", () => queueMicrotask(() => child.emit("exit", 0, null)));
  queueMicrotask(() => {
    stdout.write(`${JSON.stringify({ type: "ready", supportedProtocolVersions: [1, 2] })}\n`);
  });
  const proc = new RpcProcess({
    cwd: process.cwd(),
    dependencies: { resolveOmpBin: () => "fake-omp", spawn: () => child },
  });
  t.after(() => {
    if (!stdin.writableEnded) stdin.end();
  });
  return { proc, commands };
}

test("a first run titles mid-run through the real RPC transport and applies set_session_name", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ompweb-early-title-proc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agentDir = mkdtempSync(join(tmpdir(), "ompweb-early-title-agent-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  });
  writeFileSync(join(agentDir, "omp-web-settings.json"), JSON.stringify({ autoGenerateSessionTitles: true }), "utf8");
  const sessionFile = join(dir, "s1.jsonl");
  writeFileSync(sessionFile, "{}\n");
  earlyTitle.calls.length = 0;
  earlyTitle.chainOpts = null;
  earlyTitle.result = { title: "Fix the login bug", model: "@mocked-chain" };

  const { proc, commands } = scriptedProcess(t, sessionFile);
  const wrapper = new AgentSessionWrapper(proc, process.cwd(), null, false, "s1", undefined, localHost);
  wrapper.start();
  t.after(() => wrapper.destroyAndWait());
  await wrapper.waitUntilReady();
  assert.equal(wrapper._sessionFile, sessionFile, "the real handshake applied the child's session file");

  await wrapper.send({ type: "prompt", message: "Fix the login bug in auth.ts" });

  for (let i = 0; i < 200 && !commands.some((command) => command.type === "set_session_name"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const rename = commands.find((command) => command.type === "set_session_name");
  assert.ok(rename, `the child received set_session_name (saw: ${commands.map((c) => c.type).join(", ")})`);
  assert.equal(rename.name, "Fix the login bug");
  assert.equal(earlyTitle.calls.length, 1);
  assert.equal(earlyTitle.calls[0].text, "Fix the login bug in auth.ts");
  assert.deepEqual(earlyTitle.chainOpts, { sessionModel: "anthropic/claude-sonnet", generator: undefined });
  assert.equal(wrapper._sessionName, "Fix the login bug");
});
