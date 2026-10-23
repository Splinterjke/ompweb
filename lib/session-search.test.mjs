import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { compileSearchQuery, scoreSearchFields, searchField, TITLE_WEIGHT, CONTENT_WEIGHT } = await jiti.import("./session-search.ts");

const score = (query, title, content = "") =>
  scoreSearchFields([searchField(title, TITLE_WEIGHT), searchField(content, CONTENT_WEIGHT)], compileSearchQuery(query));

test("every word must match, in any order", () => {
  assert.notEqual(score("bug login", "Fix login bug"), null);
  assert.equal(score("login payments", "Fix login bug"), null);
});

test("typed order and exactness rank higher", () => {
  assert.ok(score("login bug", "fix login bug") > score("login bug", "bug in login"));
  assert.ok(score("login", "login page") > score("login", "logins page"));
});

test("typos still match, short words do not get typo tolerance", () => {
  assert.notEqual(score("sidebr", "Sidebar search"), null);
  assert.notEqual(score("kubernetis", "kubernetes cluster"), null);
  assert.equal(score("cat", "car"), null);
  assert.equal(score("node", "code mode"), null);
});

test("a word too far from every word does not match", () => {
  // 5–7 letter terms allow one typo; "too far" must never count as a typo.
  assert.equal(score("xyzzy", "Fix login bug"), null);
  assert.equal(score("rolling", "kubernetes cluster setup", "done"), null);
  assert.equal(score("sidebar", "Totally unrelated words here"), null);
});

test("combining marks stay inside their word, and NFC/NFD forms match each other", () => {
  assert.equal(score("हिन्दी", "ह न द"), null);
  assert.notEqual(score("résumé", "my re\u0301sume\u0301 draft"), null);
});

test("words may split across title and transcript; title matches outrank transcript matches", () => {
  assert.notEqual(score("sidebar ranking", "Sidebar work", "we discussed ranking"), null);
  assert.ok(score("ranking", "Ranking", "") > score("ranking", "Other", "ranking ranking"));
});

test("quoted phrases must appear verbatim", () => {
  assert.notEqual(score('"login bug"', "fix login  bug now"), null);
  assert.equal(score('"bug login"', "fix login bug"), null);
  assert.equal(score('"logn bug"', "fix login bug"), null);
  // Unclosed quote while typing is still a phrase, not loose words.
  assert.equal(score('"bug lo', "fix login bug"), null);
  assert.notEqual(score('"login b', "fix login bug"), null);
  // Typographic quotes from phone keyboards are phrases too.
  assert.equal(score("“bug login”", "fix login bug"), null);
  assert.notEqual(score("“login bug”", "fix login bug"), null);
});

test("empty query compiles to nothing", () => {
  assert.equal(compileSearchQuery('  "" '), null);
});
