import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { healthOf, shouldAutoFix } = await jiti.import("./BackendDiagnostics.tsx");

const base = {
  server: { node: "v24", platform: "darwin", arch: "arm64", uptimeSeconds: 10 },
  omp: { installed: true, path: "/usr/bin/omp", version: "18.0.10" },
  proxy: { config: { mode: "auto" }, effective: "http://127.0.0.1:7890" },
  rpc: { activeSessions: 1 },
  web: { port: "30179", url: "http://127.0.0.1:30179" },
};

test("healthOf: everything green reports ok", () => {
  assert.equal(healthOf(base), "ok");
});

test("healthOf: healthy sibling loopback instance is informational", () => {
  assert.equal(healthOf({ ...base, instances: { selfPort: 30178, others: [30179] } }), "ok");
});

test("healthOf: missing omp binary reports error", () => {
  assert.equal(healthOf({ ...base, omp: { installed: false, path: null, version: null } }), "error");
});

test("healthOf: auto proxy without an effective endpoint warns", () => {
  assert.equal(healthOf({ ...base, proxy: { config: { mode: "auto" }, effective: null } }), "warn");
});

test("healthOf: unavailable rust host binary in rust mode reports error", () => {
  assert.equal(healthOf({ ...base, rustHost: { mode: "workspace", path: "/missing/ompweb-host", available: false } }), "error");
  // Explicit node rollback mode has no rust host — that must not read as error.
  assert.equal(healthOf({ ...base, rustHost: { mode: "node", path: "", available: false } }), "ok");
  // Older payload without the field stays ok.
  assert.equal(healthOf({ ...base }), "ok");
});

test("healthOf: host unavailable/crash in the backend error ring reports error", () => {
  assert.equal(healthOf({ ...base, backendErrors: [{ at: 1, kind: "host_unavailable", detail: "x" }] }), "error");
  assert.equal(healthOf({ ...base, backendErrors: [{ at: 1, kind: "host_crash", detail: "x" }] }), "error");
});

test("healthOf: session-domain failures warn once and error from two", () => {
  const scan = { at: 1, kind: "session_scan_failed", detail: "x" };
  assert.equal(healthOf({ ...base, backendErrors: [scan] }), "warn");
  assert.equal(healthOf({ ...base, backendErrors: [scan, scan] }), "error");
});

test("healthOf: benign non-repo git entries never degrade, real git failures do", () => {
  // A non-git workspace used to record git_* entries with the "not a git
  // repository" detail; those are benign and must not warn or error — even a
  // pile of them (the banner's Recovery queue is gated on health, so it stays
  // hidden too).
  const benign = { at: 1, kind: "git_diff_failed", detail: "not a git repository" };
  const benign2 = { at: 2, kind: "git_status_failed", detail: "not a git repository" };
  assert.equal(healthOf({ ...base, backendErrors: [benign] }), "ok");
  assert.equal(healthOf({ ...base, backendErrors: [benign, benign2, benign, benign2] }), "ok");
  // Read-only git failures (status/branches/diff) are fired automatically by
  // background polling and are always visible at the point of use (empty bar,
  // inline panel error), so even a real timeout on a slow repository must not
  // degrade the whole app.
  const realRead = { at: 3, kind: "git_status_failed", detail: "git operation timed out" };
  assert.equal(healthOf({ ...base, backendErrors: [benign, realRead] }), "ok");
  assert.equal(healthOf({ ...base, backendErrors: [realRead, realRead, realRead] }), "ok");
  // Explicit user git actions (commit / push / checkout) are real failures
  // and still degrade.
  const realWrite = { at: 4, kind: "git_commit_failed", detail: "git failed" };
  assert.equal(healthOf({ ...base, backendErrors: [benign, realWrite] }), "warn");
  assert.equal(healthOf({ ...base, backendErrors: [realWrite, realWrite] }), "error");
  // A real non-git failure still degrades alongside the benign noise.
  const scan = { at: 5, kind: "session_scan_failed", detail: "x" };
  assert.equal(healthOf({ ...base, backendErrors: [benign, benign2, scan] }), "warn");
});

test("shouldAutoFix: cooldown gates repeated auto-repair", () => {
  const now = 1_000_000;
  // 从未尝试过（0）→ 允许。
  assert.equal(shouldAutoFix(0, now), true);
  // 刚修过（<5min）→ 禁止（防抖动循环）。
  assert.equal(shouldAutoFix(now - 60_000, now), false);
  // 冷却期已过（≥5min）→ 允许。
  assert.equal(shouldAutoFix(now - 5 * 60_000, now), true);
});

test("status button retracts automatically after recovery and never stacks error text vertically", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "BackendDiagnostics.tsx"), "utf8");
  assert.match(source, /if \(autoOpenedRef\.current\) setOpen\(false\)/);
  assert.match(source, /whiteSpace: "nowrap"/);
  assert.match(source, /textOverflow: "ellipsis"/);
});
