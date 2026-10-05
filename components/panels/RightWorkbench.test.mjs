import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { RightWorkbench } = await jiti.import("./RightWorkbench.tsx");

// Pin the empty-state surface set structurally (one card per workbench
// view), not per-locale wording: translations are locale data and churn
// independently of this component.
test("right workbench starts with six actionable empty-state surfaces including Memory", () => {
  const html = renderToStaticMarkup(React.createElement(RightWorkbench, {
    storageKey: "ssr",
    files: React.createElement("div", null, "files-view"),
    agents: React.createElement("div", null, "agents-view"),
  }));
  assert.match(html, /right-workbench-empty/);
  assert.equal((html.match(/<strong/g) ?? []).length, 6);
  assert.match(html, /Memories/);
  assert.match(html, /Files/);
  assert.doesNotMatch(html, /drag|combine/i);
});
