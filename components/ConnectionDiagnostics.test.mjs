import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { act, createElement } from "react";
import { mock } from "bun:test";
const { cleanup, fireEvent, render, screen } = await import("@testing-library/react/pure.js");
globalThis.CSS ??= { escape: (value) => value }; // TabBar's active-tab scroll uses CSS.escape; jsdom has none (as in TabBar.test.mjs)

// Real exports first, then the one function the panel polls: the contract function is stubbed per test.
const realEventStream = await import("@/lib/event-stream");
let diagnostics = null;
let requestDiagnostics = async () => diagnostics;
mock.module("@/lib/event-stream", () => ({
  ...realEventStream,
  requestConnectionDiagnostics: () => requestDiagnostics(),
}));

const { RightWorkbench } = await import("./panels/RightWorkbench");
const { ConnectionDiagnosticsPanel } = await import("./ConnectionDiagnostics");
const { setConnectionDiagnosticsEnabled, useConnectionDiagnosticsEnabled } = await import("@/lib/connection-diagnostics-prefs");

afterEach(() => {
  cleanup();
  localStorage.clear();
  diagnostics = null;
  requestDiagnostics = async () => diagnostics;
  delete document.visibilityState;
});

const wsDiagnostics = {
  setting: "ws",
  mode: "ws",
  fallback: null,
  status: "connected",
  since: null,
  lastReconnect: null,
  reconnects: 0,
  resumes: 0,
  resyncs: 0,
  clockRttMs: 12,
  effectiveType: "4g",
  windowMs: 1800000,
  stats: [{ transport: "ws", metric: "transportMs", count: 10, mean: 20.4, p50: 18, p95: 30, p999: null, max: 41 }],
};

/** Mirrors AppShell: the setting gates the view; opening it through the workbench's
 *  empty-state card / + menu makes it the pane's active tab. */
function Harness() {
  const on = useConnectionDiagnosticsEnabled();
  return createElement(RightWorkbench, {
    storageKey: "diagnostics-test",
    cwd: null,
    remoteHost: false,
    files: createElement("div", null, "files-view"),
    agents: createElement("div", null, "agents-view"),
    worktrees: null,
    connectionEnabled: on,
    connection: (active) => createElement(ConnectionDiagnosticsPanel, { active }),
  });
}

/** The value cell paired with a state row's label. */
function valueOf(label) {
  return screen.getByText(label).nextElementSibling;
}

/** Opens the view from the empty-state card, or re-activates its tab once open. */
function selectConnection() {
  const tab = screen.queryByRole("tab", { name: "Connection" });
  fireEvent.click(tab ?? screen.getByRole("button", { name: /^Connection/ }));
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function setVisible(visible) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: visible ? "visible" : "hidden" });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
}

async function flushResponse(response, value) {
  await act(async () => response.resolve(value));
}

test("with the setting off, the workbench offers no Connection surface", () => {
  render(createElement(Harness));
  assert.ok(screen.getByRole("button", { name: /^Worktrees/ }));
  assert.equal(screen.queryByRole("button", { name: /^Connection/ }), null);
});

test("with the setting on, the Connection tab shows the WebSocket state and a dash for an empty p99.9", async () => {
  setConnectionDiagnosticsEnabled(true);
  diagnostics = wsDiagnostics;
  render(createElement(Harness));
  assert.ok(screen.getByRole("button", { name: /^Connection/ }));
  selectConnection();

  await screen.findByText("Transport in use");
  assert.equal(valueOf("Transport in use").textContent, "WebSocket");
  assert.equal(valueOf("Status").textContent, "connected");

  const row = screen.getByText("Browser ↔ app round trip").closest("tr");
  const cells = [...row.querySelectorAll("td")].map((cell) => cell.textContent);
  // n, mean, p50, p95, p99.9, max
  assert.deepEqual(cells, ["10", "20", "18", "30", "—", "41"]);
});

test("the panel says so when the connection worker gives no diagnostics", async () => {
  setConnectionDiagnosticsEnabled(true);
  diagnostics = null;
  render(createElement(Harness));
  selectConnection();
  assert.ok(await screen.findByText("No diagnostics from the connection worker yet."));
});

test("turning the setting on while the panel is mounted adds the Connection surface", async () => {
  render(createElement(Harness));
  assert.equal(screen.queryByRole("button", { name: /^Connection/ }), null);
  act(() => setConnectionDiagnosticsEnabled(true));
  assert.ok(await screen.findByRole("button", { name: /^Connection/ }));
});

test("opening the Connection view shows its panel and the idle status", async () => {
  setConnectionDiagnosticsEnabled(true);
  diagnostics = { ...wsDiagnostics, status: "idle" };
  render(createElement(Harness));
  assert.equal(screen.queryByRole("tabpanel", { name: "Connection" }), null);
  selectConnection();
  assert.ok(screen.getByRole("tabpanel", { name: "Connection" }));
  await screen.findByText("Transport in use");
  assert.equal(valueOf("Status").textContent, "Idle");
  assert.ok(screen.getByText("Reconnects in last 30 min"));
});

test("an active visible panel replaces its displayed snapshot on the next poll", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  diagnostics = wsDiagnostics;
  await act(async () => render(createElement(ConnectionDiagnosticsPanel, { active: true })));
  assert.equal(valueOf("Clock RTT").textContent, "12 ms");

  diagnostics = { ...wsDiagnostics, clockRttMs: 3 };
  await act(async () => t.mock.timers.tick(1000));
  assert.equal(valueOf("Clock RTT").textContent, "3 ms");
});

test("inactive diagnostics retain the old snapshot, ignore a late response, and refresh on activation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  diagnostics = wsDiagnostics;
  const panel = render(createElement(ConnectionDiagnosticsPanel, { active: false }));
  await act(async () => t.mock.timers.tick(5000));
  assert.ok(screen.getByText("No diagnostics from the connection worker yet."));

  await act(async () => panel.rerender(createElement(ConnectionDiagnosticsPanel, { active: true })));
  assert.equal(valueOf("Clock RTT").textContent, "12 ms");
  const late = deferred();
  requestDiagnostics = () => late.promise;
  act(() => t.mock.timers.tick(1000));
  panel.rerender(createElement(ConnectionDiagnosticsPanel, { active: false }));
  diagnostics = { ...wsDiagnostics, clockRttMs: 7 };
  requestDiagnostics = async () => diagnostics;
  await flushResponse(late, diagnostics);
  await act(async () => t.mock.timers.tick(5000));
  assert.equal(valueOf("Clock RTT").textContent, "12 ms");

  await act(async () => panel.rerender(createElement(ConnectionDiagnosticsPanel, { active: true })));
  assert.equal(valueOf("Clock RTT").textContent, "7 ms");
});

test("hidden diagnostics retain the old snapshot, ignore a late response, and refresh when visible", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  setVisible(false);
  diagnostics = wsDiagnostics;
  render(createElement(ConnectionDiagnosticsPanel, { active: true }));
  await act(async () => t.mock.timers.tick(5000));
  assert.ok(screen.getByText("No diagnostics from the connection worker yet."));

  await act(async () => setVisible(true));
  assert.equal(valueOf("Clock RTT").textContent, "12 ms");
  const late = deferred();
  requestDiagnostics = () => late.promise;
  act(() => t.mock.timers.tick(1000));
  setVisible(false);
  diagnostics = { ...wsDiagnostics, clockRttMs: 9 };
  requestDiagnostics = async () => diagnostics;
  await flushResponse(late, diagnostics);
  await act(async () => t.mock.timers.tick(5000));
  assert.equal(valueOf("Clock RTT").textContent, "12 ms");

  await act(async () => setVisible(true));
  assert.equal(valueOf("Clock RTT").textContent, "9 ms");
});

test("a response from an unmounted panel cannot replace the new panel's snapshot", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  diagnostics = wsDiagnostics;
  let panel;
  await act(async () => { panel = render(createElement(ConnectionDiagnosticsPanel, { active: true })); });
  assert.equal(valueOf("Clock RTT").textContent, "12 ms");
  const late = deferred();
  requestDiagnostics = () => late.promise;
  act(() => t.mock.timers.tick(1000));
  panel.unmount();

  diagnostics = { ...wsDiagnostics, clockRttMs: 11 };
  requestDiagnostics = async () => diagnostics;
  await act(async () => render(createElement(ConnectionDiagnosticsPanel, { active: true })));
  assert.equal(valueOf("Clock RTT").textContent, "11 ms");
  await flushResponse(late, { ...wsDiagnostics, clockRttMs: 99 });
  assert.equal(valueOf("Clock RTT").textContent, "11 ms");
});

test("turning the setting on in another tab adds the Connection surface here", async () => {
  render(createElement(Harness));
  assert.equal(screen.queryByRole("button", { name: /^Connection/ }), null);
  act(() => {
    localStorage.setItem("omp-web:connection-diagnostics", "on");
    window.dispatchEvent(Object.assign(new Event("storage"), { key: "omp-web:connection-diagnostics" }));
  });
  assert.ok(await screen.findByRole("button", { name: /^Connection/ }));
});

test("with storage refusing writes, the choice still holds for this page load", async () => {
  // On the prototype: assigning localStorage.setItem would just store an item named "setItem".
  const proto = Object.getPrototypeOf(localStorage);
  const setItem = proto.setItem;
  proto.setItem = () => { throw new Error("quota exceeded"); };
  try {
    render(createElement(Harness));
    act(() => setConnectionDiagnosticsEnabled(true));
    assert.ok(await screen.findByRole("button", { name: /^Connection/ }));
  } finally {
    proto.setItem = setItem;
    setConnectionDiagnosticsEnabled(false);
  }
});
