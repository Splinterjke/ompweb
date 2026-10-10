import "../../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

// React only ships `act` in its development build; force NODE_ENV before any
// React module is loaded so these tests work regardless of the environment's
// default (production builds throw "act(...) is not supported").
process.env.NODE_ENV = "test";
const React = (await import("react")).default;
const { cleanup, fireEvent, render } = await import("@testing-library/react/pure.js");
const { createJiti } = await import("jiti");

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { DiffViewer } = await jiti.import("./DiffViewer.tsx");

// jsdom ships no matchMedia; the theme hook reads the color scheme at mount.
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

// ResizeObserver stub: observe() reports the width set by `nextWidth`, which
// drives the split/unified gate (>=560) deterministically per test.
let nextWidth = 900;
class FakeResizeObserver {
  constructor(cb) { this.cb = cb; }
  observe() { this.cb([{ contentRect: { width: nextWidth } }]); }
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = FakeResizeObserver;
window.ResizeObserver = FakeResizeObserver;

// Two hunks with materializable gaps: every row must land on its own grid
// row (a rows block after a bar must not restart at row 1 and overlap).
const TWO_HUNK_PATCH = `--- a/f.ts
+++ b/f.ts
@@ -2,3 +2,3 @@
 l1
-l2
+L2
 l3
@@ -15,3 +15,3 @@
 l14
-l15
+L15
 l16
`;
const TWO_HUNK_OLD = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
const TWO_HUNK_NEW = TWO_HUNK_OLD.map((l, i) => (i === 1 || i === 14 ? l.toUpperCase() : l));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const PAIR_PATCH = `--- a/f.ts
+++ b/f.ts
@@ -1,6 +1,7 @@
 module.exports = {
   alpha: 1,
-  beta: 2,
+  beta: 22,
   delta: 4,
   echo: 5,
 };
`;

// 60-line file, line 50 changed: a 46-line hidden gap above the hunk and a
// 7-line gap below it (both materializable from the contents).
const LONG_OLD = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
const LONG_NEW = LONG_OLD.map((l, i) => (i === 49 ? "line 50 CHANGED" : l));
const LONG_PATCH = `--- a/long.py
+++ b/long.py
@@ -47,7 +47,7 @@
 line 46
 line 47
 line 48
 line 49
-line 50
+line 50 CHANGED
 line 51
 line 52
 line 53
`;

const rowsIn = (c) => [...c.querySelectorAll('[data-diff-line="1"]')];
const barsIn = (c) => [...c.querySelectorAll("button")].filter((b) => /hidden line/i.test(b.textContent ?? ""));

test("split view aligns both panes, highlights changed words, persists Viewed", () => {
  nextWidth = 900;
  const view = render(React.createElement(DiffViewer, {
    patch: PAIR_PATCH,
    filePath: "/repo/f.ts",
    cwd: "/repo",
  }));
  const c = view.container;
  // Every left row has a row-aligned right counterpart on the same grid row.
  const left = [...c.querySelectorAll('[data-diff-line="1"]')];
  const right = [...c.querySelectorAll('[data-diff-line="2"]')];
  assert.equal(right.length, left.length);
  assert.deepEqual(right.map((r) => r.style.gridRow), left.map((r) => r.style.gridRow));
  // Word-level shade sits on the changed pair's content spans, in ch units.
  const shaded = [...c.querySelectorAll("[data-diff-line] > span")]
    .filter((s) => (s.style.backgroundImage ?? "").includes("linear-gradient"));
  assert.equal(shaded.length, 2);
  assert.ok(shaded.every((s) => /\d+ch/.test(s.style.backgroundImage)));
  const viewed = [...c.querySelectorAll("button")].find((b) => /viewed/i.test(b.textContent ?? ""));
  assert.ok(viewed, "Viewed pill renders");
  fireEvent.click(viewed);
  assert.equal(viewed.getAttribute("aria-pressed"), "true");
  assert.ok((window.localStorage.getItem("omp-web:git-diff-viewed") ?? "").includes("/repo/f.ts"));
});

test("hidden-lines bars reveal 20, then 40, then all, and disappear when done", () => {
  nextWidth = 900;
  const view = render(React.createElement(DiffViewer, {
    patch: LONG_PATCH,
    oldText: LONG_OLD.join("\n"),
    newText: LONG_NEW.join("\n"),
    filePath: "/repo/long.py",
    cwd: "/repo",
  }));
  const c = view.container;
  const rowCount = () => rowsIn(c).length;
  let bars = barsIn(c);
  assert.equal(bars.length, 2);
  assert.match(bars[0].textContent, /^46 hidden lines$/);
  assert.match(bars[1].textContent, /^7 hidden lines$/);

  const before = rowCount();
  fireEvent.click(bars[0]);
  assert.equal(rowCount() - before, 20, "first reveal draws 20 lines");
  assert.match(barsIn(c)[0].textContent, /^26 hidden lines$/);
  fireEvent.click(barsIn(c)[0]);
  assert.equal(rowCount() - before, 40, "second reveal reaches 40");
  fireEvent.click(barsIn(c)[0]);
  assert.equal(rowCount() - before, 46, "third reveal draws the whole gap");
  bars = barsIn(c);
  assert.equal(bars.length, 1, "only the bottom bar remains");
  // Revealed gap lines are real context rows from the file texts.
  const firstRow = rowsIn(c)[0];
  assert.match(firstRow.textContent, /1line 1/, "revealed line carries its gutter number and text");
});

test("unified mode keeps removed lines and numbers context with new-file line numbers", () => {
  nextWidth = 400; // below the split gate
  const view = render(React.createElement(DiffViewer, {
    patch: PAIR_PATCH,
    filePath: "/repo/f.ts",
    cwd: "/repo",
  }));
  const c = view.container;
  assert.equal(c.querySelectorAll('[data-diff-line="2"]').length, 0, "single column");
  const rows = rowsIn(c);
  // module(1) alpha(2) beta:2(3 old) beta:22(3 new) delta(4) echo(5) };(6)
  assert.equal(rows.length, 7);
  const gutters = rows.map((r) => r.firstElementChild.textContent);
  assert.deepEqual(gutters, ["1", "2", "3", "3", "4", "5", "6"]);
  const texts = rows.map((r) => r.lastElementChild.textContent);
  assert.ok(texts.some((t) => t.includes("beta: 2,")), "removed line is rendered");
  // rsh appends a trailing "\n" to processed lines; in a pre cell that would
  // render every row two lines tall — it must never reach the DOM.
  assert.ok(texts.every((t) => !t.includes("\n")), "no trailing newline inside row content");
});

test("rows blocks after gap bars continue on later grid rows (no overlap)", () => {
  nextWidth = 900;
  const view = render(React.createElement(DiffViewer, {
    patch: TWO_HUNK_PATCH,
    oldText: TWO_HUNK_OLD.join("\n"),
    newText: TWO_HUNK_NEW.join("\n"),
    filePath: "/repo/f.ts",
    cwd: "/repo",
  }));
  const c = view.container;
  // leading bar(1) | hunk1 rows | gap bar | hunk2 rows | trailing bar
  assert.equal(barsIn(c).length, 3);
  const rows = rowsIn(c).map((r) => Number(r.style.gridRow));
  assert.deepEqual(rows, [2, 3, 4, 6, 7, 8], "second hunk starts after the middle bar");
  assert.equal(new Set(rows).size, rows.length, "no two rows share a grid row");
});
