import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// The chat column's height chain has no layout engine in the way of these
// tests (jsdom performs none), so the two properties that keep the composer on
// screen are pinned at the source. Both were violated in production: a pick
// switched the transcript row from `overflow-hidden` to inline `overflow: clip`
// for scrollIntoView reasons, and because `clip` is not a scroll container,
// Chromium keeps the flex item's content-based automatic minimum size — the row
// grew to the whole transcript (measured 5547px at a 1280x720 viewport, 9078px
// at 390x844) and pushed the hub bars, the goal bar and the composer below the
// fold, with the transcript no longer scrolling at all. `overflow: hidden` had
// zeroed that minimum as a side effect; with clip the zero has to be explicit.

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("the transcript row pairs clip with an explicit zero minimum height", () => {
  // The row is the flex child that holds the Conversation scroller; find the
  // tag that sets clip and read its whole inline style, in any attribute order.
  const row = source.match(/<div[^>]*overflow: "clip"[^>]*>/);
  assert.ok(row, "the transcript row must keep inline overflow: clip (scrollIntoView must not shift it)");
  assert.match(row[0], /minHeight: 0\b/, "clip alone leaves the automatic minimum size content-based, so the row needs an explicit minHeight: 0");
});

test("the conversation scroller is a shrinking scroll container, not a growing block", () => {
  const scroller = source.match(/<div[^>]*aria-label=\{t\("chatWindow\.conversation"\)\}[^>]*>/);
  assert.ok(scroller, "the Conversation scroller element is missing");
  assert.match(scroller[0], /className=\{`flex-1 overflow-y-auto/, "the scroller must flex (no intrinsic height) and scroll its own overflow");
});
