import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseOmpUpdateStatus } = jiti("./updates.ts");

test("parses OMP update availability without assuming an update exists", () => {
  assert.deepEqual(parseOmpUpdateStatus("Current version: 17.2.11\nNew version available: 17.2.12"), {
    currentVersion: "17.2.11",
    availableVersion: "17.2.12",
    updateAvailable: true,
    updateCommand: "omp update",
  });
  assert.deepEqual(parseOmpUpdateStatus("Current version: 17.2.12\nOMP is up to date"), {
    currentVersion: "17.2.12",
    availableVersion: null,
    updateAvailable: false,
    updateCommand: "omp update",
  });
});

test("update command routes .cmd launchers through cmd.exe on win32", async (t) => {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", { value: original }));
  const dir = mkdtempSync(join(tmpdir(), "omp-update-win-"));
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
    queueMicrotask(() => callback(null, "omp is up to date\n", ""));
  });
  const { runOmpUpdateNow } = jiti("./updates.ts");
  const output = await runOmpUpdateNow();
  assert.equal(output, "omp is up to date");
  assert.equal(ref.captured.file, "cmd.exe");
  assert.deepEqual(ref.captured.args, ["/d", "/s", "/c", `${bin} update`]);
  assert.equal(ref.captured.options.windowsHide, true);
});
