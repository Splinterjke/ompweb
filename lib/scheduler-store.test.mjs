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
