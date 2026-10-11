import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./diff-model.ts");
}

// A consistent two-hunk patch. Old file: 24 lines (o01..o24, with "x"/"y"
// at 20/21); new file: 25 lines ("ctx B" replaces "ctx b", "added" is new,
// "z" replaces "y").
const PATCH = `--- a/demo.ts
+++ b/demo.ts
@@ -4,3 +4,4 @@
 ctx a
-ctx b
+ctx B
+added
 ctx c
@@ -20,2 +21,2 @@
 x
-y
+z
`;

function buildOld() {
  const lines = [];
  for (let i = 1; i <= 24; i++) lines.push(`o${String(i).padStart(2, "0")}`);
  lines[19] = "x";
  lines[20] = "y";
  return lines.join("\n");
}

function buildNew() {
  const lines = ["o01", "o02", "o03", "ctx a", "ctx B", "added", "ctx c"];
  for (let i = 7; i <= 19; i++) lines.push(`o${String(i).padStart(2, "0")}`);
  lines.push("x", "z");
  for (let i = 22; i <= 24; i++) lines.push(`o${String(i).padStart(2, "0")}`);
  return lines.join("\n");
}

test("models hunks with gaps between them and counts per side", async () => {
  const { buildDiffFiles } = await loadSubject();
  const files = buildDiffFiles(PATCH);
  assert.equal(files.length, 1);
  const model = files[0];
  assert.equal(model.oldPath, "a/demo.ts");
  assert.equal(model.newPath, "b/demo.ts");
  assert.equal(model.added, 3);
  assert.equal(model.removed, 2);

  const shape = model.sections.map((s) => `${s.type}:${s.type === "gap" ? s.count : s.rows.length}`);
  assert.deepEqual(shape, ["gap:3", "hunk:4", "gap:13", "hunk:2"]);

  const gap0 = model.sections[0];
  assert.equal(gap0.gapIndex, 0);
  assert.equal(gap0.oldStart, 1);
  assert.equal(gap0.newStart, 1);
  assert.equal(gap0.materializable, true);

  const gap1 = model.sections[2];
  assert.equal(gap1.gapIndex, 1);
  assert.equal(gap1.oldStart, 7);
  assert.equal(gap1.newStart, 8);
  assert.equal(gap1.count, 13);

  // Paired removal/addition on one row, one-sided addition padded on the left.
  const hunk = model.sections[1];
  assert.equal(hunk.rows[0].left.kind, "context");
  assert.equal(hunk.rows[1].left.kind, "removed");
  assert.equal(hunk.rows[1].right.kind, "added");
  assert.equal(hunk.rows[2].left.kind, "empty");
  assert.equal(hunk.rows[2].right.kind, "added");
  assert.equal(hunk.rows[2].right.lineNo, 6);
});

test("tail gaps appear only when both file contents are given", async () => {
  const { buildDiffFiles } = await loadSubject();
  const without = buildDiffFiles(PATCH);
  assert.equal(without[0].sections.at(-1).type, "hunk");

  const withContents = buildDiffFiles(PATCH, { oldText: buildOld(), newText: buildNew() });
  const tail = withContents[0].sections.at(-1);
  assert.equal(tail.type, "gap");
  assert.equal(tail.count, 3);
  assert.equal(tail.oldStart, 22);
  assert.equal(tail.newStart, 23);
  assert.equal(tail.materializable, true);
});

test("revealed gaps materialize real context rows top-down", async () => {
  const { buildDiffFiles, buildViewItems } = await loadSubject();
  const contents = { oldText: buildOld(), newText: buildNew() };
  const model = buildDiffFiles(PATCH, contents)[0];

  const items = buildViewItems(model, [2, 0, 0], contents);
  assert.equal(items[0].type, "rows");
  const materialized = items[0].rows;
  assert.equal(materialized.length, 2);
  assert.equal(materialized[0].left.text, "o01");
  assert.equal(materialized[0].right.text, "o01");
  assert.equal(materialized[0].left.lineNo, 1);
  // The new file is shifted by the hunk-1 addition: old 7 pairs with new 8.
  assert.equal(materialized[1].left.lineNo, 2);
  assert.equal(materialized[1].right.lineNo, 2);

  const bar = items.find((i) => i.type === "bar" && i.gapIndex === 0);
  assert.equal(bar.total, 3);
  assert.equal(bar.revealed, 2);
  assert.equal(bar.remaining, 1);

  // Revealing the whole gap drops the bar without leaving an empty rows item.
  const full = buildViewItems(model, [3, 0, 0], contents);
  const stillThere = full.some((i) => i.type === "bar" && i.gapIndex === 0);
  assert.equal(stillThere, false);
  const head = full[0].rows.filter((r) => r.left.text === "o01" || r.left.text === "o02" || r.left.text === "o03");
  assert.equal(head.length, 3);
});

test("static bars stay when a gap cannot be materialized", async () => {
  const { buildDiffFiles, buildViewItems } = await loadSubject();
  // Deliberately inconsistent hunk header (old edge 3, new edge 5).
  const patch = `--- a/f.ts
+++ b/f.ts
@@ -4,1 +6,1 @@
 a
-b
+c
`;
  const model = buildDiffFiles(patch, { oldText: "a\nb\nc\nd\ne", newText: "a\nb\nc\nd\ne\na\nb\n+c" })[0];
  const gap = model.sections.find((s) => s.type === "gap");
  assert.equal(gap.materializable, false);
  assert.equal(gap.count, 5);

  const items = buildViewItems(model, [5], { oldText: "a\nb\nc\nd\ne", newText: "a\nb\nc\nd\ne\na\nb" });
  const bar = items.find((i) => i.type === "bar");
  assert.ok(bar, "non-materializable bar never collapses");
  assert.equal(bar.remaining, 5);
  assert.equal(items.some((i) => i.type === "rows" && i.rows[0]?.left.lineNo === 1), false);
});

test("reveal steps go 20, 40, then all", async () => {
  const { nextRevealCount } = await loadSubject();
  assert.equal(nextRevealCount(0, 100), 20);
  assert.equal(nextRevealCount(20, 100), 40);
  assert.equal(nextRevealCount(40, 100), 100);
  assert.equal(nextRevealCount(0, 10), 10);
  assert.equal(nextRevealCount(100, 100), 100);
});

test("word spans cover the changed words exactly", async () => {
  const { wordDiffSpans } = await loadSubject();
  const extract = (line, spans) => (spans ?? []).map(([s, e]) => line.slice(s, e));

  const one = wordDiffSpans("background: var(--bg);", "background: var(--bg-panel);");
  assert.equal(one.left, undefined);
  assert.deepEqual(extract("background: var(--bg-panel);", one.right), ["-panel"]);

  const two = wordDiffSpans("flex-direction: column;", "flex-direction: row;");
  assert.deepEqual(extract("flex-direction: column;", two.left), ["column"]);
  assert.deepEqual(extract("flex-direction: row;", two.right), ["row"]);

  // Whitespace between changed words merges the runs into one span.
  const merged = wordDiffSpans("keep it simple ok", "keep it complex nope");
  assert.deepEqual(extract("keep it simple ok", merged.left), ["simple ok"]);
  assert.deepEqual(extract("keep it complex nope", merged.right), ["complex nope"]);

  const ws = wordDiffSpans("a ", "a");
  assert.deepEqual(extract("a ", ws.left), [" "]);

  assert.equal(wordDiffSpans("same", "same"), null);
});

test("word diff skips over-long lines and one-sided pairs", async () => {
  const { buildDiffFiles } = await loadSubject();
  const long = "a ".repeat(600).trimEnd();
  const patch = `--- a/l.ts
+++ b/l.ts
@@ -1,1 +1,1 @@
-${long}
+b ${long}
`;
  const model = buildDiffFiles(patch)[0];
  const row = model.sections.find((s) => s.type === "hunk").rows[0];
  assert.equal(row.left.wordSpans, undefined);
  assert.equal(row.right.wordSpans, undefined);

  // One-sided rows never get inline spans (the whole line is the change).
  const oneSided = buildDiffFiles(`${PATCH}`)[0];
  const added = oneSided.sections[1].rows[2];
  assert.equal(added.right.wordSpans, undefined);
});

test("noise rows never shift the gap arithmetic", async () => {
  const { buildDiffFiles } = await loadSubject();
  const patch = `diff --git a/demo.ts b/demo.ts
index 1234567..89abcde 100644
${PATCH}
\\ No newline at end of file
`;
  const files = buildDiffFiles(patch);
  const shape = files[0].sections.map((s) => `${s.type}:${s.type === "gap" ? s.count : s.rows.length}`);
  assert.deepEqual(shape, ["gap:3", "hunk:4", "gap:13", "hunk:2"]);
});

test("new-file patches have no leading gap on the empty side", async () => {
  const { buildDiffFiles } = await loadSubject();
  const patch = `--- /dev/null
+++ b/n.ts
@@ -0,0 +1,3 @@
+one
+two
+three
`;
  const model = buildDiffFiles(patch, { oldText: "", newText: "one\ntwo\nthree" })[0];
  assert.equal(model.added, 3);
  assert.equal(model.removed, 0);
  // No leading gap (both edges 0), and the tail gap is 0 too.
  assert.deepEqual(model.sections.map((s) => s.type), ["hunk"]);
});

test("word spans bail out past the token budget", async () => {
  const { wordDiffSpans } = await loadSubject();
  const a = Array.from({ length: 300 }, (_, i) => `w${i}`).join(" ");
  const b = Array.from({ length: 300 }, (_, i) => `w${i}`).join(" ") + " tail";
  // 300 words + 299 whitespace runs exceed the 500-token budget — a stall
  // is worse than no word highlight.
  assert.equal(wordDiffSpans(a, b), null);
  // Within budget the LCS still runs.
  assert.ok(wordDiffSpans("one two three", "one two four"));
});

test("nextRevealCount walks 20/40 to the end", async () => {
  const { nextRevealCount } = await loadSubject();
  assert.equal(nextRevealCount(0, 500), 20);
  assert.equal(nextRevealCount(20, 500), 40);
  assert.equal(nextRevealCount(40, 500), 500);
  assert.equal(nextRevealCount(19, 10), 10);
  assert.equal(nextRevealCount(480, 500), 500);
});

test("gap bars materialize only when contents back them", async () => {
  const { buildDiffFiles, buildViewItems } = await loadSubject();
  const patch = `--- a/f.ts
+++ b/f.ts
@@ -1,2 +1,2 @@
 a
-b
+c
 d
`;
  const contents = { oldText: "a\nb\nd\ne\nf", newText: "a\nc\nd\ne\nf" };
  // Without the file texts there is no tail gap at all: nothing to expand.
  assert.deepEqual(buildViewItems(buildDiffFiles(patch)[0], [], null).map((i) => i.type), ["rows"]);

  const model = buildDiffFiles(patch, contents)[0];
  const [first, bar] = buildViewItems(model, [], null);
  assert.equal(first.type, "rows");
  assert.equal(first.rows.length, 3);
  assert.equal(bar.type, "bar");
  assert.equal(bar.total, 3);
  assert.equal(bar.materializable, true);
  // Revealing 2 of 3 hidden lines draws them inline (they merge with the
  // adjacent hunk rows), the remainder stays a bar.
  const partial = buildViewItems(model, [2], contents);
  assert.deepEqual(partial.map((i) => i.type), ["rows", "bar"]);
  assert.equal(partial[0].rows.length, 5);
  assert.equal(partial[1].remaining, 1);
  // Asymmetric gap (one side runs out — a truncated contents read) cannot reveal.
  const asym = buildDiffFiles(patch, { oldText: "a\nb", newText: "a\nc\nd" })[0];
  const asymBar = buildViewItems(asym, [], null)[1];
  assert.equal(asymBar.type, "bar");
  assert.equal(asymBar.materializable, false);
});
