import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SettingsConfig } from "./SettingsConfig";

const noop = () => {};

/**
 * Render the real System panel and record its HTTP boundary. Per-host
 * software updates live in Settings → Hosts (upstream #370); System keeps
 * only web-server settings, so it must never check or update the runtime.
 * The settings dialog portals itself to document.body (base-ui Portal), so
 * the search root is the body itself and the test removes the portal nodes
 * the dialog left behind.
 */
async function renderSystemTab(t) {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { requests.push(String(url)); return Response.json({}); };
  const existing = new Set(document.body.children);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(() => {
    act(() => root.unmount());
    container.remove();
    for (const node of [...document.body.children]) if (!existing.has(node)) node.remove();
    globalThis.fetch = originalFetch;
  });
  await act(async () => {
    root.render(createElement(SettingsConfig, {
      activeTab: "system",
      toolCallsDefaultCollapsed: false, onToolCallsDefaultCollapsedChange: noop,
      cwd: null, remoteHost: false, sessionId: null,
      onModelsSaved: noop, onPluginsReloaded: noop,
      onSelectTab: noop, onClose: noop,
    }));
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  return { container: document.body, requests };
}

const buttonLabels = (root) => [...root.querySelectorAll("button")].map((button) => button.textContent.trim());

test("System keeps web-server settings but never checks or updates the host runtime", async (t) => {
  const { container, requests } = await renderSystemTab(t);
  assert.ok(!buttonLabels(container).includes("Update now"), buttonLabels(container).join(" | "));
  assert.ok(!buttonLabels(container).includes("Restart OMP sessions"), buttonLabels(container).join(" | "));
  assert.ok(!container.textContent.includes("OMP runtime"), "the removed OMP runtime card is back");
  assert.ok(container.textContent.includes("Resume running sessions after a restart"), "the web-server settings vanished");
  assert.ok(!requests.some((url) => url.startsWith("/api/omp-update")), requests.join(", "));
});
