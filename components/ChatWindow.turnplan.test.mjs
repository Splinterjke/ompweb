import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { buildTurnPlan, renderActivityPieces } = await jiti.import("./ChatWindow.tsx");

const call = (id, name = "bash") => ({ type: "toolCall", toolCallId: id, toolName: name, input: { command: id } });
const text = (t) => ({ type: "text", text: t });
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0 };
const assistant = (content, extra = {}) => ({
  role: "assistant", provider: "p", model: "m", content, usage, ...extra,
});

// A turn whose assistant messages split text across an activity run:
// user → A1(text1, tool a) → toolResult → A2(tool b, text2) — the classic
// fold layout whose split-message overrides used to be rebuilt inline on
// every render (each row's memo comparator then failed and the whole visible
// transcript re-rendered whenever a tool committed).
function fixtureMessages() {
  return [
    { role: "user", content: "go" },
    assistant([text("first"), call("a")], { errorMessage: "stale mid-turn error" }),
    { role: "toolResult", toolCallId: "a", content: [text("out-a")] },
    assistant([call("b"), text("done")]),
  ];
}

test("buildTurnPlan precomputes text and activity overrides matching the fold semantics", () => {
  const messages = fixtureMessages();
  const plan = buildTurnPlan(messages, 0, messages.length, false);

  // Text segment overrides carry ONLY the segment's blocks; a non-final
  // segment drops usage and the mid-turn error, the final one keeps usage.
  const textSegIdx = plan.segments.findIndex((s) => s.kind === "text");
  const finalTextSegIdx = plan.segments.map((s) => s.kind).lastIndexOf("text");
  assert.notEqual(textSegIdx, -1);
  const first = plan.textOverrides[textSegIdx];
  assert.deepEqual(first.content.map((b) => b.text ?? b.toolCallId), ["first"]);
  assert.equal(first.usage, undefined);
  assert.equal(first.errorMessage, undefined);
  const final = plan.textOverrides[finalTextSegIdx];
  assert.deepEqual(final.content.map((b) => b.text ?? b.toolCallId), ["done"]);
  assert.deepEqual(final.usage, usage);

  // Activity overrides are indexed per activity segment, one entry per piece;
  // whole-message (non-assistant) pieces carry no override.
  const activitySegIdx = plan.segments.findIndex((s) => s.kind === "activity");
  const segment = plan.segments[activitySegIdx];
  const overrides = plan.activityOverrides.get(activitySegIdx);
  assert.equal(overrides.length, segment.pieces.length);
  for (const [i, piece] of segment.pieces.entries()) {
    if (!piece.blocks) {
      assert.equal(overrides[i], undefined);
      continue;
    }
    const override = overrides[i];
    assert.deepEqual(override.content, piece.blocks);
    assert.equal(override.usage, undefined);
    assert.equal(override.errorMessage, undefined);
  }
});

test("renderActivityPieces reuses the supplied override objects verbatim", () => {
  const messages = fixtureMessages();
  const plan = buildTurnPlan(messages, 0, messages.length, false);
  const activitySegIdx = plan.segments.findIndex((s) => s.kind === "activity");
  const segment = plan.segments[activitySegIdx];
  const overrides = plan.activityOverrides.get(activitySegIdx);

  const calls = [];
  renderActivityPieces(messages, segment.pieces, (idx, options) => { calls.push({ idx, options }); return null; }, overrides);

  assert.equal(calls.length, segment.pieces.length);
  for (const [i, piece] of segment.pieces.entries()) {
    if (!piece.blocks) {
      assert.equal(calls[i].options.messageOverride, undefined);
      continue;
    }
    // THE regression: passing the cached plan's overrides must hand the exact
    // same object to the row (identity-stable → memo comparator passes).
    assert.equal(calls[i].options.messageOverride, overrides[i]);
  }

  // Without overrides the fallback still builds fresh objects (no behavior
  // change for callers outside the cached path).
  const uncached = [];
  renderActivityPieces(messages, segment.pieces, (idx, options) => { uncached.push(options); return null; });
  for (const [i, piece] of segment.pieces.entries()) {
    if (!piece.blocks) continue;
    assert.deepEqual(uncached[i].messageOverride?.content, overrides[i].content);
    assert.notEqual(uncached[i].messageOverride, overrides[i]);
  }
});
test("a cached turn plan survives appends to other turns and invalidates on its own growth", () => {
  const messages = fixtureMessages();
  const plan = buildTurnPlan(messages, 0, messages.length, false);
  // The component validates a cached plan by endIdx plus element identity of
  // the turn slice.
  const sliceIntact = (p, msgs, userIdx) =>
    p.slice.every((m, i) => m === msgs[userIdx + i]);
  // A NEW anchored turn appended after this one (user + assistant): this
  // turn's endIdx and slice are untouched → the cached plan and its override
  // objects are reused. That is exactly what stops finished turns from
  // re-rendering while a later run commits.
  const extended = [...messages, { role: "user", content: "next" }, assistant([text("sure")])];
  assert.equal(plan.endIdx, messages.length);
  assert.ok(sliceIntact(plan, extended, 0));
  // The same turn growing (a commit inside it) yields a different endIdx →
  // the cached plan fails the endIdx check and is rebuilt.
  const grown = [...messages, assistant([call("c"), text("more")])];
  const grownPlan = buildTurnPlan(grown, 0, grown.length, false);
  assert.notEqual(plan.endIdx, grownPlan.endIdx);
});
