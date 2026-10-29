import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// Image-attached prompts travel as ONE host IPC line. Past the host's frame
// cap the reader answers frame_too_large and closes while the client is
// still writing — the RST discards that answer and Node reports a bare
// `read ECONNRESET` (the "Failed to send message" toast). RustHostManager.send
// must therefore preflight the EXACT escaped line size and refuse with an
// honest error before touching the socket.

const jiti = createJiti(import.meta.url);

async function freshManager() {
  const { RustHostManager } = await jiti.import("./rust-rpc-process.ts");
  // rpc-frame.ts pulls extensionless internal imports, so the shared cap
  // comes through jiti as well (raw ESM cannot resolve it).
  const { MAX_IPC_FRAME_BYTES } = await jiti.import("./rpc-frame.ts");
  // Constructor only stores the spawn function: no host, no sockets.
  return { manager: new RustHostManager(), MAX_IPC_FRAME_BYTES };
}

test("oversized image command is refused before any socket (no ECONNRESET race)", async () => {
  const { manager, MAX_IPC_FRAME_BYTES } = await freshManager();
  const data = "A".repeat(MAX_IPC_FRAME_BYTES); // base64-style payload > cap
  await assert.rejects(
    () => manager.send("session-1", {
      type: "prompt",
      message: "what is in these images?",
      images: [{ type: "image", mimeType: "image/png", data }],
    }),
    (error) => {
      assert.equal(error.code, "ipc_frame_too_large");
      assert.match(error.message, /too large for the local host transport/);
      assert.match(error.message, /attach fewer or smaller images/);
      return true;
    },
  );
  assert.ok(manager.host == null, "no host process was spawned for the refused command");
});

test("pre-flight measures the ESCAPED wire line, not the raw command", async () => {
  const { manager, MAX_IPC_FRAME_BYTES } = await freshManager();
  // ~8 MiB of double quotes: raw command JSON under the cap, but escaping it
  // as a nested JSON string doubles the wire line past the cap — the exact
  // blind spot a raw-length check would miss.
  const quotes = '"'.repeat(Math.ceil(MAX_IPC_FRAME_BYTES / 2.5));
  await assert.rejects(
    () => manager.send("session-1", { type: "prompt", message: quotes }),
    (error) => error.code === "ipc_frame_too_large",
  );
});

test("commands within the cap reach controlRequest unchanged", async () => {
  const { manager } = await freshManager();
  const captured = [];
  manager.controlRequest = async (method, params) => {
    captured.push({ method, params });
    return { ok: true };
  };
  const command = { type: "prompt", message: "hi", images: [{ type: "image", mimeType: "image/png", data: "AAAA" }] };
  const result = await manager.send("session-1", command);
  assert.deepEqual(result, { ok: true });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].method, "agent.send");
  assert.equal(captured[0].params.sessionId, "session-1");
  assert.equal(captured[0].params.command, JSON.stringify(command), "the host still receives the exact command JSON");
});
