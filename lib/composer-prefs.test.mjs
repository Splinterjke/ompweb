import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

async function loadSubject() {
  return import("./composer-prefs.ts");
}

function fakeWindow({ finePointer, stored, submitDuringRun }) {
  const entries = [];
  if (stored !== undefined) entries.push(["omp-web:word-completion", stored]);
  if (submitDuringRun !== undefined) entries.push(["omp-web:submit-during-run", submitDuringRun]);
  const store = new Map(entries);
  globalThis.window = {
    localStorage: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) },
    matchMedia: (query) => ({ matches: query === "(pointer: fine)" && finePointer }),
  };
}

afterEach(() => {
  delete globalThis.window;
});

test("submitting during a run defaults to queue; only a stored choice overrides it", async () => {
  const { getSubmitDuringRunBehavior, setSubmitDuringRunBehavior } = await loadSubject();
  // No window at all (SSR prerender) — the default must not need a client.
  assert.equal(getSubmitDuringRunBehavior(), "queue");
  // Nothing stored: the new default, and an unrelated stored key changes nothing.
  fakeWindow({ finePointer: true });
  assert.equal(getSubmitDuringRunBehavior(), "queue");
  fakeWindow({ finePointer: true, stored: "steer" });
  assert.equal(getSubmitDuringRunBehavior(), "queue");
  // An explicit choice still wins, both ways, and round-trips through the setter.
  fakeWindow({ finePointer: true, submitDuringRun: "steer" });
  assert.equal(getSubmitDuringRunBehavior(), "steer");
  setSubmitDuringRunBehavior("queue");
  assert.equal(getSubmitDuringRunBehavior(), "queue");
  // Junk in the key is not a choice: it falls back to the new default.
  fakeWindow({ finePointer: true, submitDuringRun: "sometimes" });
  assert.equal(getSubmitDuringRunBehavior(), "queue");
});

test("word completion defaults to auto: on with a mouse/trackpad, off on touch", async () => {
  const { getWordCompletionMode, isWordCompletionEnabled } = await loadSubject();
  fakeWindow({ finePointer: true });
  assert.equal(getWordCompletionMode(), "auto");
  assert.equal(isWordCompletionEnabled(), true);
  fakeWindow({ finePointer: false });
  assert.equal(isWordCompletionEnabled(), false);
});

test("Enabled and Disabled override the pointer heuristic; junk falls back to auto", async () => {
  const { isWordCompletionEnabled, setWordCompletionMode, getWordCompletionMode } = await loadSubject();
  fakeWindow({ finePointer: false, stored: "on" });
  assert.equal(isWordCompletionEnabled(), true);
  setWordCompletionMode("off");
  fakeWindow({ finePointer: true, stored: "off" });
  assert.equal(isWordCompletionEnabled(), false);
  fakeWindow({ finePointer: true, stored: "sometimes" });
  assert.equal(getWordCompletionMode(), "auto");
});
