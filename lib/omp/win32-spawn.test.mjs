import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PassThrough } from "node:stream";
import { createJiti } from "jiti";

// moduleCache:false + tryNative:false keep t.mock.method(childProcess, ...) on
// the same CJS module instance the TypeScript import resolves.
const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });

/** Replace process.platform for the duration of one test (helper reads it at call time). */
function withPlatform(t, platform) {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform });
  t.after(() => Object.defineProperty(process, "platform", { value: original }));
}

/** Minimal fake child matching RpcProcess's constructor wiring. */
function makeSpawnHarness() {
  const spawnCalls = [];
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 4321,
  });
  return {
    spawnCalls,
    spawn(file, args, opts) {
      spawnCalls.push({ file, args, opts });
      return child;
    },
  };
}

function startProcess(bin, cwd, extraArgs = []) {
  const harness = makeSpawnHarness();
  new (jiti("./rpc-process.ts").RpcProcess)({
    cwd,
    extraArgs,
    dependencies: { resolveOmpBin: () => bin, spawn: harness.spawn },
  });
  return harness;
}

const CWD = mkdtempSync(join(tmpdir(), "omp-winspawn-"));

// --- wrapWindowsScript (pure) -------------------------------------------

test("wrapWindowsScript routes .cmd launchers through cmd.exe on win32", (t) => {
  withPlatform(t, "win32");
  const { wrapWindowsScript } = jiti("./omp-cli.ts");
  assert.deepEqual(wrapWindowsScript("C:\\tools\\omp.cmd", ["--version"]), {
    file: "cmd.exe",
    args: ["/d", "/s", "/c", "C:\\tools\\omp.cmd --version"],
  });
});

test("wrapWindowsScript routes .bat launchers through cmd.exe", (t) => {
  withPlatform(t, "win32");
  const { wrapWindowsScript } = jiti("./omp-cli.ts");
  assert.deepEqual(wrapWindowsScript("C:\\tools\\omp.bat", ["update"]), {
    file: "cmd.exe",
    args: ["/d", "/s", "/c", "C:\\tools\\omp.bat update"],
  });
});

test("wrapWindowsScript matches script extensions case-insensitively", (t) => {
  withPlatform(t, "win32");
  const { wrapWindowsScript } = jiti("./omp-cli.ts");
  assert.equal(wrapWindowsScript("C:\\tools\\OMP.CMD", []).file, "cmd.exe");
});

test("wrapWindowsScript quotes launchers and args with spaces", (t) => {
  withPlatform(t, "win32");
  const { wrapWindowsScript } = jiti("./omp-cli.ts");
  assert.deepEqual(wrapWindowsScript("C:\\tools dir\\omp.cmd", ["--cwd", "C:\\projects x"]), {
    file: "cmd.exe",
    args: ["/d", "/s", "/c", '"C:\\tools dir\\omp.cmd" --cwd "C:\\projects x"'],
  });
});

test("wrapWindowsScript leaves .exe binaries untouched on win32", (t) => {
  withPlatform(t, "win32");
  const { wrapWindowsScript } = jiti("./omp-cli.ts");
  assert.deepEqual(wrapWindowsScript("C:\\tools\\omp.exe", ["--version"]), {
    file: "C:\\tools\\omp.exe",
    args: ["--version"],
  });
});

test("wrapWindowsScript leaves extensionless binaries untouched", (t) => {
  withPlatform(t, "win32");
  const { wrapWindowsScript } = jiti("./omp-cli.ts");
  assert.deepEqual(wrapWindowsScript("omp", ["--version"]), { file: "omp", args: ["--version"] });
});

test("wrapWindowsScript never wraps .cmd on non-win32 platforms", (t) => {
  withPlatform(t, "linux");
  const { wrapWindowsScript } = jiti("./omp-cli.ts");
  assert.deepEqual(wrapWindowsScript("/usr/local/bin/omp.cmd", ["--version"]), {
    file: "/usr/local/bin/omp.cmd",
    args: ["--version"],
  });
});

// --- RpcProcess spawn seam ----------------------------------------------

test("RpcProcess routes .cmd launchers through cmd.exe on win32", (t) => {
  withPlatform(t, "win32");
  const harness = startProcess("C:\\tools\\omp-work.cmd", CWD);
  assert.equal(harness.spawnCalls.length, 1);
  assert.equal(harness.spawnCalls[0].file, "cmd.exe");
  assert.deepEqual(harness.spawnCalls[0].args, [
    "/d", "/s", "/c", `C:\\tools\\omp-work.cmd --mode rpc-ui --cwd ${CWD}`,
  ]);
  assert.equal(harness.spawnCalls[0].opts.cwd, CWD);
  assert.equal(harness.spawnCalls[0].opts.windowsHide, true);
});

test("RpcProcess leaves .exe binaries untouched", (t) => {
  withPlatform(t, "win32");
  const harness = startProcess("C:\\tools\\omp.exe", CWD);
  assert.equal(harness.spawnCalls[0].file, "C:\\tools\\omp.exe");
  assert.deepEqual(harness.spawnCalls[0].args, ["--mode", "rpc-ui", "--cwd", CWD]);
});

test("RpcProcess never wraps .cmd on non-win32 platforms", (t) => {
  withPlatform(t, "linux");
  const harness = startProcess("/usr/local/bin/omp-work.cmd", CWD);
  assert.equal(harness.spawnCalls[0].file, "/usr/local/bin/omp-work.cmd");
  assert.deepEqual(harness.spawnCalls[0].args, ["--mode", "rpc-ui", "--cwd", CWD]);
});

// --- getOmpVersion execFile seam -----------------------------------------

test("version probe routes .cmd launchers through cmd.exe on win32", async (t) => {
  withPlatform(t, "win32");
  const dir = mkdtempSync(join(tmpdir(), "omp-winspawn-probe-"));
  const bin = join(dir, "omp-work.cmd");
  writeFileSync(bin, "stub\n");
  const previousBin = process.env.OMP_WEB_OMP_BIN;
  process.env.OMP_WEB_OMP_BIN = bin;
  t.after(() => {
    if (previousBin === undefined) delete process.env.OMP_WEB_OMP_BIN;
    else process.env.OMP_WEB_OMP_BIN = previousBin;
    rmSync(dir, { recursive: true, force: true });
  });
  const ref = {};
  t.mock.method(childProcess, "execFile", (file, args, options, callback) => {
    ref.captured = { file, args, options };
    queueMicrotask(() => callback(null, "omp/18.2.4\n"));
  });
  const { getOmpVersion } = jiti("./omp-cli.ts");
  assert.equal(await getOmpVersion(), "omp/18.2.4");
  assert.equal(ref.captured.file, "cmd.exe");
  assert.deepEqual(ref.captured.args, ["/d", "/s", "/c", `${bin} --version`]);
  assert.equal(ref.captured.options.windowsHide, true);
});

test("version probe leaves .exe binaries untouched on win32", async (t) => {
  withPlatform(t, "win32");
  const dir = mkdtempSync(join(tmpdir(), "omp-winspawn-probe-"));
  const bin = join(dir, "omp.exe");
  writeFileSync(bin, "stub\n");
  const previousBin = process.env.OMP_WEB_OMP_BIN;
  process.env.OMP_WEB_OMP_BIN = bin;
  t.after(() => {
    if (previousBin === undefined) delete process.env.OMP_WEB_OMP_BIN;
    else process.env.OMP_WEB_OMP_BIN = previousBin;
    rmSync(dir, { recursive: true, force: true });
  });
  const ref = {};
  t.mock.method(childProcess, "execFile", (file, args, options, callback) => {
    ref.captured = { file, args, options };
    queueMicrotask(() => callback(null, "omp/18.2.4\n"));
  });
  const { getOmpVersion } = jiti("./omp-cli.ts");
  assert.equal(await getOmpVersion(), "omp/18.2.4");
  assert.equal(ref.captured.file, bin);
  assert.deepEqual(ref.captured.args, ["--version"]);
});

test("version probe never wraps .cmd on non-win32 platforms", async (t) => {
  withPlatform(t, "linux");
  const dir = mkdtempSync(join(tmpdir(), "omp-winspawn-probe-"));
  const bin = join(dir, "omp-work.cmd");
  writeFileSync(bin, "stub\n");
  const previousBin = process.env.OMP_WEB_OMP_BIN;
  process.env.OMP_WEB_OMP_BIN = bin;
  t.after(() => {
    if (previousBin === undefined) delete process.env.OMP_WEB_OMP_BIN;
    else process.env.OMP_WEB_OMP_BIN = previousBin;
    rmSync(dir, { recursive: true, force: true });
  });
  const ref = {};
  t.mock.method(childProcess, "execFile", (file, args, options, callback) => {
    ref.captured = { file, args, options };
    queueMicrotask(() => callback(null, "omp/18.2.4\n"));
  });
  const { getOmpVersion } = jiti("./omp-cli.ts");
  assert.equal(await getOmpVersion(), "omp/18.2.4");
  assert.equal(ref.captured.file, bin);
  assert.deepEqual(ref.captured.args, ["--version"]);
});
