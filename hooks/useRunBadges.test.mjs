import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// React ships `act` only in its development build; force NODE_ENV before any
// React module loads (see the useAgentSession.rpc.test.mjs pattern).
process.env.NODE_ENV = "test";
const { act, cleanup, renderHook } = await import("@testing-library/react/pure.js");

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { useRunBadges } = await jiti.import("./useRunBadges.ts");

// Short TTL so the expiry semantics are exercised without waiting 15s.
const TTL_MS = 40;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Feed a full `running`-frame snapshot through the same entry point the
 *  sidebar's event-stream handler uses. */
const runningFrame = (view, ids) => act(() => view.result.current.applyAuthoritative(ids));

test("external badge expires once the CLI writes stop refreshing it", async () => {
  const view = renderHook(() => useRunBadges(TTL_MS));
  act(() => view.result.current.markExternallyRunning(["cli-session"]));
  assert.ok(view.result.current.runningSessionIds.has("cli-session"), "external mark badges immediately");
  await act(async () => { await sleep(TTL_MS * 2); });
  assert.ok(!view.result.current.runningSessionIds.has("cli-session"), "badge expires once writes stop");
  view.unmount();
  cleanup();
});

test("regression: expiry must never delete an id the running feed re-claimed", async () => {
  const view = renderHook(() => useRunBadges(TTL_MS));
  // The wrapper's running flags were momentarily false (the auto-compaction /
  // maintenance window), so the file-activity feed marked the session as
  // externally running and armed its TTL...
  act(() => view.result.current.markExternallyRunning(["long-run"]));
  // ...seconds later the continuation turn resumed and the authoritative RPC
  // snapshot claimed the id again — the session IS running.
  runningFrame(view, ["long-run"]);
  await act(async () => { await sleep(TTL_MS * 2); });
  assert.ok(
    view.result.current.runningSessionIds.has("long-run"),
    "a stale external expiry must not erase the badge of a running session",
  );
  view.unmount();
  cleanup();
});

test("an authoritative claim skips TTL arming for its own ids", async () => {
  const view = renderHook(() => useRunBadges(TTL_MS));
  runningFrame(view, ["web-run"]);
  act(() => view.result.current.markExternallyRunning(["web-run"]));
  await act(async () => { await sleep(TTL_MS * 2); });
  assert.ok(view.result.current.runningSessionIds.has("web-run"), "the running feed has no expiry");
  view.unmount();
  cleanup();
});

test("the running snapshot replaces the set and drops stale external ids", () => {
  const view = renderHook(() => useRunBadges(TTL_MS));
  act(() => view.result.current.markExternallyRunning(["gone-cli"]));
  runningFrame(view, ["web-run"]);
  assert.ok(view.result.current.runningSessionIds.has("web-run"));
  assert.ok(!view.result.current.runningSessionIds.has("gone-cli"), "authoritative snapshot is the whole set");
  view.unmount();
  cleanup();
});

test("an id dropped from the snapshot can be marked external again and expires again", async () => {
  const view = renderHook(() => useRunBadges(TTL_MS));
  runningFrame(view, ["moved-to-cli"]);
  runningFrame(view, []);
  act(() => view.result.current.markExternallyRunning(["moved-to-cli"]));
  assert.ok(view.result.current.runningSessionIds.has("moved-to-cli"));
  await act(async () => { await sleep(TTL_MS * 2); });
  assert.ok(!view.result.current.runningSessionIds.has("moved-to-cli"), "the re-armed expiry still applies");
  view.unmount();
  cleanup();
});

test("unmount clears pending expiry timers without leaking state updates", async () => {
  const view = renderHook(() => useRunBadges(TTL_MS));
  act(() => view.result.current.markExternallyRunning(["cli-a", "cli-b"]));
  view.unmount();
  await act(async () => { await sleep(TTL_MS * 2); });
  // No assertion of state after unmount is possible — reaching this point
  // without an unhandled rejection or act() warning is the contract.
  cleanup();
});
