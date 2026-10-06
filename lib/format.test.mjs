import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { formatUsageReset } = await jiti.import("./format.ts");

test("formatUsageReset keeps sub-hour minutes as minutes", () => {
  assert.equal(formatUsageReset(0, "minutes"), "0m");
  assert.equal(formatUsageReset(159, "minutes"), "2h 39m");
  assert.equal(formatUsageReset(60, "minutes"), "1h");
  assert.equal(formatUsageReset(120, "minutes"), "2h");
});

test("formatUsageReset breaks hours into days", () => {
  assert.equal(formatUsageReset(3, "hours"), "3h");
  assert.equal(formatUsageReset(24, "hours"), "1d");
  assert.equal(formatUsageReset(30, "hours"), "1d 6h");
  assert.equal(formatUsageReset(140, "hours"), "5d 20h");
});
