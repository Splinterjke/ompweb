import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { collectToolResults, sanitizePassiveToolContext } = await jiti.import("./passive-tool-context.ts");
const { planTurnSegments, looksLikeRunningTurn } = await jiti.import("./chat-segments.ts");

function user(id, content = `u-${id}`) {
  return { role: "user", content };
}
function assistant(id, blocks, text) {
  const content = blocks ?? [{ type: "text", text: text ?? `a-${id}` }];
  return { role: "assistant", provider: "t", model: "m", content };
}
function toolCall(id, toolName = "bash") {
  return { type: "toolCall", toolCallId: id, toolName, input: {} };
}
function toolResult(toolCallId) {
  return { role: "toolResult", toolCallId, content: [{ type: "text", text: "ok" }] };
}
function passive(text) {
  return { role: "custom", customType: "passive-tool-context", display: false, content: [{ type: "text", text }] };
}

/** Summarize segments as [kind, detail] pairs: text → its text, activity → piece message indices. */
function shape(segments) {
  return segments.map((segment) => {
    if (segment.kind === "text") return ["text", segment.blocks.map((block) => block.text).join("|")];
    return ["activity", segment.pieces.map((piece) => piece.index)];
  });
}

test("passive context attaches to the last tool call of the batch it follows, not as a row", () => {
  const messages = [
    user("u1"),
    assistant("a1", [toolCall("tc1"), toolCall("tc2")]),
    toolResult("tc1"),
    toolResult("tc2"),
    passive("Use both results before continuing."),
    assistant("a2", undefined, "Done."),
  ];
  const results = collectToolResults(messages);
  assert.equal(results.get("tc2").passiveContext, "Use both results before continuing.");
  assert.equal(results.get("tc1").passiveContext, undefined);
  assert.equal(results.get("tc2").content, messages[3].content, "the result itself is unchanged");
  assert.equal(messages[3].passiveContext, undefined, "the committed message is not mutated");
  assert.equal(collectToolResults(messages).get("tc2"), results.get("tc2"), "stable identity across recomputes");
  // The context message is neither a fold piece nor a standalone row.
  assert.deepEqual(shape(planTurnSegments(messages, 0, messages.length)), [["activity", [1]], ["text", "Done."]]);
  // Mid-run, trailing context does not make the turn look finished.
  assert.equal(looksLikeRunningTurn(messages.slice(0, 5)), true);
});

test("orphaned passive context is dropped instead of attaching to an earlier card", () => {
  const notice = { role: "custom", customType: "job-result", display: true, content: "job done" };
  const afterNotice = collectToolResults([
    user("u1"), assistant("a1", [toolCall("tc1")]), toolResult("tc1"), notice, passive("stale"),
  ]);
  assert.equal(afterNotice.get("tc1").passiveContext, undefined);
  const afterText = collectToolResults([
    user("u1"), assistant("a1", [toolCall("tc1")]), toolResult("tc1"), assistant("a2", undefined, "hi"), passive("stale"),
  ]);
  assert.equal(afterText.get("tc1").passiveContext, undefined);
  const afterUser = collectToolResults([
    user("u1"), assistant("a1", [toolCall("tc1")]), toolResult("tc1"), user("u2"), passive("stale"),
  ]);
  assert.equal(afterUser.get("tc1").passiveContext, undefined);
  // A second context after the batch already took one is orphaned too.
  const twice = collectToolResults([
    user("u1"), assistant("a1", [toolCall("tc1")]), toolResult("tc1"), passive("first"), passive("second"),
  ]);
  assert.equal(twice.get("tc1").passiveContext, "first");
});

test("passive context keeps line breaks and indentation; blank context attaches nothing", () => {
  assert.equal(
    sanitizePassiveToolContext("\n\x1b[31mUse\x1b[0m\tboth  \r\n\n\n\n  results\x07\n\n"),
    "Use\tboth\n\n  results",
  );
  assert.equal(sanitizePassiveToolContext([{ type: "text", text: "line one" }, { type: "text", text: "line two" }]), "line one\nline two");
  // Lines holding only whitespace count as blank for the blank-line cap.
  assert.equal(sanitizePassiveToolContext("a\n \n\u00a0\n\t\nb"), "a\n\nb");
  const results = collectToolResults([user("u1"), assistant("a1", [toolCall("tc1")]), toolResult("tc1"), passive(" \t\x1b[0m\n")]);
  assert.equal(results.get("tc1").passiveContext, undefined);
});

test("malformed or hostile passive context never breaks the transcript", () => {
  // Imported and hand-edited session files can carry any content shape.
  for (const content of [undefined, null, 5, { a: 1 }, [null], [{ type: "text" }]]) {
    const results = collectToolResults([
      user("u1"), assistant("a1", [null, toolCall("tc1")]), toolResult("tc1"), { ...passive(""), content },
    ]);
    assert.equal(results.get("tc1").passiveContext, undefined, `content ${JSON.stringify(content)}`);
  }
  // Bidi overrides and zero-width characters could visually rewrite the line.
  assert.equal(sanitizePassiveToolContext("safe\u202Etxet\u200B tail"), "safetxet tail");
  assert.equal(sanitizePassiveToolContext("a".repeat(5000)).length, 2000);
  // A huge whitespace run stays linear (a backtracking trim regex would hang
  // here), and the cap never leaves trailing whitespace behind.
  assert.equal(sanitizePassiveToolContext(`a${" ".repeat(200_000)}b`), "a");
  assert.equal(sanitizePassiveToolContext(`${"a".repeat(1999)}\n\nb`), "a".repeat(1999));
});
