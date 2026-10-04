import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { after, afterEach, beforeEach } from "node:test";

// React only ships `act` in its development build; force NODE_ENV before any
// React module is loaded so these tests work regardless of the environment's
// default (production builds throw "act(...) is not supported").
process.env.NODE_ENV = "test";
const React = (await import("react")).default;
const { act, cleanup, fireEvent, render, screen } = await import("@testing-library/react/pure.js");
const { createJiti } = await import("jiti");

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { clearDraft, getDraft } = await jiti.import("@/lib/draft-store");

// jsdom ships neither matchMedia nor object URLs, and Node no FileReader; the
// composer touches all three when a draft or an image attachment is edited.
// setup-dom.mjs tears the DOM globals back down after this file's tests, so
// hold the window reference now and restore only what this file replaces.
const domWindow = window;
const previousMatchMedia = domWindow.matchMedia;
const previousFileReader = globalThis.FileReader;
URL.createObjectURL = () => `blob:btw-${Math.random().toString(36).slice(2)}`;
URL.revokeObjectURL = () => {};
class TestFileReader {
  result = null;
  error = null;
  onload = null;
  onerror = null;

  readAsDataURL(blob) {
    setTimeout(() => {
      blob
        .arrayBuffer()
        .then((buffer) => {
          this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`;
          this.onload?.();
        })
        .catch((error) => {
          this.error = error;
          this.onerror?.(error);
        });
    }, 0);
  }
}

beforeEach(() => {
  domWindow.matchMedia = (media) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} });
  // Typing "/" opens the slash menu, which scrolls its active row into view.
  domWindow.HTMLElement.prototype.scrollIntoView = () => {};
  globalThis.FileReader = TestFileReader;
});
afterEach(() => {
  cleanup();
  clearDraft("btw-draft");
  localStorage.clear();
});
after(() => {
  if (previousMatchMedia) domWindow.matchMedia = previousMatchMedia;
  else delete domWindow.matchMedia;
  if (previousFileReader) globalThis.FileReader = previousFileReader;
  else delete globalThis.FileReader;
  delete domWindow.HTMLElement.prototype.scrollIntoView;
});

/** Pump timers inside act() until `done()` or the budget is spent. */
async function pump(done = () => false, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    if (done()) return;
  }
}

/** Every way the composer can hand text to the agent, recorded by name. */
function renderComposer(props) {
  const calls = [];
  const record = (name) => (...args) => { calls.push([name, args[0]]); };
  const ref = React.createRef();
  render(React.createElement(ChatInput, {
    ref,
    draftKey: "btw-draft",
    onAbort() {},
    isStreaming: false,
    onSend: record("onSend"),
    onSteer: record("onSteer"),
    onFollowUp: record("onFollowUp"),
    onPromptWithStreamingBehavior: record("onPromptWithStreamingBehavior"),
    onBuiltinCommand: async (text) => { calls.push(["onBuiltinCommand", text]); return { handled: true }; },
    ...props,
  }));
  return { calls, ref };
}

async function submitText(text) {
  const textbox = screen.getByRole("textbox");
  await act(async () => { fireEvent.change(textbox, { target: { value: text } }); });
  await act(async () => { fireEvent.keyDown(textbox, { key: "Enter" }); });
}

for (const isStreaming of [false, true]) {
  test(`/btw goes to the side-question command, never the agent, ${isStreaming ? "while a run streams" : "when idle"}`, async () => {
    const { calls } = renderComposer({ isStreaming });
    await submitText("/btw what is 2+2");
    await pump(() => calls.length > 0, 100);
    assert.deepEqual(calls, [["onBuiltinCommand", "/btw what is 2+2"]]);
    await pump(() => screen.getByRole("textbox").value === "", 100);
    assert.equal(screen.getByRole("textbox").value, "");
  });
}

test("/btw with an attachment is refused and keeps the draft and the attachment", async () => {
  const { calls, ref } = renderComposer({ isStreaming: false });
  await act(async () => {
    ref.current.addFiles([new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", { type: "image/png" })]);
  });
  // The attachment must land in the draft before the refusal is meaningful:
  // the read goes through the modeled FileReader on a macrotask.
  await pump(() => (getDraft("btw-draft")?.images.length ?? 0) > 0);
  assert.equal(getDraft("btw-draft")?.images.length, 1);
  await submitText("/btw what is this");
  await pump(() => calls.length > 0, 20);
  assert.deepEqual(calls, []);
  assert.equal(screen.getByRole("textbox").value, "/btw what is this");
  assert.equal(getDraft("btw-draft")?.images.length, 1);
});
