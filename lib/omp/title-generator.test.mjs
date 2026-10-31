import assert from "node:assert/strict";
import test from "node:test";

// The web-side mirror of omp's auto-title generator (omp 18.16.0 direct mode).
// These tests pin the gates, the chain shape and the response parse — the
// gateway request/response round trip lives in title-generator.gateway.test.mjs.

const {
  buildTitleModelChain,
  extractTitleText,
  isLowSignalOpener,
  isWeakPointerOpener,
  parseGeneratedTitle,
  validateTitleCandidate,
  wrapOpener,
} = await import("./title-generator.ts");

test("the low-signal gate mirrors the native eE: greetings and bare numbers name nothing", () => {
  for (const opener of ["hi", "ok thanks", "good morning", "hello hello!", "   ", "42 7", "yes yeah", "test"]) {
    assert.equal(isLowSignalOpener(opener), true, `expected low-signal: ${opener}`);
  }
  for (const opener of [
    "fix the login bug",
    "fix this",
    "why is tests/parser_test.py failing",
    "refactor the JSON encoder",
    "hello, can you review my PR for the API gateway?",
  ]) {
    assert.equal(isLowSignalOpener(opener), false, `expected titlable: ${opener}`);
  }
});

test("the weak-pointer gate mirrors the native wRt: a bare pointer at an attachment names nothing", () => {
  assert.equal(isWeakPointerOpener("look at this [Image #1]"), true);
  assert.equal(isWeakPointerOpener("[Image #1]"), true);
  assert.equal(isWeakPointerOpener("what is this? [Image #2]"), true);
  assert.equal(isWeakPointerOpener("fix the flaky parser_test.py suite"), false, "no attachment, no pointer skip");
  assert.equal(isWeakPointerOpener("why does this chart render blank in dark mode? [Image #1]"), false);
});

test("the opener becomes one escaped <user> block; chat-shaped input passes through", () => {
  assert.equal(wrapOpener("fix a < b && c > d"), "<user> fix a &lt; b &amp;&amp; c &gt; d </user>");
  const chat = "<chat><user> hi </user><assistant>yo</assistant></chat>";
  assert.equal(wrapOpener(chat), chat);
});

test("the title validator mirrors the native $$: first line, no quotes, caps, no None", () => {
  assert.equal(validateTitleCandidate("Fix the login bug"), "Fix the login bug");
  assert.equal(validateTitleCandidate('"Fix login"'), "Fix login");
  assert.equal(validateTitleCandidate("'Fix login'"), "Fix login");
  assert.equal(validateTitleCandidate("Fix login."), "Fix login");
  assert.equal(validateTitleCandidate("Fix login!\nignored tail"), "Fix login");
  assert.equal(validateTitleCandidate("<title>Fix login</title>"), "Fix login");
  assert.equal(validateTitleCandidate("None"), null);
  assert.equal(validateTitleCandidate("none"), null);
  assert.equal(validateTitleCandidate("<title/>"), null);
  assert.equal(validateTitleCandidate(""), null);
  assert.equal(validateTitleCandidate("!!!"), null, "no words after the punctuation strip");
  assert.equal(validateTitleCandidate("x".repeat(81)), null, "over 80 characters");
  assert.equal(validateTitleCandidate("one two three four five six seven eight nine ten eleven twelve thirteen"), null, "over 12 words");
});

test("response extraction mirrors the native Ee: title tags, thinking blocks, preamble refusal", () => {
  assert.equal(extractTitleText("Fix the login bug"), "Fix the login bug");
  assert.equal(extractTitleText("<title>Fix the login bug</title>"), "Fix the login bug");
  assert.equal(
    extractTitleText("<thinking>I considered many names<title>NotThis</title></thinking>\n<title>Real Name</title>"),
    "Real Name",
    "a title tag inside a thinking block is not the title",
  );
  assert.equal(extractTitleText("```thinking\nreasoning here\n```\nFix the login bug"), "Fix the login bug");
  assert.equal(extractTitleText("Here's my thinking process:\nFix login"), "", "the thinking preamble means no title");
});

test("parseGeneratedTitle unwraps a JSON answer and refuses untitlable replies", () => {
  assert.equal(parseGeneratedTitle('```json\n{"title": "Fix the login bug"}\n```'), "Fix the login bug");
  assert.equal(parseGeneratedTitle('{"title": "Fix the login bug"}'), "Fix the login bug");
  assert.equal(parseGeneratedTitle("None"), null);
  assert.equal(parseGeneratedTitle("<title/>"), null);
  assert.equal(parseGeneratedTitle(""), null);
  assert.equal(parseGeneratedTitle("<title>None</title>"), null);
});

test("the model chain mirrors the native shape for the title.generator knob", () => {
  assert.deepEqual(buildTitleModelChain({}), ["@tiny", "@commit", "@smol"]);
  assert.deepEqual(
    buildTitleModelChain({ sessionModel: "anthropic/claude" }),
    ["anthropic/claude", "@tiny", "@commit", "@smol"],
    "the default fork mode names with the session model first",
  );
  assert.deepEqual(
    buildTitleModelChain({ sessionModel: "anthropic/claude", generator: "tiny" }),
    ["@tiny", "@commit", "@smol", "anthropic/claude"],
    "tiny mode walks the role chain first, the session model is the fallback",
  );
  assert.deepEqual(
    buildTitleModelChain({ sessionModel: " anthropic/claude ", generator: "fork" }),
    ["anthropic/claude", "@tiny", "@commit", "@smol"],
    "selectors are trimmed and fork is the default order",
  );
});
