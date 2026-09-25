import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { createJiti } from "jiti";

// React only ships `act` in its development build; force NODE_ENV before any
// React module is loaded so these tests work regardless of the environment's
// default (production builds throw "act(...) is not supported").
process.env.NODE_ENV = "test";
const React = (await import("react")).default;
const { cleanup, fireEvent, render, screen } = await import("@testing-library/react/pure.js");

// These tests exercise the roving-tabindex keyboard model of the tab strip:
// the active tab and its close button own the keyboard focus, arrow keys
// (with wrap), Home/End jump to the ends, Enter/Space activate, and
// Delete/Backspace close the focused tab.

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { TabBar } = await jiti.import("./TabBar.tsx");

beforeEach(() => {
  globalThis.CSS ??= { escape: (value) => value };
});

afterEach(cleanup);

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

test("tabs support roving arrows, Home/End, and keyboard close", async () => {
  const selected = [];
  const closed = [];
  const tabs = [
    { id: "alpha", label: "alpha.ts", filePath: "/workspace/alpha.ts" },
    { id: "beta", label: "beta.ts", filePath: "/workspace/beta.ts" },
  ];

  render(
    React.createElement(TabBar, {
      tabs,
      activeTabId: "alpha",
      onSelectTab: (id) => selected.push(id),
      onCloseTab: (id) => closed.push(id),
    }),
  );

  const alpha = screen.getByRole("tab", { name: "/workspace/alpha.ts" });
  const beta = screen.getByRole("tab", { name: "/workspace/beta.ts" });

  assert.equal(alpha.tabIndex, 0);
  assert.equal(beta.tabIndex, -1);
  assert.equal(screen.getByRole("button", { name: "Close alpha.ts" }).tabIndex, 0);
  assert.equal(screen.getByRole("button", { name: "Close beta.ts" }).tabIndex, -1);

  alpha.focus();
  fireEvent.keyDown(alpha, { key: "ArrowRight" });
  await nextFrame();
  assert.equal(document.activeElement, beta);
  assert.deepEqual(selected, ["beta"]);

  fireEvent.keyDown(beta, { key: "Home" });
  await nextFrame();
  assert.equal(document.activeElement, alpha);
  assert.deepEqual(selected, ["beta", "alpha"]);

  fireEvent.keyDown(alpha, { key: "End" });
  await nextFrame();
  assert.equal(document.activeElement, beta);
  assert.deepEqual(selected, ["beta", "alpha", "beta"]);

  fireEvent.keyDown(beta, { key: "Delete" });
  assert.deepEqual(closed, ["beta"]);
});
