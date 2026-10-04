import test from "node:test";
import assert from "node:assert/strict";
import { mergeRecoveredText } from "./draft-store.ts";

test("a later recovery merges with an earlier one in order, unless the draft no longer starts with it", () => {
  assert.equal(mergeRecoveredText("typing", { text: "B" }), "B\n\ntyping");
  const replace = { lead: "B", fallback: "A" };
  assert.equal(mergeRecoveredText("B\n\ntyping", { text: "A\n\nB", replace }), "A\n\nB\n\ntyping");
  assert.equal(mergeRecoveredText("edited", { text: "A\n\nB", replace }), "A\n\nedited", "never re-adds text the user removed");
});
