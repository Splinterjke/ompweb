import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function load() {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  return jiti("./session-model-check.ts");
}

function sessionFile(lines) {
  const dir = mkdtempSync(join(tmpdir(), "ompweb-saved-model-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

test("readSessionSavedModel returns the last default-role model_change", async () => {
  const { readSessionSavedModel } = await load();
  const path = sessionFile([
    JSON.stringify({ type: "session", version: 3, id: "abc", cwd: "/tmp" }),
    JSON.stringify({ type: "model_change", id: "1", parentId: null, provider: "old", model: "old/m1", timestamp: "t" }),
    JSON.stringify({ type: "message", id: "2", parentId: "1", message: { role: "user", content: "hi" } }),
    JSON.stringify({ type: "model_change", id: "3", parentId: "2", model: "gen/title-model", role: "title" }),
    JSON.stringify({ type: "model_change", id: "4", parentId: "3", model: "anthropic/claude-opus-4" }),
  ]);
  assert.deepEqual(readSessionSavedModel(path), {
    full: "anthropic/claude-opus-4",
    provider: "anthropic",
    modelId: "claude-opus-4",
  });
});

test("readSessionSavedModel ignores role-scoped entries and unparsable lines", async () => {
  const { readSessionSavedModel } = await load();
  const path = sessionFile([
    `{"type":"model_change","id":"1","broken`,
    JSON.stringify({ type: "model_change", id: "2", model: "opus" }),
    JSON.stringify({ type: "model_change", id: "3", model: "gen/title", role: "title" }),
    JSON.stringify({ type: "model_change", id: "4", model: "subagent/x", role: "subagent:scout" }),
  ]);
  assert.equal(readSessionSavedModel(path), null);
});

test("readSessionSavedModel treats an absent or unreadable file as no saved model", async () => {
  const { readSessionSavedModel } = await load();
  assert.equal(readSessionSavedModel(join(tmpdir(), "definitely-missing-session.jsonl")), null);
  assert.equal(readSessionSavedModel(sessionFile([])), null);
});

test("classifyStartupFailure names the unrestorable model", async () => {
  const { classifyStartupFailure } = await load();
  // omp ≥ 18.6.3 createAgentSession throws `Could not restore model <provider/id>`;
  // the Node spawn error appends the raw stderr, possibly with trailing punctuation.
  assert.deepEqual(
    classifyStartupFailure("omp exited (code 1): Could not restore model anthropic/claude-3.5-sonnet."),
    { kind: "model", model: "anthropic/claude-3.5-sonnet" },
  );
  // A model id ending in a digit keeps its last segment (only the sentence's
  // own trailing punctuation is stripped).
  assert.deepEqual(
    classifyStartupFailure("Could not restore model openai/gpt-5.2"),
    { kind: "model", model: "openai/gpt-5.2" },
  );
});

test("classifyStartupFailure reports the missing resume path", async () => {
  const { classifyStartupFailure } = await load();
  // omp ≥ 18.7.0 fails `--resume <path>` closed with exactly this message.
  assert.deepEqual(
    classifyStartupFailure('Error: Session "/root/.omp/agent/sessions/x/y.jsonl" not found.'),
    { kind: "missing", path: "/root/.omp/agent/sessions/x/y.jsonl" },
  );
  assert.equal(classifyStartupFailure("omp exited (code 1): EACCES permission denied"), null);
});

test("parseSessionStartupBinding validates the client startup field", async () => {
  const { parseSessionStartupBinding } = await load();
  assert.deepEqual(
    parseSessionStartupBinding({ modelOverride: { provider: "anthropic", modelId: "claude-opus-4" } }),
    { modelOverride: { provider: "anthropic", modelId: "claude-opus-4" } },
  );
  assert.deepEqual(parseSessionStartupBinding({ forceModelCheck: true }), { forceModelCheck: true });
  assert.deepEqual(
    parseSessionStartupBinding({ modelOverride: { provider: "p", modelId: "m" }, forceModelCheck: true }),
    { modelOverride: { provider: "p", modelId: "m" }, forceModelCheck: true },
  );
  // Anything malformed is dropped, never forwarded to the spawn args.
  assert.equal(parseSessionStartupBinding(undefined), undefined);
  assert.equal(parseSessionStartupBinding(null), undefined);
  assert.equal(parseSessionStartupBinding("anthropic/x"), undefined);
  assert.equal(parseSessionStartupBinding([]), undefined);
  assert.equal(parseSessionStartupBinding({}), undefined);
  assert.equal(parseSessionStartupBinding({ forceModelCheck: false }), undefined);
  assert.equal(parseSessionStartupBinding({ modelOverride: { provider: "p q", modelId: "m" } }), undefined);
  assert.equal(parseSessionStartupBinding({ modelOverride: { provider: "p", modelId: "--model=x" } }), undefined);
  assert.equal(parseSessionStartupBinding({ modelOverride: { provider: "p" } }), undefined);
});

// The 7 MB session that died with "omp process exited before ready": the
// model was set once at the head and never changed, so the 512 KB tail
// window held no entry and the pre-flight skipped — omp then fail-closed on
// its unrestorable saved model with the reason lost in Rust host mode.
function oversizedSessionFile(headLines, tailLines) {
  const dir = mkdtempSync(join(tmpdir(), "ompweb-saved-model-big-"));
  const path = join(dir, "session.jsonl");
  // ~600 KB of valid JSONL after the head entries — beyond TAIL_BYTES.
  const filler = { type: "message", id: "f", parentId: null, message: { role: "assistant", content: "x".repeat(1000) } };
  const bulk = Array.from({ length: 600 }, (_, i) => JSON.stringify({ ...filler, id: `f${i}` }));
  writeFileSync(path, [...headLines, ...bulk, ...tailLines].map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return path;
}

test("readSessionSavedModel finds an entry ahead of a model_change-free tail window", async () => {
  const { readSessionSavedModel } = await load();
  const path = oversizedSessionFile(
    [
      { type: "session", version: 3, id: "abc", cwd: "/tmp" },
      { type: "model_change", id: "1", parentId: null, model: "denvi-sglang/qwen-3.8", role: "default" },
    ],
    [],
  );
  assert.deepEqual(readSessionSavedModel(path), {
    full: "denvi-sglang/qwen-3.8",
    provider: "denvi-sglang",
    modelId: "qwen-3.8",
  });
});

test("whole-file fallback keeps the LAST entry across chunk boundaries and role filters", async () => {
  const { readSessionSavedModel } = await load();
  const dir = mkdtempSync(join(tmpdir(), "ompweb-saved-model-mid-"));
  const path = join(dir, "session.jsonl");
  const fillerLine = (i) => JSON.stringify({ type: "message", id: `f${i}`, parentId: null, message: { role: "assistant", content: "y".repeat(1000) } });
  // ~1080 bytes per filler line: 990 lines push the next entry past the
  // 1 MB scan-chunk boundary of the fallback reader.
  const before = Array.from({ length: 990 }, (_, i) => fillerLine(i));
  // 700 further filler lines (~750 KB) keep the 512 KB tail window free of
  // model_change entries, so the tail scan finds nothing and the fallback runs.
  const after = Array.from({ length: 700 }, (_, i) => fillerLine(10000 + i));
  const lines = [
    JSON.stringify({ type: "model_change", id: "1", parentId: null, model: "old/m1", role: "default" }),
    ...before,
    JSON.stringify({ type: "model_change", id: "z", parentId: "f989", model: "newer/m2" }),
    // A role-scoped entry AFTER the real one must never win the fallback scan.
    JSON.stringify({ type: "model_change", id: "t", parentId: "z", model: "gen/titler", role: "title" }),
    ...after,
  ];
  writeFileSync(path, `${lines.join("\n")}\n`);
  assert.deepEqual(readSessionSavedModel(path), { full: "newer/m2", provider: "newer", modelId: "m2" });
});

test("modelSwitchRepairBinding rebinds the spawn for a set_model command", async () => {
  const { modelSwitchRepairBinding } = await load();
  assert.deepEqual(
    modelSwitchRepairBinding({ type: "set_model", provider: "denvi-vllm", modelId: "qwen-3.8" }),
    { modelOverride: { provider: "denvi-vllm", modelId: "qwen-3.8" } },
  );
  // Only set_model carries a rebind: other spawn commands must keep the
  // pre-flight check in place.
  assert.equal(modelSwitchRepairBinding({ type: "get_state" }), undefined);
  assert.equal(modelSwitchRepairBinding({ type: "set_thinking_level", thinkingLevel: "low" }), undefined);
  // Incomplete or malformed model fields never produce a binding (a bad
  // spawn argument would replace one failure with a worse one).
  assert.equal(modelSwitchRepairBinding({ type: "set_model", provider: "p" }), undefined);
  assert.equal(modelSwitchRepairBinding({ type: "set_model", provider: "p/../../x", modelId: "m" }), undefined);
  assert.equal(modelSwitchRepairBinding({}), undefined);
});

test("resolveUniqueRename recognizes only an unambiguous provider rename", async () => {
  const { resolveUniqueRename } = await load();
  const owners = new Map([
    ["qwen-3.8", new Set(["denvi-vllm"])],
    ["gpt", new Set(["openai", "azure"])],
    ["ghost", new Set(["denvi-sglang"])],
  ]);
  // Exactly one live owner and not the dead one -> the replacement.
  assert.deepEqual(
    resolveUniqueRename({ provider: "denvi-sglang", modelId: "qwen-3.8" }, owners),
    { provider: "denvi-vllm", modelId: "qwen-3.8" },
  );
  // Ambiguous owners, no owners, or the same provider never guess.
  assert.equal(resolveUniqueRename({ provider: "dead", modelId: "gpt" }, owners), undefined);
  assert.equal(resolveUniqueRename({ provider: "dead", modelId: "missing" }, owners), undefined);
  assert.equal(resolveUniqueRename({ provider: "denvi-sglang", modelId: "ghost" }, owners), undefined);
});
