import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";

// Reducer contract for the notice shelf, port of upstream 9b4f8e1e (#335):
// one failed run's error must never resurface from the queue after it was
// dismissed. Upstream tests this through the hook's render harness (their
// split `useAgentSession-notices.ts`); the fork's reducer lives inside the
// monolithic hook, so its contract is pinned directly.

const { noticeReducer } = await import("./useAgentSession.ts");

const MAX = 5;
const notice = (id, type = "info", message = id) => ({ id, type, message });

test("the shelf holds MAX notices; further ones queue", () => {
  let state = { visible: [], pending: [] };
  for (let i = 0; i < MAX; i += 1) state = noticeReducer(state, { type: "add", notice: notice(`n${i}`) });
  assert.deepEqual(state.visible.map((n) => n.id), ["n0", "n1", "n2", "n3", "n4"]);
  assert.deepEqual(state.pending.map((n) => n.id), []);
  state = noticeReducer(state, { type: "add", notice: notice("queued") });
  assert.deepEqual(state.visible.map((n) => n.id), ["n0", "n1", "n2", "n3", "n4"]);
  assert.deepEqual(state.pending.map((n) => n.id), ["queued"], "the overflow waits in the queue");
});

test("removing a visible notice promotes the queued one", () => {
  let state = { visible: [], pending: [] };
  for (let i = 0; i < MAX; i += 1) state = noticeReducer(state, { type: "add", notice: notice(`n${i}`) });
  state = noticeReducer(state, { type: "add", notice: notice("queued") });
  state = noticeReducer(state, { type: "remove", id: "n0" });
  assert.deepEqual(state.visible.map((n) => n.id), ["n1", "n2", "n3", "n4", "queued"]);
  assert.deepEqual(state.pending, []);
});

test("removing a queued notice drops it for good — #335: a dismissed error never resurfaces", () => {
  let state = { visible: [], pending: [] };
  for (let i = 0; i < MAX; i += 1) state = noticeReducer(state, { type: "add", notice: notice(`n${i}`, "error") });
  state = noticeReducer(state, { type: "add", notice: notice("late-error", "error") });
  // Dismiss the queued error by id while it is still queued.
  state = noticeReducer(state, { type: "remove", id: "late-error" });
  assert.deepEqual(state.pending, [], "the queue no longer holds the dismissed notice");
  // Removing a visible one afterwards must NOT resurrect it (upstream's bug:
  // fillPendingNotices pulled the removed id straight back onto the shelf).
  state = noticeReducer(state, { type: "remove", id: "n0" });
  assert.deepEqual(state.visible.map((n) => n.id), ["n1", "n2", "n3", "n4"]);
  assert.deepEqual(state.pending, []);
});

test("mark_oldest_exiting marks the first live notice once; add while one exits queues", () => {
  let state = noticeReducer({ visible: [], pending: [] }, { type: "add", notice: notice("a") });
  state = noticeReducer(state, { type: "mark_oldest_exiting" });
  assert.equal(state.visible[0].exiting, true);
  state = noticeReducer(state, { type: "mark_oldest_exiting" });
  assert.equal(state.visible.filter((n) => n.exiting).length, 1, "one exiting notice is enough");
  state = noticeReducer(state, { type: "add", notice: notice("b") });
  assert.deepEqual(state.visible.map((n) => n.id), ["a"], "an exiting shelf queues the new notice");
  assert.deepEqual(state.pending.map((n) => n.id), ["b"]);
});
