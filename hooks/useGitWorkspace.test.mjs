import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createJiti } from "jiti";

// React ships `act` only in its development build; force NODE_ENV before any
// React module loads so these tests work regardless of the environment's
// default (production builds throw "act(...) is not supported").
process.env.NODE_ENV = "test";
const { act, cleanup, renderHook } = await import("@testing-library/react/pure.js");

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { useGitWorkspace } = await jiti.import("./useGitWorkspace.ts");

// The GitGraph button reads this probe. Since the workspace operations moved to
// the host daemon, `/api/git/status` answers 403 for a folder the host has not
// authorized, 503 while the host is offline, and an error for a folder that no
// longer exists — none of which says anything about git. Collapsing them into
// `false` is what made a working repository read as "not a git repository".

const realFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = realFetch; });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Answers `/api/git/status?cwd=` with each scripted outcome in turn. */
function script(t, ...outcomes) {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    const outcome = outcomes[Math.min(urls.length - 1, outcomes.length - 1)];
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  t.after(() => { globalThis.fetch = realFetch; });
  return urls;
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const denied = { ok: false, status: 403, json: async () => ({ error: "Access denied", code: "access_denied" }) };

test("a refused probe leaves the workspace unprobed and flagged unavailable", async (t) => {
  script(t, denied);
  const { result } = renderHook(() => useGitWorkspace("C:/Work/ompweb"));
  await act(async () => { await sleep(0); });
  assert.equal(result.current.isRepository, null, "an error is not a 'not a git repository' answer");
  assert.equal(result.current.unavailable, true);
});

test("a network failure is not an answer either", async (t) => {
  script(t, new Error("connection refused"));
  const { result } = renderHook(() => useGitWorkspace("C:/Work/ompweb"));
  await act(async () => { await sleep(0); });
  assert.equal(result.current.isRepository, null);
  assert.equal(result.current.unavailable, true);
});

test("an answered probe reports the repository flag both ways", async (t) => {
  script(t, ok({ isGitRepository: false }));
  const { result, rerender } = renderHook(({ cwd }) => useGitWorkspace(cwd), { initialProps: { cwd: "C:/temp/notes" } });
  await act(async () => { await sleep(0); });
  assert.equal(result.current.isRepository, false, "a real answer may say no");
  assert.equal(result.current.unavailable, false);

  script(t, ok({ isGitRepository: true, branch: "master" }));
  await act(async () => { rerender({ cwd: "C:/Work/ompweb" }); });
  assert.equal(result.current.isRepository, true);
});

test("a failed probe retries, and a recovered answer clears the flag", async (t) => {
  const urls = script(t, denied, ok({ isGitRepository: true }));
  const { result } = renderHook(() => useGitWorkspace("C:/Work/ompweb"));
  await act(async () => { await sleep(0); });
  assert.equal(urls.length, 1);
  assert.equal(result.current.unavailable, true);
  // The first backoff step is 2 s; the retry must find the now-answering host.
  await act(async () => {
    for (let i = 0; i < 60 && result.current.isRepository !== true; i++) await sleep(100);
  });
  assert.equal(result.current.isRepository, true, "a failed probe is retried");
  assert.equal(result.current.unavailable, false);
  assert.ok(urls.length >= 2);
  // A recovered answer must not keep probing: the count settles where it is.
  const settled = urls.length;
  await act(async () => { await sleep(300); });
  assert.equal(urls.length, settled, "a recovered probe stops retrying");
});

test("no cwd means no probe and no claim", async (t) => {
  const urls = script(t, ok({ isGitRepository: true }));
  const { result } = renderHook(() => useGitWorkspace(null));
  await act(async () => { await sleep(0); });
  assert.equal(urls.length, 0);
  assert.equal(result.current.isRepository, null);
  assert.equal(result.current.unavailable, false);
});
