import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// React ships `act` only in its development build; force NODE_ENV before any
// React module loads so these tests work regardless of the environment's
// default (production builds throw "act(...) is not supported").
process.env.NODE_ENV = "test";
const { act, cleanup, renderHook } = await import("@testing-library/react/pure.js");

// Port of the upstream behavioral harness `hooks/useAgentSession.rpc.test.mjs`
// (upstream 45b346ef) for this repo's monolithic hooks/useAgentSession.ts:
// the chat state machine driven through a controllable fake EventSource +
// fetch router via React Testing Library — connection, streaming, reconcile,
// send — not source-string checks.
//
// Adaptations from the upstream scaffolding (the local hook structurally
// lacks the mechanisms those parts drove):
// - No wrapper/session-sync machinery (world.wrappers/live/views/streams,
//   selectSessionHistory, AgentSessionWrapper): those exist only in the
//   upstream split files (useAgentSession-stream.ts etc.) and are not part
//   of the ported blocks.
// - No boundary=1 route: the local send path never pre-reads the session
//   file (upstream's snapshotRunEntries has no local counterpart), so the
//   session-file 404 that upstream #183 handled in the send path lives in
//   the hydration read here.
// - GET /api/agent/<id> answers 404 for ids the fake world does not know.
//   Upstream's stub answered 200 for ANY unknown id, which upstream's own
//   a6ebcc7e review calls out as unfaithful ("the real route resolves the
//   id against the on-disk file whenever no wrapper is alive"); this router
//   models the real app/api/agent/[id]/route.ts behavior instead.
// - Toast stub alias dropped: the local jiti config transpiles JSX
//   (hooks/useBtw.test.mjs pattern), and the ported blocks never toast.
//
// Skipped upstream blocks (already landed locally without this harness —
// see the port notes): the queue-mirror suite (queue snapshot/cancel/Stop
// withdrawal — covered by the local queue port), the #167 unknown-command
// blocks (stateful send-warning in handleSend; the pure predicates are
// pinned by hooks/useAgentSession-commands.test.mjs), btw/fork/catch-up
// suites (mechanisms absent or ported differently here).

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { useAgentSession } = await jiti.import("./useAgentSession.ts");

// ---------------------------------------------------------------------------
// Fake EventSource + fetch router
// ---------------------------------------------------------------------------
class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  constructor(url) {
    this.url = String(url);
    this.readyState = FakeEventSource.CONNECTING;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.closedByCaller = false;
    world.esInstances.push(this);
  }
  open() {
    if (this.closedByCaller) return;
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.({});
    this.onmessage?.({ data: JSON.stringify({ type: "connected" }) });
  }
  emit(event) {
    if (this.closedByCaller) return;
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  failFatal() {
    // Browser-facing fatal error (404/500): readyState CLOSED + onerror.
    if (this.closedByCaller) return;
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.({});
  }
  close() {
    this.closedByCaller = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function jsonResponse(status, value) {
  return { ok: status >= 200 && status < 300, status, json: async () => value };
}

// Backend snapshot the router serves. Tests mutate these between phases.
const world = {
  esInstances: [],
  calls: [],
  holds: [], // { match(method, url, body), produce: () => Promise<{ status, value }> }
  sessions: new Map(), // sid -> { leafId, messages, entryIds } served by /api/sessions/<id>
  agents: new Map(), // sid -> { running, state } served by /api/agent/<id> (the live RPC world)
  btwHistory: new Map(), // sid -> BtwRecord[] served by get_btw_history
};

async function fetchStub(url, init = {}) {
  const method = (init.method ?? "GET").toUpperCase();
  const u = String(url);
  const body = typeof init.body === "string" ? safeParse(init.body) : null;
  world.calls.push({ method, url: u, body });

  for (let i = 0; i < world.holds.length; i++) {
    if (world.holds[i].match(method, u, body)) {
      const h = world.holds.splice(i, 1)[0];
      const { status = 200, value } = await h.produce();
      return jsonResponse(status, value);
    }
  }

  let m;
  if ((m = u.match(/\/api\/sessions\/([^/?#]+)\/state/))) {
    const a = world.agents.get(decodeURIComponent(m[1])) ?? { running: false, state: {} };
    return jsonResponse(200, { running: a.running, state: a.state });
  }
  if (/\/api\/sessions\/[^/?#]+\/subagents/.test(u)) {
    return jsonResponse(200, { subagents: [] });
  }
  if ((m = u.match(/\/api\/sessions\/([^/?#]+)/)) && method === "GET") {
    const sid = decodeURIComponent(m[1]);
    const f = world.sessions.get(sid);
    if (!f) return jsonResponse(404, {});
    return jsonResponse(200, {
      sessionId: sid, filePath: "/fixture/session.jsonl", tree: f.tree ?? [],
      leafId: f.leafId,
      context: { todoPhases: [], thinkingLevel: "off", model: null, ...f },
    });
  }
  if (/^\/api\/models/.test(u)) {
    return jsonResponse(200, { models: {}, modelList: [], defaultModel: null });
  }
  if ((m = u.match(/\/api\/agent\/([^/?#]+)/))) {
    const sid = decodeURIComponent(m[1]);
    if (method === "GET") {
      // Faithful to the real route: an id with neither a live wrapper nor an
      // on-disk file is not found (a6ebcc7e review; the stub here keeps the
      // live wrapper in world.agents, so an unknown id means both are gone).
      const a = world.agents.get(sid);
      if (!a) return jsonResponse(404, { error: "Session not found", code: "session_not_found" });
      return jsonResponse(200, { running: a.running, state: a.state });
    }
    if (method === "POST") {
      if (!world.agents.has(sid)) {
        return jsonResponse(404, { error: "Session not found", code: "session_not_found" });
      }
      if (body?.type === "get_subagents") {
        return jsonResponse(200, { success: true, data: { subagents: [] } });
      }
      if (body?.type === "get_btw_history") {
        return jsonResponse(200, { success: true, data: { records: world.btwHistory.get(sid) ?? [] } });
      }
      // omp before abort_and_restore_queue rejects it (its real wording), which keeps the
      // per-entry withdrawal tests on their fallback path; tests of the atomic
      // path set what omp hands back.
      if (body?.type === "abort_and_restore_queue") {
        return world.abortRestoreQueue
          ? jsonResponse(200, { success: true, data: world.abortRestoreQueue })
          : jsonResponse(400, { error: "Unknown command: abort_and_restore_queue", code: "rpc_command_failed" });
      }
      return jsonResponse(200, { success: true, data: {} });
    }
  }
  return jsonResponse(404, {});
}

// Keep real DOM event targets and storage; only browser state and network
// boundaries need doubles. Hidden tabs use the coalescer's 50ms timer.
let visibilityState = "hidden";
const overrides = [
  [globalThis, "EventSource", { value: FakeEventSource }],
  [globalThis, "fetch", { value: fetchStub }],
  [document, "hidden", { get: () => visibilityState === "hidden" }],
  [document, "visibilityState", { get: () => visibilityState }],
  [window, "matchMedia", {
    value: (media) => Object.assign(new window.EventTarget(), { matches: false, media }),
  }],
].map(([target, key, replacement]) => ({
  target, key, replacement, original: Object.getOwnPropertyDescriptor(target, key),
}));

beforeEach(() => {
  visibilityState = "hidden";
  localStorage.clear();
  sessionStorage.clear();
  for (const { target, key, replacement } of overrides) {
    Object.defineProperty(target, key, { configurable: true, ...replacement });
  }
});

afterEach(() => {
  try {
    cleanup();
  } finally {
    for (const { target, key, original } of overrides) {
      if (original) Object.defineProperty(target, key, original);
      else delete globalThis[key];
    }
    localStorage.clear();
    sessionStorage.clear();
  }
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run pending timers/microtasks inside act so state updates are flushed. */
async function settle(ms = 120) {
  await act(async () => {
    await sleep(ms);
  });
}

function sessionInfo(sid) {
  return {
    id: sid,
    path: "",
    cwd: "/workspace",
    name: `session ${sid}`,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "loaded question",
  };
}

async function mountSession(sid, onAgentEnd, options = {}, strictMode = false) {
  const session = sid === null ? null : sessionInfo(sid);
  const { result, unmount } = renderHook(() => useAgentSession({
    session, newSessionCwd: null, ...(onAgentEnd ? { onAgentEnd } : {}), ...options,
  }), { reactStrictMode: strictMode });
  await settle(); // hydration: loadSession + /state + models + subagents
  return {
    unmount,
    get latest() {
      return result.current;
    },
  };
}

function lastEs() {
  return world.esInstances[world.esInstances.length - 1];
}

function callsTo(method, urlPart) {
  return world.calls.filter((c) => c.method === method && c.url.includes(urlPart));
}

function resetWorld() {
  world.esInstances.length = 0;
  world.calls.length = 0;
  world.holds.length = 0;
  world.sessions.clear();
  world.agents.clear();
  world.btwHistory.clear();
  world.abortRestoreQueue = null;
  sessionStorage.clear();
}

function primeSession(sid, messages) {
  world.sessions.set(sid, {
    leafId: String(messages.length),
    messages,
    entryIds: messages.map((_, i) => `e${i}`),
  });
  world.agents.set(sid, { running: false, state: {} });
}

const userMsg = (id, text) => ({ role: "user", id, content: text, timestamp: 1 });
const assistantMsg = (id, text) => ({
  role: "assistant",
  id,
  provider: "test",
  model: "test-model",
  content: [{ type: "text", text }],
});

/** Mount + hydrate, then send a prompt and open the stream. Returns the ES. */
async function startRun(sid, message, strictMode = false, options = {}) {
  const w = await mountSession(sid, undefined, options, strictMode);
  assert.equal(w.latest.loading, false, "hydration must complete");
  assert.equal(w.latest.agentRunning, false);

  let sendPromise;
  await act(async () => {
    sendPromise = w.latest.handleSend(message);
    await sleep(30); // let the pre-connect get_state POST settle
  });
  const es = lastEs();
  assert.ok(es, "an EventSource must have been created");
  assert.match(es.url, /\/api\/agent\/.+\/events$/);
  await act(async () => {
    es.open(); // connect settles → prompt POST fires
    await sendPromise;
  });
  assert.equal(w.latest.agentRunning, true, "optimistic running state");
  assert.equal(callsTo("POST", "/api/agent/").some((c) => c.body?.type === "prompt" && c.body?.message === message), true, "prompt command must be sent");
  return { w, es };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Port of upstream 2152c67e: a session whose only prompts were local slash
// commands never started an agent run, so omp wrote no session file: the
// session-file reads 404 while the live RPC wrapper answers normally.
// Adaptation: upstream applied the 404 tolerance inside its pre-send
// boundary read (snapshotRunEntries); the local send path performs no such
// read, so the 404 tolerance belongs to the hydration read. The send
// assertions are unchanged; the hydration assertion is STRENGTHENED (never
// weakened): hydration must not merely stop spinning but resolve the
// session through the live RPC world — the local stand-in for upstream's
// "hydration completes without a file" actually completing.
test("send tolerates a missing session file (local-only slash commands) and still dispatches", async () => {
  resetWorld();
  world.agents.set("fileless", { running: false, state: {} });
  const w = await mountSession("fileless");
  assert.equal(w.latest.loading, false, "hydration completes without a file");
  assert.equal(w.latest.agentRunning, false);
  assert.notEqual(w.latest.data, null, "hydration must resolve the session through the live RPC world, not bail on the 404");

  let sendPromise;
  await act(async () => {
    sendPromise = w.latest.handleSend("hello after skill");
    await sleep(30);
  });
  const es = lastEs();
  await act(async () => {
    es.open();
    await sendPromise;
  });
  assert.equal(
    callsTo("POST", "/api/agent/fileless").some((c) => c.body?.type === "prompt" && c.body?.message === "hello after skill"),
    true,
    "prompt must be dispatched despite the boundary 404",
  );
  assert.equal(w.latest.agentRunning, true, "run starts optimistically");
  assert.equal(w.latest.notices.length, 0, "no failed-send notice");
});

// Second half of the 2152c67e port: on a session whose file route 404s while
// a wrapper is genuinely mid-run, hydration must restore the live run from
// the RPC world. Before the tolerance, the 404 bailed hydration before the
// state read, leaving a live run rendered as an idle, empty transcript.
test("a 404 session file with a live wrapper mid-run hydrates the run from the RPC world", async () => {
  resetWorld();
  // No session file (never written, or unreadable — the file route 404s
  // both), while /api/agent answers the live wrapper state.
  world.agents.set("corrupt-midrun", { running: true, state: { isStreaming: true, isPromptRunning: false } });
  const w = await mountSession("corrupt-midrun");
  assert.equal(w.latest.loading, false, "hydration completes without a file");
  assert.equal(w.latest.agentRunning, true, "the live run must be restored, not shown idle");
  assert.ok(
    world.esInstances.some((e) => e.url.includes("/api/agent/corrupt-midrun/events")),
    "the observer stream must attach to the restored run",
  );
});

// Port of upstream a6ebcc7e (REVIEW #165): on THIS repo's server a fileless
// session with a live wrapper already gets a synthesized empty transcript
// from the file route (app/api/sessions/[id]/route.ts:174-209 — the local
// equivalent of upstream aa617860), modeled here by the hold. Upstream's
// own note applies: this already dispatches on the unfixed client; it pins
// that the guarantee cannot regress.
test("REVIEW #165: a fileless LIVE session already gets an empty baseline, so main dispatches", async () => {
  resetWorld();
  world.agents.set("fileless-live", { running: true, state: { isStreaming: false, isPromptRunning: false } });
  world.holds.push({
    // The local route answers the session GET itself (upstream answered
    // the boundary read); same semantics: live wrapper vouches, empty
    // baseline, no 404.
    match: (method, url) => method === "GET" && url.startsWith("/api/sessions/fileless-live?"),
    produce: async () => ({
      status: 200,
      value: {
        sessionId: "fileless-live", filePath: "", tree: [], leafId: null,
        context: { messages: [], entryIds: [], todoPhases: [], thinkingLevel: "off", model: null },
      },
    }),
  });
  const w = await mountSession("fileless-live");
  assert.equal(w.latest.loading, false);

  let sendPromise;
  await act(async () => {
    sendPromise = w.latest.handleSend("hello after skill");
    await sleep(30);
  });
  const es = lastEs();
  await act(async () => {
    es.open();
    await sendPromise;
  });
  assert.equal(
    callsTo("POST", "/api/agent/fileless-live").some((c) => c.body?.type === "prompt" && c.body?.message === "hello after skill"),
    true,
    "unfixed main already dispatches when the live wrapper answers the baseline",
  );
  assert.equal(w.latest.notices.length, 0, "no failed-send notice");
  assert.equal(w.latest.agentRunning, true);
});

// Port of upstream a6ebcc7e (guardrail): a vanished session with neither a
// wrapper nor a file must still fail loudly — the fileless tolerance must
// not swallow a real error. The faithful GET /api/agent 404 for unknown ids
// makes the hydration probe bail exactly like the real route.
test("REVIEW a vanished session with no wrapper still fails loudly (real failure not swallowed)", async () => {
  resetWorld();
  // The real agent route resolves the id against the on-disk file whenever
  // no wrapper is alive (app/api/agent/[id]/route.ts), so this 404 is what
  // a genuinely missing session produces.
  world.holds.push({
    match: (method, url) => method === "POST" && url.includes("/api/agent/gone"),
    produce: async () => ({ status: 404, value: { error: "Session not found", code: "session_not_found" } }),
  });
  const w = await mountSession("gone");
  let ok;
  await act(async () => {
    ok = await w.latest.handleSend("anyone there?");
    await sleep(30);
  });
  assert.equal(ok, false, "the send must not report success");
  assert.equal(w.latest.agentRunning, false, "the optimistic run state is rolled back");
  assert.equal(w.latest.notices.length, 1, "the failure is surfaced, not swallowed");
  assert.equal(w.latest.notices[0].type, "error");
  assert.equal(
    callsTo("POST", "/api/agent/gone").some((c) => c.body?.type === "prompt"),
    false,
    "no prompt is dispatched into a vanished session",
  );
});

// Port of upstream a6ebcc7e (REVIEW #183): an EXISTING but unresolvable
// session file 404s the file route while the wrapper still takes commands —
// aborting the send there loses the message. Adaptation: the boundary hold
// is dropped because the local send performs no boundary read; the file
// 404 is modeled by the absent sessions entry (router 404s
// /api/sessions/corrupt like the malformed-file route).
test("REVIEW a 404 session read on a live wrapper (unreadable file / wrapper died) still dispatches", async (t) => {
  resetWorld();
  world.agents.set("corrupt", { running: true, state: { isStreaming: false, isPromptRunning: false } });
  const w = await mountSession("corrupt");
  let sendPromise;
  await act(async () => {
    sendPromise = w.latest.handleSend("keep talking");
    await sleep(30);
  });
  const es = lastEs();
  await act(async () => {
    es.open();
    await sendPromise;
  });
  assert.equal(
    callsTo("POST", "/api/agent/corrupt").some((c) => c.body?.type === "prompt" && c.body?.message === "keep talking"),
    true,
    "the prompt must be dispatched despite the boundary 404",
  );
  assert.equal(w.latest.notices.length, 0, "no failed-send notice");
  t.diagnostic("session-file 404 tolerated on a live wrapper");
});

// Port of upstream e0304060 (#187): reconcileAgentState applied
// state.contextUsage only on its idle branch, so a genuinely busy poll
// threw away valid usage and the ring filled in only from the terminal
// snapshot. Continuing an old conversation shows it: the transcript has no
// live usage until the new request runs, so the ring sat empty for the
// whole generation. (Locally the 2s live sampler is the primary ring
// source; within this test window it never fires, which is exactly the
// exposure this reconcile poll covers — it is the only sub-2s reader of
// /api/agent mid-run.)
test("ISSUE #187 the context ring fills mid-run while the agent is still streaming", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startRun("s1", "q1");
  await act(async () => {
    es.emit({ type: "agent_start" });
    es.emit({ type: "message_update", message: assistantMsg("a1", "streaming") });
    await Promise.resolve();
  });
  await settle(90);
  assert.ok(!w.latest.contextUsage, "a continued conversation starts with no live usage");

  // The server has real usage while the run is genuinely busy — it used to
  // be dropped, so the ring stayed blank until the run ended.
  world.holds.push({
    match: (method, url) => method === "GET" && url.includes("/api/agent/s1"),
    produce: () => ({
      status: 200,
      value: { running: true, state: { isStreaming: true, contextUsage: { percent: 42, contextWindow: 200000, tokens: 84000 } } },
    }),
  });
  await act(async () => {
    es.emit({ type: "todo_reminder" }); // triggers the mid-run reconcile poll
    await sleep(30);
  });
  await settle();
  assert.deepEqual(w.latest.contextUsage, { percent: 42, contextWindow: 200000, tokens: 84000 });
  assert.equal(w.latest.agentRunning, true, "applying usage must not finish a busy run");
});

// The merged goal bar is ONE surface: a live native goal and the web /goal
// marker share the themed row, so dropping the native goal must also clear
// the marker — otherwise the row falls back to the plain "Goal active" line
// and the goal appears undroppable.
test("dropping a native goal clears the web /goal marker for that session", async () => {
  resetWorld();
  const sid = "goal-drop";
  primeSession(sid, [userMsg("u1", "question")]);
  const marker = JSON.stringify({ objective: "Ship the fix", startedAt: Date.now() - 60_000 });
  sessionStorage.setItem(`omp-web:goal:${sid}`, marker);
  sessionStorage.setItem("omp-web:goal:other-session", JSON.stringify({ objective: "Another goal", startedAt: Date.now() }));

  const w = await mountSession(sid);
  assert.ok(w.latest.activeGoal, "the marker must hydrate the web goal on mount");

  await act(async () => {
    await w.latest.sendGoalCommand("drop");
  });
  const dropCall = callsTo("POST", "/api/agent/").find((c) => c.body?.type === "goal" && c.body?.op === "drop");
  assert.ok(dropCall, "the drop command must reach the wrapper");
  assert.equal(sessionStorage.getItem(`omp-web:goal:${sid}`), null, "the marker must be cleared with the native goal");
  assert.equal(w.latest.activeGoal, null, "the row must not linger on the dropped goal");
  assert.ok(sessionStorage.getItem("omp-web:goal:other-session"), "only the dropped session's marker may be cleared");
});
// Web /goal stays PASSIVE: sending it must never arm the native tracker —
// an implicit create armed omp's continuation loop silently, which burned
// ~10k tokens in seconds on a passive "wait for a trigger word" rule. The
// native create goes out only when the user presses the marker row's
// explicit "Track natively" control (trackGoal).
test("web /goal stays passive; only trackGoal arms the native tracker", async () => {
  resetWorld();
  const sid = "goal-passive";
  primeSession(sid, [userMsg("u1", "start")]);
  const w = await mountSession(sid);

  // Same handshake as startRun: the send waits for the stream to connect,
  // which only settles when the fake EventSource is opened.
  let builtinPromise;
  await act(async () => {
    builtinPromise = w.latest.handleBuiltinSlashCommand("/goal answer ok to ко");
    await sleep(30); // let the pre-connect get_state POST settle
  });
  await act(async () => {
    lastEs()?.open(); // connect settles → prompt POST fires
    const result = await builtinPromise;
    assert.equal(result.handled, true);
  });
  assert.equal(w.latest.activeGoal?.objective, "answer ok to ко", "the web marker must be set");
  const promptCall = callsTo("POST", "/api/agent/").find((c) => c.body?.type === "prompt");
  assert.ok(promptCall, "the /goal prompt must be sent");
  assert.ok(promptCall.body.message.includes("answer ok to ко"), "the objective must reach the prompt");
  assert.equal(
    callsTo("POST", "/api/agent/").some((c) => c.body?.type === "goal" && c.body?.op === "create"),
    false,
    "sending /goal must not arm the tracker — no implicit create (the mount read is fine)",
  );

  await act(async () => {
    await w.latest.trackGoal();
  });
  const createCall = callsTo("POST", "/api/agent/").find((c) => c.body?.type === "goal" && c.body?.op === "create");
  assert.ok(createCall, "the explicit track action must send goal create");
  assert.equal(createCall.body.objective, "answer ok to ко", "the tracked objective is the marker objective");
});

// The incident behind abort_and_restore_queue: a promoted steer was still in
// omp when Stop landed but missing from this client's snapshot, so nothing
// withdrew it and omp ran it as a new turn after the abort. omp's atomic Esc
// takes back everything it holds, listed here or not.
test("Stop takes queued input back through omp in one step, including a steer the snapshot missed", async () => {
  const { getDraft, clearDraft } = await jiti.import("@/lib/draft-store");
  resetWorld();
  clearDraft("abort-atomic");
  primeSession("abort-atomic", [userMsg("u0", "loaded question")]);
  const { w } = await startRun("abort-atomic", "hello agent");
  world.abortRestoreQueue = {
    steering: [{ text: "steer the snapshot missed" }, { text: "[Image]" }],
    followUp: [
      { text: "later follow-up", images: [{ type: "image", data: "x", mimeType: "image/png" }] },
      { text: "[Image]", images: [{ type: "image", data: "y", mimeType: "image/webp" }] },
    ],
  };

  await act(async () => { await w.latest.handleAbort(); });

  const commands = world.calls.map((c) => c.body?.type).filter(Boolean);
  assert.equal(commands.filter((type) => type === "abort_and_restore_queue").length, 1);
  assert.equal(commands.includes("abort"), false, "omp's own abort already stopped the run");
  assert.equal(commands.includes("remove_queued_message"), false);
  assert.equal(getDraft("abort-atomic")?.value, "steer the snapshot missed\n\n[Image]\n\nlater follow-up", "only an image-only message's label is dropped");
  assert.deepEqual(getDraft("abort-atomic")?.images, [{ data: "x", mimeType: "image/png" }, { data: "y", mimeType: "image/webp" }]);
  assert.deepEqual(w.latest.notices, []);
  clearDraft("abort-atomic");
});

const isAtomicStop = (method, _url, body) => method === "POST" && body?.type === "abort_and_restore_queue";

test("a failed atomic Stop is retried once and restores what omp still held", async () => {
  const { getDraft, clearDraft } = await jiti.import("@/lib/draft-store");
  resetWorld();
  clearDraft("abort-atomic-retry");
  primeSession("abort-atomic-retry", [userMsg("u0", "loaded question")]);
  const { w } = await startRun("abort-atomic-retry", "hello agent");
  world.holds.push({ match: isAtomicStop, produce: async () => ({ status: 502, value: { error: "Bad Gateway" } }) });
  world.abortRestoreQueue = { steering: [{ text: "retry me" }], followUp: [] };

  await act(async () => { await w.latest.handleAbort(); });

  const commands = world.calls.map((c) => c.body?.type).filter(Boolean);
  assert.equal(commands.filter((type) => type === "abort_and_restore_queue").length, 2);
  assert.equal(commands.includes("abort"), false, "a failure is not mistaken for an omp without the command");
  assert.equal(commands.includes("remove_queued_message"), false);
  assert.equal(getDraft("abort-atomic-retry")?.value, "retry me");
  assert.deepEqual(w.latest.notices, []);
  clearDraft("abort-atomic-retry");
});

test("an atomic Stop whose texts were lost with a failed response warns", async () => {
  resetWorld();
  primeSession("abort-atomic-lost", [userMsg("u0", "loaded question")]);
  const { w } = await startRun("abort-atomic-lost", "hello agent");
  // omp withdrew and aborted, but the answer never arrived; the queue is empty now.
  world.holds.push({ match: isAtomicStop, produce: async () => ({ status: 502, value: { error: "Bad Gateway" } }) });
  world.abortRestoreQueue = { steering: [], followUp: [] };

  await act(async () => { await w.latest.handleAbort(); });

  assert.equal(world.calls.some((c) => c.body?.type === "abort"), false);
  assert.deepEqual(w.latest.notices.map((n) => n.type), ["warning"]);
});

test("a failed atomic Stop never retries into a run started after the click", async () => {
  resetWorld();
  primeSession("abort-atomic-fenced", [userMsg("u0", "loaded question")]);
  const { w, es } = await startRun("abort-atomic-fenced", "hello agent");
  let release;
  world.holds.push({ match: isAtomicStop, produce: () => new Promise((resolve) => { release = resolve; }) });
  world.abortRestoreQueue = { steering: [], followUp: [] };
  let stop;
  await act(async () => { stop = w.latest.handleAbort(); });
  await act(async () => {
    es.emit({ type: "message_end", message: assistantMsg("a1", "answer") });
    es.emit({ type: "agent_end", isTerminal: true });
  });
  await settle();
  let sending;
  await act(async () => { sending = w.latest.handleSend("next prompt"); await sleep(30); });
  await act(async () => { lastEs().open(); await sending; });
  await act(async () => {
    release({ status: 502, value: { error: "Bad Gateway" } });
    await stop;
  });

  assert.equal(world.calls.some((c) => c.body?.type === "prompt" && c.body?.message === "next prompt"), true);
  assert.equal(world.calls.filter((c) => c.body?.type === "abort_and_restore_queue").length, 1, "no retry into the new run");
  assert.equal(world.calls.some((c) => c.body?.type === "abort"), false, "nor a fallback abort");
});

test("overlapping Stops share one atomic withdrawal; an image-only entry does not come back as text", async () => {
  const { getDraft, clearDraft } = await jiti.import("@/lib/draft-store");
  resetWorld();
  clearDraft("abort-atomic-twice");
  primeSession("abort-atomic-twice", [userMsg("u0", "loaded question")]);
  const { w } = await startRun("abort-atomic-twice", "hello agent");
  world.abortRestoreQueue = {
    steering: [{ text: "[Image]", images: [{ type: "image", data: "x", mimeType: "image/png" }] }],
    followUp: [{ text: "words" }],
  };

  await act(async () => { await Promise.all([w.latest.handleAbort(), w.latest.handleAbort()]); });

  assert.equal(world.calls.filter((c) => c.body?.type === "abort_and_restore_queue").length, 1);
  assert.equal(getDraft("abort-atomic-twice")?.value, "words");
  clearDraft("abort-atomic-twice");
});

// 453ea585: image-returning remove_queued_message (can1357/oh-my-pi#14179).
// Edit restores these images; only { data, mimeType } entries survive.
test("removeQueuedMessage resolves to the removed message's filtered images", async () => {
  resetWorld();
  primeSession("queued-edit", [userMsg("u0", "loaded question")]);
  const { w } = await startRun("queued-edit", "hello agent");
  await act(async () => {
    lastEs().emit({ type: "queue_update", steering: [], followUp: ["target"] });
  });
  world.holds.push({
    match: (method, _url, body) => method === "POST" && body?.type === "remove_queued_message",
    produce: async () => ({
      status: 200,
      value: { success: true, data: { removed: true, images: [{ type: "image", data: "AAAA", mimeType: "image/png" }, { bogus: true }] } },
    }),
  });
  let cancellation;
  await act(async () => { cancellation = w.latest.removeQueuedMessage("target", "followUp"); });
  await act(async () => {
    assert.deepEqual(await cancellation, [{ data: "AAAA", mimeType: "image/png" }], "malformed entries are dropped");
  });
});

// ---------------------------------------------------------------------------
// Slow toggle + provider usage-limit badge (port of upstream 892399be).
// ---------------------------------------------------------------------------

const SLOW_MODEL = { provider: "anthropic", id: "claude-test" };
const SLOW_STATE = { stage: "low_priority", resetsAtSec: 1770000000, allowanceLeftPercent: 62 };

test("opening a session past its Claude usage limit shows the badge, and an idle /slow off clears it", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  world.agents.set("s1", { running: false, state: { model: SLOW_MODEL, usageLimit: SLOW_STATE } });
  const { w, es } = await startRun("s1", "q1");
  assert.deepEqual(w.latest.usageLimit, SLOW_STATE, "opening past the limit shows the badge");

  // End the run with the limit still breached: the badge survives the run.
  await act(async () => { es.emit({ type: "agent_end", isTerminal: true }); });
  await settle(300);
  assert.deepEqual(w.latest.usageLimit, SLOW_STATE, "an ending run without /slow off keeps the badge");

  // Idle slash refresh (prompt_result with agentInvoked:false): /slow off
  // changes session state without a run, and the re-read must clear the badge.
  world.agents.set("s1", { running: false, state: { model: SLOW_MODEL } });
  await act(async () => { es.emit({ type: "prompt_result", agentInvoked: false }); });
  await settle();
  assert.equal(w.latest.usageLimit, undefined, "the idle slash refresh clears the badge");
});

/** Mount + hydrate, start the run, and stream one assistant delta. */
async function startStreamingRun(sid) {
  const { w, es } = await startRun(sid, "q1");
  await act(async () => {
    es.emit({ type: "agent_start" });
    es.emit({ type: "message_update", message: assistantMsg("a1", "streaming") });
    await Promise.resolve();
  });
  await settle(90);
  assert.equal(w.latest.agentRunning, true);
  return { w, es };
}

test("the usage-limit badge appears mid-run and clears when the run ends without it", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startStreamingRun("s1");
  world.agents.set("s1", { running: true, state: { isStreaming: true, model: SLOW_MODEL, usageLimit: SLOW_STATE } });
  // The in-run sample ticks every 2s; wait for it rather than a fixed sleep.
  // (Identity wait becomes a deep compare: the stub round-trips JSON.)
  for (let waited = 0; JSON.stringify(w.latest.usageLimit) !== JSON.stringify(SLOW_STATE) && waited < 5000; waited += 250) await settle(250);
  assert.deepEqual(w.latest.usageLimit, SLOW_STATE);

  primeSession("s1", [userMsg("u0", "q"), assistantMsg("a1", "done")]);
  world.agents.set("s1", { running: false, state: { model: SLOW_MODEL } });
  await act(async () => { es.emit({ type: "agent_end", isTerminal: true }); });
  await settle();
  assert.equal(w.latest.usageLimit, undefined);
});

test("the Slow toggle follows omp's per-model state and is cleared by a switch to an unsupported model", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  world.agents.set("s1", { running: true, state: { isStreaming: true, model: SLOW_MODEL, slowModeSupported: true, slowModeEnabled: true } });
  const w = await mountSession("s1");
  assert.equal(w.latest.slowModeSupported, true);
  assert.equal(w.latest.slowModeEnabled, true);

  // A model without /slow reports supported:false and omits enabled; the
  // persisted Claude setting may still be on, but it must not show as pressed.
  world.agents.set("s1", { running: true, state: { model: { provider: "openrouter", id: "other" }, slowModeSupported: false } });
  await act(async () => { lastEs().emit({ type: "model_changed" }); });
  await settle();
  assert.equal(w.latest.slowModeSupported, false);
  assert.equal(w.latest.slowModeEnabled, false);
});

/** Mounts s1 with Slow at `enabled`, answers the next set_slow_mode with `answer`, and parks the follow-up state refresh so only the command's answer can move the toggle. */
async function mountSlowToggle(enabled, answer) {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  world.agents.set("s1", { running: true, state: { model: SLOW_MODEL, slowModeSupported: true, slowModeEnabled: enabled, slowModeScope: "global" } });
  const w = await mountSession("s1");
  assert.equal(w.latest.slowModeEnabled, enabled);
  world.holds.push({
    match: (method, _url, body) => method === "POST" && body?.type === "set_slow_mode",
    produce: async () => answer,
  });
  world.holds.push({
    match: (method, url) => method === "GET" && url === "/api/sessions/s1/state",
    produce: () => new Promise(() => {}),
  });
  return w;
}

for (const enabled of [false, true]) {
  test(`turning Slow ${enabled ? "on" : "off"} sends set_slow_mode and applies omp's answer`, async () => {
    const w = await mountSlowToggle(!enabled, { value: { success: true, data: { enabled } } });
    const posted = world.calls.length;
    await act(async () => { await w.latest.handleSlowModeChange(enabled); });
    const command = world.calls.slice(posted).find((call) => call.body?.type === "set_slow_mode");
    assert.deepEqual(command?.body, { type: "set_slow_mode", enabled });
    assert.equal(w.latest.slowModeEnabled, enabled);
    assert.deepEqual(w.latest.notices, []);
  });
}

test("a refused set_slow_mode leaves the toggle as it was and shows omp's error", async () => {
  const refusal = "Slow mode is unavailable for the current model.";
  const w = await mountSlowToggle(false, { status: 400, value: { error: refusal } });
  await act(async () => { await w.latest.handleSlowModeChange(true); });
  assert.equal(w.latest.slowModeEnabled, false);
  assert.deepEqual(w.latest.notices.map((n) => [n.type, n.message]), [["error", refusal]]);
});

test("the Slow scope follows omp's state and clears with support", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  world.agents.set("s1", { running: true, state: { isStreaming: true, model: SLOW_MODEL, slowModeSupported: true, slowModeEnabled: false, slowModeScope: "global" } });
  const w = await mountSession("s1");
  assert.equal(w.latest.slowModeScope, "global");

  world.agents.set("s1", { running: true, state: { model: { provider: "openai", id: "gpt-test" }, slowModeSupported: true, slowModeEnabled: false, slowModeScope: "session" } });
  await act(async () => { lastEs().emit({ type: "model_changed" }); });
  await settle();
  assert.equal(w.latest.slowModeScope, "session");

  world.agents.set("s1", { running: true, state: { model: { provider: "openrouter", id: "other" }, slowModeSupported: false } });
  await act(async () => { lastEs().emit({ type: "model_changed" }); });
  await settle();
  assert.equal(w.latest.slowModeScope, undefined);
});

// ---------------------------------------------------------------------------
// Skill startup diagnostics (port of upstream 631be73e).
// Adaptations: the local harness attaches an EventSource during mount only
// for a running/streaming session (the Slow-toggle pattern), so states that
// later receive emitted frames carry isStreaming:true; the fresh-chat tests
// register their created id in world.agents because this router is faithful
// to the real route and 404s POSTs for unknown ids.
// ---------------------------------------------------------------------------

const btwRecord = (overrides = {}) => ({
  id: "b1", leafId: null, question: "what is 2+2", answer: "", status: "running", createdAt: 1, updatedAt: 1, ...overrides,
});

function holdBtwCommand(type, produce) {
  world.holds.push({ match: (method, _url, body) => method === "POST" && body?.type === type, produce });
}

function skillDiagnosticsSnapshot(showStartupDiagnostics, name = "review") {
  return {
    cwd: "/workspace",
    showStartupDiagnostics,
    diagnostics: [{
      name,
      reason: "source-order",
      skills: [
        { name, filePath: `/workspace/.agents/skills/${name}/SKILL.md`, source: "project" },
        { name, filePath: `/home/me/.agents/skills/${name}/SKILL.md`, source: "user", pluginName: "shared" },
      ],
      duplicates: [{
        skill: { name, filePath: `/mirror/.agents/skills/${name}/SKILL.md`, source: "custom" },
        retained: { name, filePath: `/workspace/.agents/skills/${name}/SKILL.md`, source: "project" },
      }],
    }],
  };
}

test("skill diagnostics hydrate from state and follow defensive live updates", async () => {
  resetWorld();
  primeSession("skill-state", [userMsg("u0", "q")]);
  const initial = skillDiagnosticsSnapshot(true);
  world.agents.set("skill-state", {
    running: true,
    state: {
      isStreaming: true,
      skillDiagnostics: {
        ...initial,
        diagnostics: [{
          ...initial.diagnostics[0],
          skills: initial.diagnostics[0].skills.map((skill) => ({ ...skill, body: "private" })),
          privateDiagnostic: true,
        }],
        privateSnapshot: true,
      },
    },
  });

  const w = await mountSession("skill-state");
  assert.deepEqual(w.latest.skillDiagnostics, initial, "get_state hydration recovers a startup frame emitted before SSE attached");

  const updated = skillDiagnosticsSnapshot(false, "deploy");
  await act(() => lastEs().emit({
    type: "skill_diagnostics_update",
    data: { ...updated, containRoot: "/private" },
  }));
  assert.deepEqual(w.latest.skillDiagnostics, updated);

  await act(() => lastEs().emit({
    type: "skill_diagnostics_update",
    data: { cwd: "/workspace", showStartupDiagnostics: true, diagnostics: "none" },
  }));
  assert.equal(w.latest.skillDiagnostics, null, "malformed data is unsupported, not a fabricated clean result");

  const recovered = skillDiagnosticsSnapshot(true, "recovered");
  world.agents.set("skill-state", { running: true, state: { isStreaming: true, skillDiagnostics: recovered } });
  await act(async () => {
    lastEs().open();
    await sleep(30);
  });
  assert.deepEqual(w.latest.skillDiagnostics, recovered, "stream attachment reconciles an update emitted before SSE attached");
});

/** Start the startup-diagnostics setter with its POST held. `respond` answers the held POST; `saving` is the hook's promise. */
async function startHeldSkillSetter(w, sid, enabled) {
  let respond;
  world.holds.push({
    match: (method, url, body) => method === "POST" && url.includes(`/api/agent/${sid}`) && body?.type === "set_skill_startup_diagnostics",
    produce: () => new Promise((resolve) => { respond = (data) => resolve({ value: { success: true, data } }); }),
  });
  let saving;
  await act(async () => {
    saving = w.latest.setSkillStartupDiagnostics(enabled);
    await sleep(20);
  });
  // The test awaits `saving` itself; this only keeps a failed assertion from leaving an unhandled rejection behind.
  saving.catch(() => {});
  return { saving, respond: (data) => respond(data) };
}

test("the startup diagnostics setter publishes OMP's effective snapshot and rejects unsupported replies", async () => {
  resetWorld();
  primeSession("skill-actions", [userMsg("u0", "q")]);
  const on = skillDiagnosticsSnapshot(true);
  const off = skillDiagnosticsSnapshot(false);
  world.agents.set("skill-actions", { running: false, state: { skillDiagnostics: on } });
  const w = await mountSession("skill-actions");
  assert.deepEqual(w.latest.skillDiagnostics, on);

  world.holds.push({
    match: (method, url, body) => method === "POST" && url.includes("/api/agent/skill-actions") && body?.type === "set_skill_startup_diagnostics",
    produce: async () => ({ value: { success: true, data: off } }),
  });
  let disabled;
  await act(async () => {
    disabled = await w.latest.setSkillStartupDiagnostics(false);
  });
  assert.deepEqual(disabled, off);
  assert.deepEqual(w.latest.skillDiagnostics, off, "the effective snapshot replaces the previous one");

  world.holds.push({
    match: (method, url, body) => method === "POST" && url.includes("/api/agent/skill-actions") && body?.type === "set_skill_startup_diagnostics",
    produce: async () => ({ value: { success: true, data: off } }),
  });
  let overridden;
  await act(async () => {
    overridden = await w.latest.setSkillStartupDiagnostics(true);
  });
  assert.deepEqual(overridden, off, "an override that keeps the setting off is returned as the effective value, not the requested one");
  assert.deepEqual(w.latest.skillDiagnostics, off);

  world.holds.push({
    match: (method, url, body) => method === "POST" && url.includes("/api/agent/skill-actions") && body?.type === "set_skill_startup_diagnostics",
    produce: async () => ({ value: { success: true, data: { cwd: "/workspace", showStartupDiagnostics: false, diagnostics: null } } }),
  });
  await assert.rejects(() => w.latest.setSkillStartupDiagnostics(false), /skill diagnostics/i);
  assert.deepEqual(w.latest.skillDiagnostics, off, "a malformed response cannot erase the last supported snapshot");
  await assert.rejects(() => w.latest.setSkillStartupDiagnostics("false"), /boolean/i);
});

test("the startup diagnostics setter does not start an empty chat and rejects stale session responses", async () => {
  resetWorld();
  const empty = await mountSession(null);
  const callsBefore = world.calls.length;
  await assert.rejects(() => empty.latest.setSkillStartupDiagnostics(false), /active session/i);
  assert.equal(world.calls.length, callsBefore, "no active session means no lazy child-start request");

  primeSession("old-skills", [userMsg("u0", "old")]);
  const old = await mountSession("old-skills");
  const held = await startHeldSkillSetter(old, "old-skills", false);
  old.unmount();

  primeSession("current-skills", [userMsg("u0", "current")]);
  const current = await mountSession("current-skills");
  held.respond(skillDiagnosticsSnapshot(false, "stale"));
  await assert.rejects(held.saving, /stale/i);
  assert.equal(current.latest.skillDiagnostics, null, "the previous chat cannot update the selected chat");
});

test("a saved setting whose own update frame beats the HTTP response resolves to the saved snapshot", async () => {
  resetWorld();
  primeSession("skill-own-frame", [userMsg("u0", "q")]);
  const enabled = skillDiagnosticsSnapshot(true, "own-frame");
  world.agents.set("skill-own-frame", { running: true, state: { isStreaming: true, skillDiagnostics: enabled } });
  const w = await mountSession("skill-own-frame");
  assert.deepEqual(w.latest.skillDiagnostics, enabled);

  const { saving, respond } = await startHeldSkillSetter(w, "skill-own-frame", false);
  const saved = skillDiagnosticsSnapshot(false, "own-frame");
  try {
    // OMP emits the update frame before it answers the command.
    await act(() => lastEs().emit({ type: "skill_diagnostics_update", data: saved }));
    assert.deepEqual(w.latest.skillDiagnostics, saved);
  } finally {
    respond(saved);
  }
  let result;
  await act(async () => {
    result = await saving;
  });
  assert.deepEqual(result, saved, "the control reports the saved setting instead of a stale failure");
  assert.deepEqual(w.latest.skillDiagnostics, saved);
});

test("a setter response overtaken by a newer update returns the current snapshot without rolling it back", async () => {
  resetWorld();
  primeSession("skill-newer-frame", [userMsg("u0", "q")]);
  world.agents.set("skill-newer-frame", { running: true, state: { isStreaming: true, skillDiagnostics: skillDiagnosticsSnapshot(true, "before") } });
  const w = await mountSession("skill-newer-frame");

  const { saving, respond } = await startHeldSkillSetter(w, "skill-newer-frame", false);
  const newer = skillDiagnosticsSnapshot(false, "after-reload");
  try {
    await act(() => lastEs().emit({ type: "skill_diagnostics_update", data: newer }));
  } finally {
    respond(skillDiagnosticsSnapshot(false, "answered-before-reload"));
  }
  let result;
  await act(async () => {
    result = await saving;
  });
  assert.deepEqual(result, newer);
  assert.deepEqual(w.latest.skillDiagnostics, newer, "the older response never replaces a newer update");
});

test("a state snapshot requested before a newer skill update cannot overwrite it when it resolves late", async () => {
  resetWorld();
  primeSession("skill-order", [userMsg("u0", "q")]);
  world.agents.set("skill-order", { running: true, state: { isStreaming: true, skillDiagnostics: skillDiagnosticsSnapshot(true, "startup") } });
  const w = await mountSession("skill-order");

  let release;
  world.holds.push({
    match: (method, url) => method === "GET" && url === "/api/agent/skill-order",
    produce: () => new Promise((resolve) => {
      release = () => resolve({ value: { running: true, state: { skillDiagnostics: skillDiagnosticsSnapshot(true, "stale-state") } } });
    }),
  });
  const newer = skillDiagnosticsSnapshot(false, "newer-update");
  try {
    await act(async () => {
      lastEs().open(); // stream attachment requests an authoritative state snapshot
      await sleep(20);
    });
    assert.ok(release, "precondition: the snapshot request is still in flight");
    await act(() => lastEs().emit({ type: "skill_diagnostics_update", data: newer }));
    assert.deepEqual(w.latest.skillDiagnostics, newer);
  } finally {
    release?.();
  }
  await act(async () => {
    await sleep(30);
  });
  assert.deepEqual(w.latest.skillDiagnostics, newer, "the late older snapshot is dropped");
});

test("a fresh chat hydrates and follows skill diagnostics after slash discovery creates its runtime", async () => {
  resetWorld();
  const startup = skillDiagnosticsSnapshot(true, "fresh-startup");
  world.holds.push({
    match: (method, url) => method === "POST" && url === "/api/agent/new",
    produce: async () => ({ value: { sessionId: "fresh-skills" } }),
  });
  world.agents.set("fresh-skills", { running: true, state: { skillDiagnostics: startup } });
  const w = await mountSession(null, undefined, { newSessionCwd: "/workspace" });
  assert.equal(w.latest.skillDiagnostics, null, "an empty new-chat page has no runtime or diagnostics");
  assert.deepEqual(world.esInstances, [], "mounting an empty new chat must not attach a stream");

  await act(async () => { await w.latest.loadSlashCommands(); });
  const es = lastEs();
  assert.match(es?.url ?? "", /\/api\/agent\/fresh-skills\/events$/, "the created runtime must be observed before its first prompt");
  await act(async () => {
    es.open();
    await sleep(30);
  });
  assert.deepEqual(w.latest.skillDiagnostics, startup, "the startup frame emitted before attachment is recovered from state");

  const updated = skillDiagnosticsSnapshot(false, "fresh-updated");
  await act(() => es.emit({ type: "skill_diagnostics_update", data: updated }));
  assert.deepEqual(w.latest.skillDiagnostics, updated, "live diagnostics follow the created runtime");
  assert.equal(callsTo("POST", "/api/agent/fresh-skills").some((call) => call.body?.type === "prompt"), false, "discovery never starts a model run");
  w.unmount();
});

test("a fresh chat runtime created after unmount cannot attach or apply skill diagnostics", async () => {
  resetWorld();
  let release;
  world.holds.push({
    match: (method, url) => method === "POST" && url === "/api/agent/new",
    produce: () => new Promise((resolve) => { release = () => resolve({ value: { sessionId: "stale-fresh" } }); }),
  });
  world.agents.set("stale-fresh", { running: true, state: { skillDiagnostics: skillDiagnosticsSnapshot(true, "stale-fresh") } });
  const w = await mountSession(null, undefined, { newSessionCwd: "/workspace" });
  let discovery;
  await act(async () => {
    discovery = w.latest.loadSlashCommands();
    await sleep(20);
    w.unmount();
  });
  await act(async () => {
    release();
    await discovery;
    await sleep(30);
  });
  assert.deepEqual(world.esInstances, [], "a stale create must not leak an event stream");
  assert.equal(callsTo("GET", "/api/agent/stale-fresh").length, 0, "a stale create must not request diagnostics for a switched chat");
  assert.equal(w.latest.skillDiagnostics, null);
});

test("a fresh chat's first prompt attaches one event stream instead of an observer plus its own", async () => {
  resetWorld();
  world.holds.push({
    match: (method, url) => method === "POST" && url === "/api/agent/new",
    produce: async () => ({ value: { sessionId: "fresh-send" } }),
  });
  world.agents.set("fresh-send", { running: true, state: {} });
  const w = await mountSession(null, undefined, { newSessionCwd: "/workspace", onSessionCreated: () => {} });
  let sent;
  await act(async () => {
    sent = w.latest.handleSend("first prompt");
    await sleep(30); // create the runtime and attach the prompt's stream
  });
  const streamsBeforeOpen = world.esInstances.length;
  let delivered;
  // Settle the send before asserting, so a failed assertion leaves no run behind.
  await act(async () => {
    lastEs().open();
    delivered = await sent;
  });
  w.unmount();
  assert.equal(delivered, true);
  assert.equal(streamsBeforeOpen, 1, "the prompt owns the only stream");
  assert.equal(world.esInstances.length, 1);
  assert.equal(callsTo("POST", "/api/agent/fresh-send").some((call) => call.body?.type === "prompt"), true);
});

test("a fresh chat's /btw question attaches one event stream instead of an observer plus its own", async () => {
  resetWorld();
  world.holds.push({
    match: (method, url) => method === "POST" && url === "/api/agent/new",
    produce: async () => ({ value: { sessionId: "fresh-btw" } }),
  });
  world.agents.set("fresh-btw", { running: true, state: {} });
  holdBtwCommand("btw", async () => ({ value: { success: true, data: { record: btwRecord() } } }));
  const w = await mountSession(null, undefined, { newSessionCwd: "/workspace", onSessionCreated: () => {} });
  let asked;
  await act(async () => {
    asked = w.latest.handleBuiltinSlashCommand("/btw what is 2+2");
    await sleep(30); // create the runtime and attach the question's stream
  });
  const streamsBeforeOpen = world.esInstances.length;
  let result;
  // Settle the question before asserting, so a failed assertion leaves no request behind.
  await act(async () => {
    lastEs().open();
    result = await asked;
  });
  w.unmount();
  assert.deepEqual(result, { handled: true });
  assert.equal(streamsBeforeOpen, 1, "the question owns the only stream");
  assert.equal(world.esInstances.length, 1);
});
