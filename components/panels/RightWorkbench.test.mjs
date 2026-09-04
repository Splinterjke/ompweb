import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { RightWorkbench } = await jiti.import("./RightWorkbench.tsx");

test("right workbench starts with five actionable empty-state surfaces", () => {
  const html = renderToStaticMarkup(React.createElement(RightWorkbench, {
    storageKey: "ssr",
    files: React.createElement("div", null, "files-view"),
    agents: React.createElement("div", null, "agents-view"),
  }));
  assert.match(html, /right-workbench-empty/);
  assert.match(html, /Files/);
  assert.match(html, /Sub-agents/);
  assert.match(html, /Git/);
  assert.match(html, /Side chat/);
  assert.match(html, /Browser/);
  assert.match(html, /upper\/lower split/);
  assert.doesNotMatch(html, /drag|combine/i);
});

