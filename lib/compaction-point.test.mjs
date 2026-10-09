import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  parseCompactionThreshold,
  resolveModelThreshold,
  describeCompactionThreshold,
  formatHumanTokens,
} = await jiti.import("./compaction-point.ts");

test("parses the upstream threshold syntax", () => {
  assert.deepEqual(parseCompactionThreshold(90000), { kind: "tokens", tokens: 90000 });
  assert.deepEqual(parseCompactionThreshold("90000"), { kind: "tokens", tokens: 90000 });
  assert.deepEqual(parseCompactionThreshold("90k"), { kind: "tokens", tokens: 90000 });
  assert.deepEqual(parseCompactionThreshold("92.5K"), { kind: "tokens", tokens: 92500 });
  assert.deepEqual(parseCompactionThreshold("1M"), { kind: "tokens", tokens: 1_000_000 });
  assert.deepEqual(parseCompactionThreshold("80%"), { kind: "percent", percent: 80 });
  assert.deepEqual(parseCompactionThreshold("72.5%"), { kind: "percent", percent: 72.5 });
});

test("rejects unusable threshold values", () => {
  for (const bad of [0, -1, "", "   ", "abc", "90kb", "%80", "0%", "0k", "101%", Infinity, null, undefined, {}]) {
    assert.equal(parseCompactionThreshold(bad), null, `expected null for ${String(bad)}`);
  }
});

test("exact model key wins over the provider wildcard", () => {
  const thresholds = { "anthropic/*": "80%", "anthropic/claude-opus": "90k" };
  assert.deepEqual(resolveModelThreshold("anthropic", "claude-opus", thresholds), { value: "90k", source: "anthropic/claude-opus" });
  assert.deepEqual(resolveModelThreshold("anthropic", "claude-haiku", thresholds), { value: "80%", source: "anthropic/*" });
  assert.equal(resolveModelThreshold("openai", "gpt", thresholds), null);
  assert.equal(resolveModelThreshold("anthropic", "claude-opus", undefined), null);
});

test("human token formatting", () => {
  assert.equal(formatHumanTokens(90000), "90k");
  assert.equal(formatHumanTokens(92500), "92.5k");
  assert.equal(formatHumanTokens(1_500_000), "1.5M");
  assert.equal(formatHumanTokens(1_000_000), "1M");
  assert.equal(formatHumanTokens(999), "999");
});

test("percent thresholds resolve against the context window", () => {
  assert.deepEqual(describeCompactionThreshold({ kind: "tokens", tokens: 90000 }), { label: "90k", tokens: 90000 });
  assert.deepEqual(describeCompactionThreshold({ kind: "percent", percent: 80 }, 200000), { label: "80% · 160k", tokens: 160000 });
  assert.deepEqual(describeCompactionThreshold({ kind: "percent", percent: 80 }), { label: "80%", tokens: undefined });
});
