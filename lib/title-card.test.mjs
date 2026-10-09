import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { parseTitleCard, formatTitleCard } = await jiti.import("./title-card.ts");

test("splits a card-form title into icon, code and plain title", () => {
  assert.deepEqual(parseTitleCard("🧪 FLAKY: Fix flaky park tests"), {
    icon: "🧪",
    code: "FLAKY",
    title: "Fix flaky park tests",
  });
  assert.deepEqual(parseTitleCard("🗄️ Z3: Solve Z3 constraints"), {
    icon: "🗄️",
    code: "Z3",
    title: "Solve Z3 constraints",
  });
});

test("accepts Nerd Fonts glyph icons (private-use code points)", () => {
  const glyph = "\uF0C2"; // nf-fa-flask, a PUA code point like every Nerd Font icon
  assert.deepEqual(parseTitleCard(`${glyph} DB: Migrate the queue table`), {
    icon: glyph,
    code: "DB",
    title: "Migrate the queue table",
  });
});

test("returns null for plain titles and near-misses", () => {
  assert.equal(parseTitleCard("Fix flaky park tests"), null);
  // ASCII-only leading token is never a card icon (upstream isCardIcon).
  assert.equal(parseTitleCard("BUG: something"), null);
  // Code must be 1-6 ASCII capitals/digits.
  assert.equal(parseTitleCard("🧪 flaky: lowercase code"), null);
  assert.equal(parseTitleCard("🧪 ABCDEFG: too long"), null);
  // Title text after the colon-space must be non-empty.
  assert.equal(parseTitleCard("🧪 FLAKY: "), null);
  assert.equal(parseTitleCard(""), null);
  assert.equal(parseTitleCard(undefined), null);
  assert.equal(parseTitleCard(null), null);
});

test("a title that merely starts with an emoji is not a card", () => {
  assert.equal(parseTitleCard("🧪 Fix flaky park tests"), null);
  assert.equal(parseTitleCard("🎉 shipped!"), null);
});

test("format round-trips parsed cards", () => {
  const raw = "🧪 FLAKY: Fix flaky park tests";
  assert.equal(formatTitleCard(parseTitleCard(raw)), raw);
});
