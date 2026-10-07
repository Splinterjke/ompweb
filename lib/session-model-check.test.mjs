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
