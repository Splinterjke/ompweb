import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { SeparatorHandle } = await jiti.import("./SeparatorHandle.tsx");
const { readStoredSectionHeight, SECTION_DEFAULT_HEIGHT, SECTION_MAX_HEIGHT, SECTION_MIN_HEIGHT } = await jiti.import(
  "@/hooks/useSectionResize",
);

// Minimal localStorage shim so the storage reader's clamping paths run in
// Node (the hook guards on `typeof window`).
const storage = new Map([
  ["key-ok", "320"],
  ["key-too-small", "10"],
  ["key-too-large", "99999"],
  ["key-garbage", "not-a-number"],
]);
const windowShim = {
  innerHeight: 800,
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
  },
};
globalThis.window = windowShim;

test("handle renders a keyboard-focusable row-resize separator", () => {
  const html = renderToStaticMarkup(
    React.createElement(SeparatorHandle, {
      label: "Explorer",
      ariaLabel: "Drag to resize Explorer; double-click to reset",
      onMouseDown: () => {},
      onDoubleClick: () => {},
      onKeyDown: () => {},
    }),
  );
  assert.match(html, /role="separator"/);
  assert.match(html, /aria-orientation="horizontal"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /cursor:row-resize/);
});

test("stored heights are clamped to the valid range, garbage falls back", () => {
  assert.equal(readStoredSectionHeight("key-ok"), 320);
  assert.equal(readStoredSectionHeight("key-too-small"), SECTION_MIN_HEIGHT);
  assert.equal(readStoredSectionHeight("key-too-large"), SECTION_MAX_HEIGHT);
  assert.equal(readStoredSectionHeight("key-garbage"), SECTION_DEFAULT_HEIGHT);
  assert.equal(readStoredSectionHeight("key-missing"), SECTION_DEFAULT_HEIGHT);
});
