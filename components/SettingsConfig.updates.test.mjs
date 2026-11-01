import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SettingsConfig } from "./SettingsConfig";

const noop = () => {};
const NO_OMP_UPDATE = { currentVersion: "1.0.0", availableVersion: null, updateAvailable: false, updateCommand: "omp update" };

/**
 * Settings → System, with `ompCheck` as the answer to the omp update check.
 * The settings dialog portals itself to document.body (base-ui Portal), so
 * the search root is the body itself and the test removes the portal nodes
 * the dialog left behind.
 */
async function renderSystemTab(t, { ompCheck = NO_OMP_UPDATE }) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => Response.json(String(url) === "/api/omp-update" ? ompCheck : {});
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
      hideToolActivity: false, onHideToolActivityChange: noop,
      expandThinkingByDefault: false, onExpandThinkingByDefaultChange: noop, onHideThinkingBlockChange: noop,
      providerUsageVisible: false, onProviderUsageVisibleChange: noop,
      scopeNativeSelectAll: false, onScopeNativeSelectAllChange: noop,
      openUrlAutomatically: false, onOpenUrlAutomaticallyChange: noop,
      cwd: null, remoteHost: false, sessionId: null,
      onModelsSaved: noop, onPluginsReloaded: noop,
      onOmpUpdateAvailabilityChange: noop,
      onSelectTab: noop, onClose: noop,
    }));
  });
  // The omp update check answers after the first render.
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  return document.body;
}

const buttonLabels = (root) => [...root.querySelectorAll("button")].map((button) => button.textContent.trim());
const codes = (root) => [...root.querySelectorAll("code")].map((code) => code.textContent);

// The fork has no self-update: updating omp-web itself is manual (npm
// command), but `omp update` runs ON this server — the route streams it — so
// the card shows both the copyable command and the in-app Update-now button
// exactly when an update is available.
test("the omp card shows the update command and the in-app Update now when one is available", async (t) => {
  const update = { currentVersion: "1.0.0", availableVersion: "1.1.0", updateAvailable: true, updateCommand: "omp update" };
  const binary = await renderSystemTab(t, { ompCheck: update });
  assert.ok(codes(binary).includes("omp update"), "the omp update command is gone");
  assert.ok(buttonLabels(binary).includes("Update now"), buttonLabels(binary).join(" | "));
});

test("an up-to-date omp shows no command block and no Update now", async (t) => {
  const current = await renderSystemTab(t, { ompCheck: NO_OMP_UPDATE });
  assert.ok(!buttonLabels(current).includes("Update now"), buttonLabels(current).join(" | "));
  assert.ok(!codes(current).includes("omp update"), "the command block shows without an update");
});
