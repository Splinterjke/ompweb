import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

// Port of upstream da7eb347's rewrite of this file (it replaced the
// `queueAllowsAttachments` predicate unit tests when the gate came down).
// Adaptations: this fork's composer is image-only — non-image files insert
// their path as text (no folded-in content) — so every attached-text-file
// assertion is dropped and the picker attaches only an image; and this repo
// has no @testing-library/user-event, so the textarea is driven with
// fireEvent instead of user.type()/keyboard().
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { clearDraft, getDraft } = await jiti.import("@/lib/draft-store");

const KEY = "queue-attachments";
// 1x1 transparent PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

// Same stand-in as ChatInput.clipboard-image.test.mjs: jsdom's FileReader
// brand-checks against its own realm's Blob; the composer only needs
// readAsDataURL -> `result`.
const previousFileReader = globalThis.FileReader;
class TestFileReader {
  result = null;
  onload = null;
  onerror = null;
  readAsDataURL(blob) {
    blob.arrayBuffer().then(
      (buffer) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`;
        this.onload?.();
      },
      (error) => this.onerror?.(error),
    );
  }
}

beforeEach(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.FileReader = TestFileReader;
  URL.createObjectURL ??= () => "blob:test";
  URL.revokeObjectURL ??= () => {};
});
afterEach(() => {
  cleanup();
  clearDraft(KEY);
  localStorage.clear();
  delete window.matchMedia;
  globalThis.FileReader = previousFileReader;
});

/** A composer with an image attached through the picker path, mid-run by default. */
async function renderRunningWithAttachments({ isStreaming = true, queued = true } = {}) {
  const calls = [];
  // Images are the last argument of every queue callback, which resolves
  // false when omp refused the message.
  const record = (name) => async (message, ...rest) => { calls.push({ name, message, images: rest.at(-1) }); return queued; };
  const ref = React.createRef();
  render(React.createElement(ChatInput, {
    ref,
    draftKey: KEY,
    isStreaming,
    onSend: record("onSend"),
    onAbort: record("onAbort"),
    onSteer: record("onSteer"),
    onFollowUp: record("onFollowUp"),
    onPromptWithStreamingBehavior: record("onPromptWithStreamingBehavior"),
  }));
  await act(async () => {
    ref.current.addFiles([
      new File([Buffer.from(PNG, "base64")], "dot.png", { type: "image/png" }),
    ]);
  });
  await waitFor(() => {
    const draft = getDraft(KEY);
    assert.equal(draft?.images.length, 1, "attaching is allowed while the agent runs");
  });
  return calls;
}

function typeText(text) {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
}

function pressEnter() {
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", code: "Enter" });
}

function assertQueuedWithImage(call, text) {
  assert.equal(call.message, text);
  assert.deepEqual(call.images?.map((image) => [image.data, image.mimeType]), [[PNG, "image/png"]]);
}

test("Enter during a run steers with the attached image, then clears it", async () => {
  const calls = await renderRunningWithAttachments();
  typeText("look at this");
  await act(async () => { pressEnter(); });
  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal(calls[0].name, "onSteer", "default submit-during-run behavior steers");
  assertQueuedWithImage(calls[0], "look at this");
  await waitFor(() => assert.equal(getDraft(KEY), null));
});

// This fork keeps the primary button as Stop whenever a run is streaming
// (ChatWindow passes isStreaming={sessionBusy}); the Queue button is the
// idle-state queueing affordance — exactly the props ChatWindow produces
// there — and it must carry the attachments like upstream's mid-run Queue.
test("the Queue button sends the text and the attached image as a follow-up", async () => {
  const calls = await renderRunningWithAttachments({ isStreaming: false });
  typeText("look at this");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /queue/i })); });
  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal(calls[0].name, "onFollowUp");
  assertQueuedWithImage(calls[0], "look at this");
});

test("a queued web slash command is expanded and keeps the attachment", async () => {
  const { expandWebSlashCommand } = await jiti.import("@/lib/web-slash-commands");
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const calls = await renderRunningWithAttachments();
  typeText("/goal ship it");
  await act(async () => { pressEnter(); });
  await waitFor(() => assert.equal(calls.length, 1));
  delete window.HTMLElement.prototype.scrollIntoView;
  assert.equal(calls[0].name, "onPromptWithStreamingBehavior");
  assertQueuedWithImage(calls[0], expandWebSlashCommand("/goal ship it").prompt);
});

// The hook's queue callbacks resolve false when omp refused the send: the
// message goes back, text and images together, to the draft it was sent
// from — ahead of anything typed since, even after a clear + retype.
test("a refused follow-up goes back whole to its draft, ahead of what was typed meanwhile", async () => {
  let refuse;
  const calls = await renderRunningWithAttachments({ isStreaming: false, queued: new Promise((resolve) => { refuse = () => resolve(false); }) });
  typeText("look at this");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /queue/i })); });
  await waitFor(() => assert.equal(calls.length, 1));
  typeText("typed meanwhile");
  await act(async () => { refuse(); });
  await waitFor(() => assert.deepEqual(getDraft(KEY)?.images, [{ data: PNG, mimeType: "image/png" }]));
  assert.equal(getDraft(KEY)?.value, `${calls[0].message}\n\ntyped meanwhile`, "the text comes back too, ahead of what was typed since");
  assert.equal(screen.getByRole("textbox").value, `${calls[0].message}\n\ntyped meanwhile`);
});

test("recovered images past the attachment cap all stay in the composer", async () => {
  const { MAX_ATTACHED_IMAGES } = await jiti.import("@/lib/image-attachments");
  const { recoverDraft } = await jiti.import("@/lib/draft-store");
  await renderRunningWithAttachments();
  const recovered = Array.from({ length: MAX_ATTACHED_IMAGES }, () => ({ data: PNG, mimeType: "image/png" }));
  await act(async () => { recoverDraft(KEY, { text: "", images: recovered }); });
  await waitFor(() => assert.equal(getDraft(KEY)?.images.length, MAX_ATTACHED_IMAGES + 1));
  assert.equal(document.querySelectorAll("img").length >= MAX_ATTACHED_IMAGES + 1, true, "every image has a preview to remove");
});
