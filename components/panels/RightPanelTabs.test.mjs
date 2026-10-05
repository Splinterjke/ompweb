import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { RightPanelTabs } = await jiti.import("./RightPanelTabs.tsx");

test("right panel exposes Files, Agents and Memory tabs with a semantic tablist", () => {
  const html = renderToStaticMarkup(React.createElement(RightPanelTabs, {
    active: "memory",
    onSelect: () => {},
    counts: { agents: "2/4" },
  }));
  assert.match(html, /role="tablist"/);
  assert.match(html, /right-panel-tab-files/);
  assert.match(html, /right-panel-tab-agents/);
  assert.match(html, /right-panel-tab-memory/);
  assert.doesNotMatch(html, /right-panel-tab-git/);
  assert.match(html, /2\/4/);
  assert.match(html, /aria-selected="true"/);
});
