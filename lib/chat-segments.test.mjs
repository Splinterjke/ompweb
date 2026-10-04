import assert from "node:assert/strict";
import test from "node:test";
import { planTurnSegments, looksLikeRunningTurn } from "./chat-segments.ts";

function user(content = "q") {
  return { role: "user", content };
}
function assistant(content, extra = {}) {
  return { role: "assistant", provider: "t", model: "m", content, ...extra };
}
function text(t) {
  return { type: "text", text: t };
}
function thinking(t) {
  return { type: "thinking", thinking: t };
}
function toolCall(toolCallId, toolName = "bash") {
  return { type: "toolCall", toolCallId, toolName, input: {} };
}
function toolResult(toolCallId) {
  return { role: "toolResult", toolCallId, content: [{ type: "text", text: "ok" }] };
}

/** Summarize segments as [kind, detail] triples: text → its text + last flag, activity → piece indices + tool-call count. */
function shape(segments) {
  return segments.map((segment) =>
    segment.kind === "text"
      ? ["text", segment.blocks.map((block) => block.text).join("|"), segment.last]
      : ["activity", segment.pieces.map((piece) => piece.index), segment.toolCallCount],
  );
}

test("a reply that ended a turn stays visible when a reminder resumes the agent", () => {
  const messages = [
    user(),
    assistant([thinking("plan"), toolCall("tc1")]),
    toolResult("tc1"),
    assistant([thinking("report"), text("Drafted replies: 1, 2, 3")]),
    { role: "developer", content: [{ type: "text", text: "<system-reminder>You stopped with 7 incomplete todo item(s)</system-reminder>" }] },
    assistant([toolCall("tc2", "todo")]),
    toolResult("tc2"),
    assistant([text("I need your decision on the drafts above.")]),
  ];
  assert.deepEqual(shape(planTurnSegments(messages, 0, 8)), [
    ["activity", [1, 3], 1],
    ["text", "Drafted replies: 1, 2, 3", true],
    ["activity", [4, 5], 1],
    ["text", "I need your decision on the drafts above.", true],
  ]);
});

test("text before a tool call stays visible and splits the activity around it", () => {
  const messages = [
    user(),
    assistant([text("Checking the repo."), toolCall("tc1"), toolCall("tc2")]),
    toolResult("tc1"),
    toolResult("tc2"),
    assistant([text("Done.")]),
  ];
  const segments = planTurnSegments(messages, 0, 5);
  assert.deepEqual(shape(segments), [
    ["text", "Checking the repo.", false],
    ["activity", [1], 2],
    ["text", "Done.", true],
  ]);
  // Only text that ends its message carries usage/error.
  assert.deepEqual(segments.filter((s) => s.kind === "text").map((s) => s.last), [false, true]);
});

test("a provider error after activity gets its own visible (empty) segment", () => {
  const messages = [
    user(),
    assistant([toolCall("tc1")]),
    toolResult("tc1"),
    assistant([toolCall("tc2")], { stopReason: "error", errorMessage: "provider failed" }),
  ];
  const segments = planTurnSegments(messages, 0, 4);
  assert.deepEqual(shape(segments), [["activity", [1, 3], 2], ["text", "", true]]);
  const errorSegment = segments.at(-1);
  assert.equal(errorSegment.index, 3);
  assert.deepEqual(errorSegment.blocks, []);
  assert.equal(errorSegment.last, true);
});

test("hideThinking drops thinking blocks from the plan", () => {
  const messages = [user(), assistant([thinking("hmm"), text("Answer")])];
  assert.deepEqual(shape(planTurnSegments(messages, 0, 2)), [["activity", [1], 0], ["text", "Answer", true]]);
  assert.deepEqual(shape(planTurnSegments(messages, 0, 2, { hideThinking: true })), [["text", "Answer", true]]);
});

test("xdev mount notices are skipped and cannot open an empty fold", () => {
  const messages = [
    user(),
    { role: "custom", customType: "xdev-mount-notice", display: false, content: "notice" },
    assistant([text("Done.")]),
  ];
  assert.deepEqual(shape(planTurnSegments(messages, 0, 3)), [["text", "Done.", true]]);
});

test("tool results render inline and empty thinking is never folded", () => {
  const messages = [
    user(),
    assistant([thinking(""), toolCall("tc1")]),
    toolResult("tc1"),
    assistant([text("ok")]),
  ];
  assert.deepEqual(shape(planTurnSegments(messages, 0, 4)), [["activity", [1], 1], ["text", "ok", true]]);
});

test("deferred thinking placeholders stay in the fold", () => {
  const messages = [user(), assistant([{ type: "thinking", thinking: "", deferred: true }, text("ok")])];
  assert.deepEqual(shape(planTurnSegments(messages, 0, 2)), [["activity", [1], 0], ["text", "ok", true]]);
});

test("#136 a tail awaiting a tool result counts as a live foreign run", () => {
  // omp-web gets no SSE frames for a run owned by another `omp` process, so the
  // transcript tail is the only signal that a turn is still in flight.
  assert.equal(looksLikeRunningTurn([user(), assistant([toolCall("tc1")])]), true);
  assert.equal(looksLikeRunningTurn([user(), assistant([toolCall("tc1")]), toolResult("tc1")]), true);
  // Whitespace-only trailing text does not close the turn; the helper must look past it.
  assert.equal(looksLikeRunningTurn([user(), assistant([toolCall("tc1"), text("   ")])]), true);
  // An empty thinking tail is invisible; the pending tool call underneath still runs.
  assert.equal(looksLikeRunningTurn([user(), assistant([toolCall("tc1"), thinking("")])]), true);
  assert.equal(looksLikeRunningTurn([]), false);
});

test("#136 a completed, aborted or errored turn is not a live foreign run", () => {
  assert.equal(looksLikeRunningTurn([user()]), false, "the user just typed");
  assert.equal(looksLikeRunningTurn([user(), assistant([text("Done.")])]), false);
  // Text anywhere after the last tool call closed the turn.
  assert.equal(
    looksLikeRunningTurn([user(), assistant([toolCall("tc1"), text("Working on it")])]),
    false,
  );
  // A turn closed by an error or a cancel is finished, not pending — even though
  // its blocks still end in a tool call.
  assert.equal(
    looksLikeRunningTurn([user(), assistant([toolCall("tc2")], { stopReason: "error", errorMessage: "provider failed" })]),
    false,
  );
  assert.equal(
    looksLikeRunningTurn([user(), assistant([toolCall("tc2")], { stopReason: "aborted" })]),
    false,
  );
});
