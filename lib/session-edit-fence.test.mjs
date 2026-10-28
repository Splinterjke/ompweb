import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// Route-level Edit fences (upstream f7d4066e's session-routes pair, expressed
// against the local routes): while a live wrapper is mid-`edit_message`, the
// sidebar rename must not fall back to a direct file write, and the automatic
// title fallback must not write after Edit took over. Both must answer 409
// session_busy and leave the session file byte-identical.
// The routes prefer the Rust host by default; the fence under test guards the
// node path (set_session_name RPC + setSessionTitle), so pin the rollback.
const previousBackend = process.env.OMPWEB_BACKEND;
process.env.OMPWEB_BACKEND = "node";
const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});
const sessionRoute = await jiti.import("../app/api/sessions/[id]/route.ts");
const autoNameRoute = await jiti.import("../app/api/sessions/[id]/auto-name/route.ts");
const { cacheSessionPath } = await jiti.import("./session-reader.ts");
const { AgentSessionWrapper, WebRpcError } = await jiti.import("./rpc-manager.ts");
const { setSessionTitle } = await jiti.import("./omp/session-files.ts");

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousBackend === undefined) delete process.env.OMPWEB_BACKEND;
  else process.env.OMPWEB_BACKEND = previousBackend;
});

async function withAgentDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "ompweb-edit-fence-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await run(dir);
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeSessionFile(dir, fileName, header, entries) {
  const filePath = join(dir, fileName);
  const lines = [JSON.stringify({ type: "session", version: 3, ...header }), ...entries.map((line) => JSON.stringify(line))];
  writeFileSync(filePath, `${lines.join("\n")}\n`);
  return filePath;
}

test("sidebar rename cannot fall back to disk while Edit owns the session", async (t) => {
  await withAgentDir(async (dir) => {
    const id = "rename-during-edit";
    const filePath = writeSessionFile(dir, "rename-during-edit.jsonl", { id, cwd: dir }, [
      { type: "message", id: "u1", parentId: null, message: { role: "user", content: "question" } },
      { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [] } },
    ]);
    cacheSessionPath(id, filePath);
    const originalFile = readFileSync(filePath);
    const listeners = new Set();
    const commands = [];
    const state = { sessionId: id, sessionFile: filePath, isStreaming: false, isCompacting: false, queuedMessageCount: 0, isSettled: true };
    const { promise: started, resolve: didStart } = Promise.withResolvers();
    let editRequest;
    const wrapper = new AgentSessionWrapper({
      isAlive: true,
      onFrame(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async sendCommand(command) {
        commands.push(command);
        if (command.type === "get_state") return { ...state };
        if (command.type === "get_available_commands") return { commands: [{ name: "omp-web-edit", source: "extension" }] };
        if (command.type === "prompt") {
          editRequest = JSON.parse(command.message.slice("/omp-web-edit ".length));
          didStart();
          return null;
        }
        if (command.type === "set_session_name") {
          state.sessionName = command.name;
          setSessionTitle(filePath, command.name, "user");
          return null;
        }
        throw new Error(`Unexpected native command: ${command.type}`);
      },
      sendFrame() {},
      async dispose() {},
    }, dir, null, false, id);
    wrapper.start();
    t.after(() => wrapper.destroyAndWait());
    const previousSessions = globalThis.__ompSessions;
    globalThis.__ompSessions = new Map([[id, wrapper]]);
    t.after(() => { globalThis.__ompSessions = previousSessions; });
    let editing;
    const finishEdit = () => {
      if (!editRequest) return;
      const frame = { type: "extension_ui_request", method: "notify", message: "omp-web-edit:" + JSON.stringify({ requestId: editRequest.requestId, sessionId: id, cancelled: true, leafId: "a1" }) };
      editRequest = null;
      for (const listener of listeners) listener(frame);
    };
    const rename = () => sessionRoute.PATCH(new Request(`http://localhost/api/sessions/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Renamed" }),
    }), { params: Promise.resolve({ id }) });
    try {
      await wrapper.send({ type: "get_state" });
      editing = wrapper.send({ type: "edit_message", entryId: "u1" });
      await started;
      const rejected = await rename();
      assert.equal(rejected.status, 409);
      assert.equal((await rejected.json()).code, "session_busy");
      assert.deepEqual(readFileSync(filePath), originalFile, "a busy rename must not rewrite the session title slot or journal");
      assert.equal(commands.some((command) => command.type === "set_session_name"), false);
      finishEdit();
      await editing;
      const accepted = await rename();
      assert.equal(accepted.status, 200);
      assert.equal((await wrapper.send({ type: "get_state" })).sessionName, "Renamed");
      assert.match(readFileSync(filePath, "utf8"), /"title":"Renamed"/);
    } finally {
      finishEdit();
      await editing?.catch(() => {});
    }
  });
});

test("automatic title fallback cannot write after Edit takes over", async (t) => {
  await withAgentDir(async (dir) => {
    const id = "auto-name-during-edit";
    const filePath = writeSessionFile(dir, "auto-name-during-edit.jsonl", { id, cwd: dir }, [
      { type: "message", id: "u1", parentId: null, message: { role: "user", content: "Preserve this conversation" } },
      { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [] } },
    ]);
    cacheSessionPath(id, filePath);
    const originalFile = readFileSync(filePath);
    let editing = false;
    let nativeRenames = 0;
    const rpc = {
      isAlive: () => true,
      isEditingHistory: () => editing,
      isRunning: () => false,
      async generateTitle() {
        // The generation finished without a title; another request acquired Edit.
        editing = true;
        return null;
      },
      async send() {
        nativeRenames += 1;
        throw new WebRpcError("Wait for the history edit to finish", "session_busy");
      },
    };
    const previousSessions = globalThis.__ompSessions;
    globalThis.__ompSessions = new Map([[id, rpc]]);
    t.after(() => { globalThis.__ompSessions = previousSessions; });
    const response = await autoNameRoute.POST(new Request(`http://localhost/api/sessions/${id}/auto-name`, { method: "POST" }), { params: Promise.resolve({ id }) });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "session_busy");
    assert.deepEqual(readFileSync(filePath), originalFile);
    assert.equal(nativeRenames, 0);
  });
});
