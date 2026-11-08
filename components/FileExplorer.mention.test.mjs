import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
const { cleanup, fireEvent, render, waitFor } = await import("@testing-library/react/pure.js");

const { FileExplorer } = await import("./FileExplorer.tsx");
const { MOBILE_QUERY } = await import("../hooks/useIsMobile.ts");

// The @ affordance of a file row is secondary: it must not occupy every row's
// width, and it must not stay clickable while invisible.
const MENTION_LABEL = "Insert path into chat";

const originalFetch = globalThis.fetch;
const originalMatchMedia = window.matchMedia;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.matchMedia = originalMatchMedia;
});

function stubListing() {
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.startsWith("/api/git/")) return { ok: true, json: async () => ({ isGitRepository: false, files: [] }) };
    if (href.startsWith("/api/files/ws?")) return { ok: true, json: async () => ({ entries: [{ name: "route.ts", isDir: false, size: 0, modified: "" }] }) };
    return { ok: true, json: async () => ({ entries: [] }) };
  };
}

/** Report the mobile breakpoint as active/inactive; everything else uses the harness stub. */
function setMobile(matches) {
  window.matchMedia = (query) => (query === MOBILE_QUERY
    ? { matches, addEventListener() {}, removeEventListener() {} }
    : originalMatchMedia(query));
}

const rowOf = (container) => container.querySelector('[data-file-path="/ws/route.ts"]');
const mentionOf = (container) => rowOf(container)?.querySelector(`button[aria-label="${MENTION_LABEL}"]`);
const collapsed = (button) => button.style.opacity === "0" && button.style.pointerEvents === "none" && button.style.width === "0px";

async function renderExplorer(onAtMention = () => {}) {
  stubListing();
  const view = render(React.createElement(FileExplorer, { cwd: "/ws", onOpenFile() {}, onAtMention }));
  await waitFor(() => assert.ok(rowOf(view.container)));
  return view;
}

test("a row's @mention is hidden until the pointer enters the row, and hides again on leave", async () => {
  const { container } = await renderExplorer();
  const row = rowOf(container);
  assert.ok(collapsed(mentionOf(container)), "the row must not show @mention at rest");

  fireEvent.mouseEnter(row);
  const shown = mentionOf(container);
  assert.equal(shown.style.opacity, "1");
  assert.equal(shown.style.pointerEvents, "auto");
  // Revealing must not pin a width: the chip sizes to its own label.
  assert.equal(shown.style.width, "");

  fireEvent.mouseLeave(row);
  assert.ok(collapsed(mentionOf(container)), "leaving the row must collapse the chip again");
});

test("the hidden @mention cannot be clicked, so no invisible target eats the click", async () => {
  const { container } = await renderExplorer();
  const button = mentionOf(container);
  assert.equal(button.style.pointerEvents, "none");
  // The chip is still laid out (not display:none), so this is the property that
  // stops a click landing on an unseen control; the revealed chip is clickable.
  fireEvent.mouseEnter(rowOf(container));
  assert.equal(mentionOf(container).style.pointerEvents, "auto");
});

test("keyboard focus inside a row reveals its @mention and leaving the row hides it", async () => {
  const { container } = await renderExplorer();
  const button = mentionOf(container);
  assert.ok(collapsed(button));

  // Tab: the row is the tabbable treeitem, its buttons follow it.
  fireEvent.mouseEnter(rowOf(container));
  fireEvent.mouseLeave(rowOf(container));
  fireEvent.focus(rowOf(container));
  assert.equal(mentionOf(container).style.opacity, "1");

  // Focus moving to another control inside the same row keeps it shown.
  fireEvent.blur(rowOf(container), { relatedTarget: button });
  assert.equal(mentionOf(container).style.opacity, "1");

  fireEvent.blur(button, { relatedTarget: document.body });
  assert.ok(collapsed(mentionOf(container)));
});

test("the touch layout keeps @mention shown, where hover never happens", async () => {
  setMobile(true);
  const { container } = await renderExplorer();
  const button = mentionOf(container);
  assert.equal(button.style.opacity, "1");
  assert.equal(button.style.pointerEvents, "auto");
});

test("@mention inserts the row's path relative to the workspace", async () => {
  const mentioned = [];
  const { container } = await renderExplorer((relativePath, isDir) => mentioned.push({ relativePath, isDir }));
  const button = mentionOf(container);
  fireEvent.mouseEnter(rowOf(container));
  fireEvent.click(mentionOf(container));
  assert.deepEqual(mentioned, [{ relativePath: "route.ts", isDir: false }]);
  assert.equal(button.getAttribute("aria-label"), MENTION_LABEL);
});
