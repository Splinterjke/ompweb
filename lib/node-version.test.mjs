import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");
const {
  MIN_BUN_VERSION,
  MIN_NODE_VERSION,
  getUnsupportedNodeVersionMessage,
  getUnsupportedRuntimeVersionMessage,
  isBunVersionSupported,
  isNodeVersionSupported,
  isRuntimeSupported,
} = require("../bin/node-version.js");

test("accepts the minimum supported Node.js version and newer versions", () => {
  for (const version of ["22.19.0", "v22.19.0", "22.19.1", "23.0.0"]) {
    assert.equal(isNodeVersionSupported(version), true, version);
  }
});

test("rejects older and invalid Node.js versions", () => {
  for (const version of ["20.19.5", "22.18.99", "invalid"]) {
    assert.equal(isNodeVersionSupported(version), false, version);
  }
});

test("keeps the package engine aligned with the startup check", () => {
  assert.equal(packageJson.engines.node, `>=${MIN_NODE_VERSION}`);
});

test("reports both the required and current Node.js versions", () => {
  const message = getUnsupportedNodeVersionMessage("20.19.5");
  assert.match(message, /requires Node\.js 22\.19\.0 or newer/);
  assert.match(message, /Current Node\.js version: 20\.19\.5/);
});

test("accepts supported Bun versions", () => {
  for (const version of ["1.1.0", "1.3.14", "2.0.0"]) {
    assert.equal(isBunVersionSupported(version), true, version);
  }
});

test("rejects older and invalid Bun versions", () => {
  for (const version of ["0.8.0", "1.0.9", "invalid"]) {
    assert.equal(isBunVersionSupported(version), false, version);
  }
});

test("isRuntimeSupported prefers Bun when present", () => {
  assert.equal(isRuntimeSupported({ bun: "1.3.14", node: "16.0.0" }), true);
  assert.equal(isRuntimeSupported({ bun: "0.8.0", node: "22.19.0" }), false);
});

test("isRuntimeSupported falls back to Node when Bun is absent", () => {
  assert.equal(isRuntimeSupported({ node: "22.19.0" }), true);
  assert.equal(isRuntimeSupported({ node: "20.0.0" }), false);
});

test("reports both the required and current Bun versions", () => {
  const message = getUnsupportedRuntimeVersionMessage({ bun: "0.8.0" });
  assert.match(message, /requires Bun 1\.1\.0 or newer/);
  assert.match(message, /Current Bun version: 0\.8\.0/);
});
