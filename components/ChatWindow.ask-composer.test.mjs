import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("an open ask hides the composer without unmounting it", () => {
  // The ask panel is the only place to answer; a visible composer invites
  // typing into the void. display:none (not an unmount) keeps the draft,
  // attachments and a live recording alive (port of upstream ac4d5ecb).
  assert.match(source, /const askOpen = extensionDialog\?\.method === "ask";/);
  assert.match(source, /<div ref=\{hiddenComposerRef\} style=\{\{ display: askOpen \? "none" : "contents" \}\}>\{chatInputElement\}<\/div>/);
});

test("hiding the composer blurs it so the phone keyboard goes away", () => {
  // A focused hidden composer keeps the soft keyboard up; the first tap in
  // the ask panel would then close the keyboard and resize the panel before
  // the click, making the tap miss its target.
  assert.match(source, /if \(askOpen && active instanceof HTMLElement && hiddenComposerRef\.current\?\.contains\(active\)\) active\.blur\(\);/);
});
