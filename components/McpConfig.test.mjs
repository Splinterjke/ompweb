import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createJiti } from "jiti";

// React only ships `act` in its development build; force NODE_ENV before any
// React module is loaded so these tests work regardless of the environment's
// default (production builds throw "act(...) is not supported").
process.env.NODE_ENV = "test";
const React = (await import("react")).default;
const { act, cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react/pure.js");

// Port of upstream 8a7f22b2's McpConfig.test.mjs. Adaptations: this fork has
// no @testing-library/user-event (clicks go through fireEvent + act), and the
// mocked GET payload matches this fork's multi-workspace /api/mcp DTO.
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, fsCache: false, jsx: { runtime: "automatic" } });
const { McpConfig } = await jiti.import("./McpConfig.tsx");
afterEach(cleanup);

test("MCP switches persist the named action and reload without sending a model prompt", async (t) => {
  let disabled = true;
  const actions = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (options?.method === "PATCH") {
      const action = JSON.parse(options.body);
      actions.push(action);
      if (action.action === "enable") disabled = false;
      return Response.json({ success: true });
    }
    const inventory = [{ name: "demo", source: "User level", sourcePath: "/fixture/mcp.json", status: disabled ? "disabled" : "configured", type: "stdio" }];
    return Response.json({
      workspaces: [{ cwd: "/fixture", name: "fixture", path: null, exists: false, servers: [] }],
      user: { path: "/fixture/mcp.json", servers: [], disabledServers: [] },
      userServers: [],
      builtinPresets: [],
      inventory,
      liveServers: inventory,
      path: null,
    });
  });
  render(React.createElement(McpConfig, { cwd: null, sessionId: "fixture-session" }));
  const toggle = await screen.findByRole("switch", { name: "Enable demo" });
  await waitFor(() => assert.equal(toggle.disabled, false));
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  await act(async () => { fireEvent.click(toggle); });
  await waitFor(() => assert.equal(toggle.getAttribute("aria-checked"), "true"));
  assert.deepEqual(actions[0], { sessionId: "fixture-session", action: "enable", name: "demo" });
  await waitFor(() => assert.equal(screen.getByRole("button", { name: "Reload MCP" }).disabled, false));
  const reloadButton = screen.getByRole("button", { name: "Reload MCP" });
  await act(async () => { fireEvent.click(reloadButton); });
  await waitFor(() => assert.equal(actions.length, 2));
  assert.deepEqual(actions[1], { sessionId: "fixture-session", action: "reload" });
  await waitFor(() => assert.equal(reloadButton.disabled, false));
});

test("MCP management cannot mutate configuration without a selected session", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({
    workspaces: [],
    user: { path: "/fixture/mcp.json", servers: [], disabledServers: [] },
    userServers: [],
    builtinPresets: [],
    inventory: [{ name: "demo", source: "User level", status: "configured" }],
  }));
  render(React.createElement(McpConfig, { cwd: null }));
  assert.equal((await screen.findByRole("switch", { name: "Enable demo" })).disabled, true);
  assert.equal(screen.getByRole("button", { name: "Reload MCP" }).disabled, true);
});
