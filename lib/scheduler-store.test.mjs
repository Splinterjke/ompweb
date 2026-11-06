import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createJiti } from "jiti";

// Isolate the store in a temp agent dir before any store call resolves it.
const agentDir = mkdtempSync(join(tmpdir(), "omp-scheduler-store-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

after(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url);
const store = await jiti.import("./scheduler-store.ts");

// Regression: normalizeEntry re-projects every entry on each load; a field
// missing from that projection silently vanishes from the API after the next
// save (observed 2026-10: thinkingLevel set via UI/POST persisted to disk but
// every GET returned undefined, and the next PATCH dropped it from the file).
test("prompt entry keeps thinkingLevel across save/reload", () => {
  const { file, entry } = store.createSchedulerEntry({
    name: "thinky",
    kind: "prompt",
    prompt: "summarize commits",
    provider: "anthropic",
    modelId: "claude-opus-4",
    thinkingLevel: "xhigh",
    schedule: { kind: "manual" },
  });
  assert.equal(entry.thinkingLevel, "xhigh");
  store.saveSchedulerFile(file);

  const reloaded = store.loadSchedulerFile().schedulers.find((e) => e.id === entry.id);
  assert.ok(reloaded, "entry survives reload");
  assert.equal(reloaded.thinkingLevel, "xhigh", "thinkingLevel survives the load projection");
  assert.equal(reloaded.provider, "anthropic");
  assert.equal(reloaded.modelId, "claude-opus-4");
});

test("updateSchedulerEntry carries thinkingLevel through unrelated patches and clears on empty", () => {
  const first = store.loadSchedulerFile().schedulers[0];

  const { file: offFile } = store.updateSchedulerEntry(first.id, { enabled: false });
  store.saveSchedulerFile(offFile);
  const afterToggle = store.loadSchedulerFile().schedulers.find((e) => e.id === first.id);
  assert.equal(afterToggle.enabled, false);
  assert.equal(afterToggle.thinkingLevel, "xhigh", "unrelated patch must not drop thinkingLevel");

  const { file: clearedFile } = store.updateSchedulerEntry(first.id, { thinkingLevel: "" });
  store.saveSchedulerFile(clearedFile);
  const afterClear = store.loadSchedulerFile().schedulers.find((e) => e.id === first.id);
  assert.equal(afterClear.thinkingLevel, undefined, "explicit empty clears the thinking level");
});

test("script entries never carry thinkingLevel", () => {
  const scriptPath = join(agentDir, "noop.sh");
  writeFileSync(scriptPath, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(scriptPath, 0o755);
  const { file, entry } = store.createSchedulerEntry({
    name: "plain script",
    kind: "script",
    script: scriptPath,
    thinkingLevel: "xhigh",
    schedule: { kind: "manual" },
  });
  assert.equal(entry.thinkingLevel, undefined);
  store.saveSchedulerFile(file);
  const reloaded = store.loadSchedulerFile().schedulers.find((e) => e.id === entry.id);
  assert.equal(reloaded.thinkingLevel, undefined);
});

// A Windows script file is not a process image, so the engine supplies its interpreter (see
// `scriptInvocation`). Validation has to agree: demanding the executable bit the format cannot
// carry would reject `ompweb.ps1` -- the seeded Windows rebuild workflow -- with
// script_not_executable before it could ever be saved.
test("interpreter-run scripts validate without an executable bit", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-scheduler-validate-"));
  try {
    const ps1 = join(dir, "ompweb.ps1");
    const cmd = join(dir, "wrapper.cmd");
    const sh = join(dir, "flow.sh");
    for (const file of [ps1, cmd, sh]) writeFileSync(file, "# script\n");

    const asPowerShell = store.validateScriptPath(ps1, "win32");
    assert.equal(asPowerShell.ok, true, `ps1 rejected: ${asPowerShell.error}`);
    assert.equal(asPowerShell.shell, "powershell");
    assert.equal(asPowerShell.path, ps1, "the stored path stays the script, not an interpreter");
    assert.equal(store.validateScriptPath(cmd, "win32").shell, "cmd");
    assert.equal(store.validateScriptPath(sh, "win32").shell, "bash");
    // Off Windows PowerShell is not the interpreter, so that path is just a file.
    assert.equal(store.validateScriptPath(ps1, "linux").shell, "exec");
    // The existing path checks are untouched.
    assert.equal(store.validateScriptPath(join(dir, "missing.ps1"), "win32").error, "script_not_found");
    assert.equal(store.validateScriptPath("   ", "win32").error, "script_required");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
