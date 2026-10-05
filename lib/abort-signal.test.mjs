import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { timeoutSignal } = await jiti.import("./abort-signal.ts");

test("timeoutSignal aborts after the delay", async () => {
  const { signal, clear } = timeoutSignal(10);
  await new Promise((resolve) => signal.addEventListener("abort", resolve));
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason.name, "TimeoutError");
  clear();
});

test("timeoutSignal follows its parent and clear() cancels the timer", async () => {
  const parent = new AbortController();
  const followed = timeoutSignal(60_000, parent.signal);
  parent.abort();
  assert.equal(followed.signal.aborted, true);
  followed.clear();

  const idle = timeoutSignal(20);
  idle.clear();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(idle.signal.aborted, false);
});

test("an already-aborted parent aborts immediately", () => {
  const parent = new AbortController();
  parent.abort();
  const { signal, clear } = timeoutSignal(60_000, parent.signal);
  assert.equal(signal.aborted, true);
  clear();
});
