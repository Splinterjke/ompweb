import "../../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ClampedDescription, clampDescriptionStyle, resolveToastTimeout, setToastHistoryRecording, toast, toastHistory, TOAST_HISTORY_LIMIT } = await jiti.import("./toast.tsx");

const TOOL_LIST = "xd://: mounted mcp__ida_reverse_engineering_ida_address_context, mcp__ida_decompile";

test("clamped description renders collapsed to 2 lines with an expand affordance", () => {
  const html = renderToStaticMarkup(React.createElement(ClampedDescription, null, TOOL_LIST));

  assert.match(html, new RegExp(TOOL_LIST.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, /-webkit-line-clamp:2/);
  assert.match(html, /-webkit-box/);
  assert.match(html, /overflow:hidden/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /cursor:pointer/);
  assert.match(html, /Click to expand/);
});

test("clamp style helper drops the clamp when expanded", () => {
  const collapsed = clampDescriptionStyle(false);
  const expanded = clampDescriptionStyle(true);

  assert.equal(collapsed.display, "-webkit-box");
  assert.equal(collapsed.WebkitLineClamp, 2);
  assert.equal(collapsed.overflow, "hidden");
  assert.equal(collapsed.cursor, "pointer");

  assert.equal(expanded.display, undefined);
  assert.equal(expanded.WebkitLineClamp, undefined);
  assert.equal(expanded.overflow, undefined);
  assert.equal(expanded.cursor, "default");
});

// The history layer (upstream 40dcb39b/3e63bf20/f988972a). Toasts are created
// with `durationMs: 0` so the local wall-clock backstop timer fires instantly
// and never lingers past the test process.
test("history keeps the newest toasts first, capped at the limit", () => {
  toastHistory.clear();
  for (let i = 0; i < TOAST_HISTORY_LIMIT + 5; i++) toast.info(`n${i}`, undefined, { durationMs: 0 });
  const entries = toastHistory.get();
  assert.equal(entries.length, TOAST_HISTORY_LIMIT);
  assert.equal(entries[0].title, `n${TOAST_HISTORY_LIMIT + 4}`);
  assert.equal(entries.at(-1).title, "n5");
});

test("a reused toast id replaces its history entry; remove and clear drop entries", () => {
  toastHistory.clear();
  toast.info("update v1", undefined, { id: "update", durationMs: 0 });
  const other = toast.error("failed", undefined, { durationMs: 0 });
  toast.info("update v2", undefined, { id: "update", durationMs: 0 });
  assert.deepEqual(toastHistory.get().map((e) => [e.id, e.title, e.kind]), [["update", "update v2", "info"], [other, "failed", "error"]]);

  toastHistory.remove("update");
  assert.deepEqual(toastHistory.get().map((e) => e.id), [other]);
  toastHistory.clear();
  assert.equal(toastHistory.get().length, 0);
});

test("the local wall-clock default wins unless a duration is given; update banners and 0 are sticky", () => {
  assert.equal(resolveToastTimeout("info"), 6500);
  assert.equal(resolveToastTimeout("success"), 6500);
  assert.equal(resolveToastTimeout("error"), 6500);
  assert.equal(resolveToastTimeout("error", { durationMs: 12000 }), 12000);
  assert.equal(resolveToastTimeout("info", { durationMs: 0 }), 0);
  assert.equal(resolveToastTimeout("info", { variant: "update" }), 0);
});

test("recorded OS notifications get distinct entries and notify subscribers", () => {
  toastHistory.clear();
  let notified = 0;
  const unsubscribe = toastHistory.subscribe(() => { notified++; });
  toastHistory.record("info", "Session A", "Task finished");
  toastHistory.record("info", "Session A", "Task finished", { clamp: true });
  const entries = toastHistory.get();
  assert.equal(entries.length, 2);
  assert.notEqual(entries[0].id, entries[1].id);
  assert.equal(entries[0].clamp, true);
  toastHistory.remove(entries[0].id);
  assert.equal(notified, 3);
  unsubscribe();
  toastHistory.clear();
  assert.equal(notified, 3);
});

test("new entries are unread until marked; a re-announced id keeps its read state", () => {
  toastHistory.clear();
  toast.info("Update available", undefined, { id: "update", durationMs: 0 });
  toastHistory.record("info", "Task finished");
  assert.deepEqual(toastHistory.get().map((e) => e.read), [false, false]);

  toastHistory.markAllRead();
  assert.deepEqual(toastHistory.get().map((e) => e.read), [true, true]);

  // The update toast re-fires on every tab focus; it must not re-badge.
  toast.info("Update available", undefined, { id: "update", durationMs: 0 });
  toastHistory.record("info", "Another task finished");
  assert.deepEqual(toastHistory.get().map((e) => [e.title, e.read]), [
    ["Another task finished", false],
    ["Update available", true],
    ["Task finished", true],
  ]);

  // Leaving the Notifications view calls markAllRead; with nothing unread it
  // must not wake every subscriber (AppShell, the workbench).
  toastHistory.markAllRead();
  let notified = 0;
  const unsubscribe = toastHistory.subscribe(() => { notified++; });
  toastHistory.markAllRead();
  assert.equal(notified, 0);
  unsubscribe();
  toastHistory.clear();
});

test("while tab recording is off nothing lands in the history and readers see an empty list; entries survive and return", () => {
  toastHistory.clear();
  toast.info("recorded first", undefined, { durationMs: 0 });
  setToastHistoryRecording(false);
  assert.deepEqual(toastHistory.get(), []);
  toast.info("not recorded", undefined, { durationMs: 0 });
  toastHistory.record("info", "not recorded either");
  assert.deepEqual(toastHistory.get(), []);
  // The flag flip changes the history/unread snapshots without an entry mutation.
  let notified = 0;
  const unsubscribe = toastHistory.subscribe(() => { notified++; });
  setToastHistoryRecording(true);
  assert.equal(notified, 1);
  unsubscribe();
  assert.deepEqual(toastHistory.get().map((e) => e.title), ["recorded first"]);
  toastHistory.clear();
  setToastHistoryRecording(true);
});
