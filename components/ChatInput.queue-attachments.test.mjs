import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react/pure.js");

// Port of upstream da7eb347's rewrite of this file (it replaced the
// `queueAllowsAttachments` predicate unit tests when the gate came down).
// Adaptations: this fork's composer is image-only — non-image files insert
// their path as text (no folded-in content) — so every attached-text-file
// assertion is dropped and the picker attaches only an image; and the
// textarea is driven with fireEvent instead of user.type()/keyboard().
const { ChatInput } = await import("./ChatInput.tsx");
const { clearDraft, getDraft } = await import("@/lib/draft-store");

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
  const record = (name) => async (message, ...rest) => { calls.push({ name, message, images: rest.at(-1) }); return name === "onSend" ? { status: "accepted" } : queued; };
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

/**
 * Fork adaptation of upstream's `renderWithAttachments`: a composer with an
 * image attached (this fork's picker path), the queue callbacks resolving to
 * the awaited `queued` value, plus the `ref`/`rerender` handles the refusal and
 * identity-move tests drive. Returns nothing else; `calls` records every callback.
 */
async function renderWithAttachments({ queued = true, queueCallbacks = true, ...props } = {}) {
  const calls = [];
  const record = (name) => async (message, ...rest) => {
    calls.push({ name, message, images: rest.at(-1) });
    const ok = await queued;
    return name === "onSend" ? { status: ok ? "accepted" : "rejected" } : ok;
  };
  const ref = React.createRef();
  const inputProps = {
    ref,
    draftKey: KEY,
    isStreaming: true,
    onSend: record("onSend"),
    onAbort: record("onAbort"),
    onSteer: queueCallbacks ? record("onSteer") : undefined,
    onFollowUp: queueCallbacks ? record("onFollowUp") : undefined,
    onPromptWithStreamingBehavior: queueCallbacks ? record("onPromptWithStreamingBehavior") : undefined,
    ...props,
  };
  const view = render(React.createElement(ChatInput, inputProps));
  await act(async () => {
    ref.current.addFiles([
      new File([Buffer.from(PNG, "base64")], "dot.png", { type: "image/png" }),
    ]);
  });
  await waitFor(() => {
    const draft = getDraft(KEY);
    assert.equal(draft?.images.length, 1, "attaching is allowed while the agent runs");
  });
  return {
    calls,
    ref,
    rerender: (changes) => view.rerender(React.createElement(ChatInput, { ...inputProps, ...changes })),
  };
}

function pressEnter() {
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", code: "Enter" });
}

function assertQueuedWithImage(call, text) {
  assert.equal(call.message, text);
  assert.deepEqual(call.images?.map((image) => [image.data, image.mimeType]), [[PNG, "image/png"]]);
}

test("Enter during a run queues a follow-up with the attached image, then clears it", async () => {
  const calls = await renderRunningWithAttachments();
  typeText("look at this");
  await act(async () => { pressEnter(); });
  await waitFor(() => assert.equal(calls.length, 1));
  // Queueing is the default submit-during-run behavior: it is what survives a
  // web shell command owning the session (see lib/rpc-manager.ts).
  assert.equal(calls[0].name, "onFollowUp", "the default submit-during-run behavior queues");
  assertQueuedWithImage(calls[0], "look at this");
  await waitFor(() => assert.equal(getDraft(KEY), null));
});

test("a stored Steer preference still steers Enter during a run", async () => {
  localStorage.setItem("omp-web:submit-during-run", "steer");
  try {
    const calls = await renderRunningWithAttachments();
    typeText("look at this");
    await act(async () => { pressEnter(); });
    await waitFor(() => assert.equal(calls.length, 1));
    assert.equal(calls[0].name, "onSteer", "an explicit stored choice stays a steer");
    assertQueuedWithImage(calls[0], "look at this");
  } finally {
    localStorage.removeItem("omp-web:submit-during-run");
  }
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

test("a stored Steer preference turns the primary button into Steer, which steers like Enter", async () => {
  localStorage.setItem("omp-web:submit-during-run", "steer");
  const calls = await renderRunningWithAttachments({ isStreaming: false });
  typeText("look at this");
  assert.equal(screen.queryByRole("button", { name: /^queue$/i }), null, "the button no longer claims to queue");
  // The base-ui Tooltip renders no title attribute on its trigger, so the
  // steerNowTitle copy is verified via the trigger's presence: the same
  // primary-action button, relabelled, steering on click.
  const steer = screen.getByRole("button", { name: /^steer$/i });
  await act(async () => { fireEvent.click(steer); });
  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal(calls[0].name, "onSteer", "touch devices without Enter can steer");
  assertQueuedWithImage(calls[0], "look at this");
});

test("a queued web slash command is expanded and keeps the attachment", async () => {
  const { expandWebSlashCommand } = await import("@/lib/web-slash-commands");
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const calls = await renderRunningWithAttachments();
  typeText("/goal ship it");
  await act(async () => { pressEnter(); });
  await waitFor(() => assert.equal(calls.length, 1));
  delete window.HTMLElement.prototype.scrollIntoView;
  assert.equal(calls[0].name, "onPromptWithStreamingBehavior");
  assertQueuedWithImage(calls[0], expandWebSlashCommand("/goal ship it").prompt);
});

// #403: a queued send the browser store refused (the queue callback resolves
// false) goes back, text and images together, to the draft it was sent from —
// ahead of anything typed since. While the store commit is pending the message
// is not the composer's business: the transcript's held bubble is its only
// visible home (the composer's "Sending…" row was retired with the queue
// store; hooks/useAgentSession-outbox.test.mjs covers the bubble).
test("a refused queue send goes back whole to its draft, ahead of what was typed meanwhile", async () => {
  let refuse;
  const calls = await renderRunningWithAttachments({ isStreaming: false, queued: new Promise((resolve) => { refuse = () => resolve(false); }) });
  typeText("look at this");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /queue/i })); });
  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal(screen.queryByRole("status"), null, "no composer row while the held bubble carries the send");
  assert.equal(screen.getByRole("textbox").value, "", "the composer clears once the send is dispatched");
  typeText("typed meanwhile");
  await act(async () => { refuse(); });
  await waitFor(() => assert.deepEqual(getDraft(KEY)?.images, [{ data: PNG, mimeType: "image/png" }]));
  assert.equal(getDraft(KEY)?.value, `${calls[0].message}\n\ntyped meanwhile`, "the text comes back too, ahead of what was typed since");
  assert.equal(screen.getByRole("textbox").value, `${calls[0].message}\n\ntyped meanwhile`);
});

// Each in-flight send registers its recovery identity, so a confirmed Edit move
// retargets a send that was dispatched before the move.
test("a refused queue send follows a confirmed session move into its new draft", async (t) => {
  const targetKey = `${KEY}-moved`;
  t.after(() => clearDraft(targetKey));
  let refuse;
  const { calls, ref, rerender } = await renderWithAttachments({
    isStreaming: false,
    queued: new Promise((resolve) => { refuse = () => resolve(false); }),
  });
  typeText("look at this");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /queue/i })); });
  await waitFor(() => assert.equal(calls.length, 1));
  await act(async () => {
    ref.current.retargetPendingRecovery(KEY, targetKey);
    rerender({ draftKey: targetKey, draftIdentityMove: { from: KEY, to: targetKey } });
  });
  await act(async () => { refuse(); });
  await waitFor(() => assert.equal(getDraft(targetKey)?.value, calls[0].message, "a refusal follows the confirmed conversation"));
  assert.deepEqual(getDraft(targetKey)?.images, [{ data: PNG, mimeType: "image/png" }]);
  assert.equal(screen.getByRole("textbox").value, calls[0].message);
  assert.equal(getDraft(KEY), null, "the old draft is not recreated");
});

// A chat switch and return remounts the composer, so the refused send's
// identity belongs to a mount that no longer exists: the registry is what lets
// the late refusal still find the conversation the user moved to.
test("a refusal after remount and confirmed identity move recovers into the moved conversation", async (t) => {
  const targetKey = `${KEY}-remounted-moved`;
  t.after(() => clearDraft(targetKey));
  let refuse;
  const { calls } = await renderWithAttachments({
    isStreaming: false,
    queued: new Promise((resolve) => { refuse = () => resolve(false); }),
  });
  typeText("look at this");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /queue/i })); });
  await waitFor(() => assert.equal(calls.length, 1));
  cleanup();
  const props = { isStreaming: false, onSend: async () => ({ status: "accepted" }), onAbort() {}, onFollowUp: async () => true };
  render(React.createElement(ChatInput, { ...props, draftKey: "unrelated-chat" }));
  cleanup();
  const ref = React.createRef();
  const remounted = render(React.createElement(ChatInput, { ...props, ref, draftKey: KEY }));
  await act(async () => {
    ref.current.retargetPendingRecovery(KEY, targetKey);
    remounted.rerender(React.createElement(ChatInput, { ...props, ref, draftKey: targetKey, draftIdentityMove: { from: KEY, to: targetKey } }));
  });
  await act(async () => { refuse(); });
  await waitFor(() => assert.equal(getDraft(targetKey)?.value, calls[0].message));
  assert.deepEqual(getDraft(targetKey)?.images, [{ data: PNG, mimeType: "image/png" }]);
  assert.equal(screen.getByRole("textbox").value, calls[0].message);
});

test("recovered images past the attachment cap all stay in the composer", async () => {
  const { MAX_ATTACHED_IMAGES } = await import("@/lib/image-attachments");
  const { recoverDraft } = await import("@/lib/draft-store");
  await renderRunningWithAttachments();
  const recovered = Array.from({ length: MAX_ATTACHED_IMAGES }, () => ({ data: PNG, mimeType: "image/png" }));
  await act(async () => { recoverDraft(KEY, { text: "", images: recovered }); });
  await waitFor(() => assert.equal(getDraft(KEY)?.images.length, MAX_ATTACHED_IMAGES + 1));
  assert.equal(document.querySelectorAll("img").length >= MAX_ATTACHED_IMAGES + 1, true, "every image has a preview to remove");
});

// Reported bug: an idle `/goal …` with an attached file skipped the web
// command path entirely — the raw slash text reached omp as a literal
// message and its goal marker was never set. Prompt-composing commands
// must reach the builtin handler with the images so the expanded prompt
// (and the marker side effect) happens with the attachments riding along.
test("an idle web command with an attached image goes to the builtin with the image", async () => {
  const calls = [];
  const ref = React.createRef();
  render(React.createElement(ChatInput, {
    ref,
    draftKey: KEY,
    isStreaming: false,
    onSend: async (message, images) => { calls.push({ name: "onSend", message, images }); return { status: "accepted" }; },
    onBuiltinCommand: async (message, images) => {
      calls.push({ name: "builtin", message, images });
      return { handled: true };
    },
  }));
  await act(async () => {
    ref.current.addFiles([
      new File([Buffer.from(PNG, "base64")], "dot.png", { type: "image/png" }),
    ]);
  });
  await waitFor(() => assert.equal(getDraft(KEY)?.images.length, 1));
  // The slash palette opens while typing; jsdom has no scrollIntoView
  // (same stand-in as the queued-expansion test).
  window.HTMLElement.prototype.scrollIntoView = () => {};
  typeText("/goal ship it");
  await act(async () => { pressEnter(); });
  await waitFor(() => assert.equal(calls.length, 1));
  delete window.HTMLElement.prototype.scrollIntoView;
  assert.equal(calls[0].name, "builtin", "the web command must not fall through to a raw send");
  assert.equal(calls[0].message, "/goal ship it");
  assertQueuedWithImage(calls[0], "/goal ship it");
  await waitFor(() => assert.equal(getDraft(KEY), null), "a handled command clears the composer and its attachment");
});

// Action builtins (copy/compact/…) cannot carry attachments: with an image
// attached they keep the old raw send, so the file is never silently
// dropped by a handled non-prompt command.
test("an action command with an attached image keeps the raw send", async () => {
  const calls = [];
  const ref = React.createRef();
  render(React.createElement(ChatInput, {
    ref,
    draftKey: KEY,
    isStreaming: false,
    onSend: async (message, images) => { calls.push({ name: "onSend", message, images }); return { status: "accepted" }; },
    onBuiltinCommand: async (message, images) => {
      calls.push({ name: "builtin", message, images });
      return { handled: true };
    },
  }));
  await act(async () => {
    ref.current.addFiles([
      new File([Buffer.from(PNG, "base64")], "dot.png", { type: "image/png" }),
    ]);
  });
  await waitFor(() => assert.equal(getDraft(KEY)?.images.length, 1));
  window.HTMLElement.prototype.scrollIntoView = () => {};
  // A trailing-argument command line: a bare "/copy" would leave the slash
  // palette open and Enter would apply the completion instead of sending.
  typeText("/copy the last reply");
  await act(async () => { pressEnter(); });
  await waitFor(() => assert.equal(calls.length, 1));
  delete window.HTMLElement.prototype.scrollIntoView;
  assert.equal(calls[0].name, "onSend", "the attachment must travel with the raw text, not be dropped");
  assertQueuedWithImage(calls[0], "/copy the last reply");
});
