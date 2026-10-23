import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { RightWorkbench } = await jiti.import("./RightWorkbench.tsx");

// Pin the desktop empty-state surface set structurally (one card per workbench
// view), not per-locale wording: translations are locale data and churn
// independently of this component. The SSR snapshot renders as desktop, where
// the history belongs to the top-bar bell (upstream 351237d7): seven cards,
// no Notifications entry — phones add it back through useIsMobile.
test("right workbench starts with seven desktop empty-state surfaces, the bell owning notifications", () => {
  const html = renderToStaticMarkup(React.createElement(RightWorkbench, {
    storageKey: "ssr",
    files: React.createElement("div", null, "files-view"),
    agents: React.createElement("div", null, "agents-view"),
    worktrees: React.createElement("div", null, "worktrees-view"),
  }));
  assert.match(html, /right-workbench-empty/);
  assert.equal((html.match(/<strong/g) ?? []).length, 7);
  assert.doesNotMatch(html, /Notifications/);
  assert.match(html, /Memories/);
  assert.match(html, /Files/);
  assert.match(html, /Worktrees/);
  assert.doesNotMatch(html, /drag|combine/i);
});
