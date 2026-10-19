import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// IPC sockets deliver arbitrary Buffer splits: a multi-byte UTF-8 character
// can straddle two chunks, and a per-chunk `chunk.toString()` silently
// replaces it with U+FFFD. Paged file reads move hundreds of kilobytes of raw
// UTF-8 through these sockets per page, so every host data handler must
// decode with a stateful StringDecoder.

const jiti = createJiti(import.meta.url);
function midCharChunks(line) {
  const chunks = [];
  let sent = 0;
  while (sent < line.length) {
    let cut = Math.min(sent + 100, line.length);
    // Land the cut INSIDE a multi-byte sequence whenever possible, so every
    // chunk boundary tests the reassembly (except the EOF chunk).
    if (cut < line.length && (line[cut + 1] & 0xc0) === 0x80) cut += 1;
    chunks.push(line.subarray(sent, cut));
    sent = cut;
  }
  return chunks;
}

test("control frames split mid-character across socket chunks decode losslessly", async () => {
  const { RustHostManager } = await jiti.import("./rust-rpc-process.ts");
  // The manager's constructor only stores the spawn function; no process or
  // socket is created, so the control-data decoder can be driven directly.
  const manager = new RustHostManager();
  const payload = { content: "é€日本語".repeat(4000) };
  const line = Buffer.from(JSON.stringify({ id: "c1", ok: true, result: payload }) + "\n", "utf8");
  const resolved = await new Promise((resolve, reject) => {
    manager["pending"].set("c1", { type: "test", resolve, reject });
    for (const chunk of midCharChunks(line)) manager["handleControlData"](chunk);
  });
  assert.deepEqual(resolved, payload);
});

test("isolated host requests reassemble UTF-8 split across socket chunks", async () => {
  // Prove the pattern the fix applies (stateful decoder over a line buffer)
  // reassembles characters a naive per-chunk decode would corrupt — the
  // same shape as `isolatedRequest`'s data handler, driven without a host.
  const text = "é€日本語".repeat(3000);
  const line = Buffer.from(JSON.stringify({ text }) + "\n", "utf8");
  const { StringDecoder } = await import("node:string_decoder");
  let buffer = "";
  const decoder = new StringDecoder("utf8");
  let naive = "";
  for (const chunk of midCharChunks(line)) {
    buffer += decoder.write(chunk);
    naive += chunk.toString();
  }
  assert.equal(JSON.parse(buffer).text, text, "stateful decoder reassembles every character");
  assert.notEqual(JSON.parse(naive).text, text, "the per-chunk decode this replaces corrupts the stream");
});
