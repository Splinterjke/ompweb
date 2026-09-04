import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { readNativeSettings, writeNativeSettings } = await jiti.import("./settings-config.ts");

function withAgentDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-settings-config-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    run(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("uses config.yaml when the canonical config.yml is absent", () => {
  withAgentDir((dir) => {
    const fallback = join(dir, "config.yaml");
    writeFileSync(fallback, "compaction:\n  methodOrder:\n    - snapcompact\n", "utf8");
    assert.equal(readNativeSettings().path, fallback);
    assert.deepEqual(readNativeSettings().settings.compaction.methodOrder, ["snapcompact"]);

    writeNativeSettings({ hideThinkingBlock: true });
    assert.equal(existsSync(join(dir, "config.yml")), false);
    assert.match(readFileSync(fallback, "utf8"), /hideThinkingBlock: true/);
    // Unrelated writes preserve the pre-existing compaction block.
    assert.match(readFileSync(fallback, "utf8"), /methodOrder/);
  });
});

test("rejects malformed native settings and validates compaction schema", () => {
  withAgentDir(() => {
    assert.throws(() => writeNativeSettings({ mcp: { notifications: "yes" } }), /mcp.notifications must be a boolean/);
    assert.throws(() => writeNativeSettings({ compaction: { methodOrder: ["snapcompact", "snapcompact"] } }), /Invalid compaction methodOrder/);
    assert.throws(() => writeNativeSettings({ compaction: { methodOrder: ["snapcompact", "prune"] } }), /Invalid compaction methodOrder/);
    assert.throws(() => writeNativeSettings({ compaction: { methodOrder: [] } }), /Invalid compaction methodOrder/);
    assert.throws(() => writeNativeSettings({ compaction: { thresholdPercent: 101 } }), /thresholdPercent/);
    assert.throws(() => writeNativeSettings({ compaction: { thresholdPercent: 0.5 } }), /thresholdPercent/);
    assert.throws(() => writeNativeSettings({ compaction: { keepRecentTokens: 100 } }), /keepRecentTokens/);
    assert.throws(() => writeNativeSettings({ compaction: { idleTimeoutSeconds: 0 } }), /idleTimeoutSeconds/);
    assert.throws(() => writeNativeSettings({ branchSummary: { reserveTokens: -1 } }), /reserveTokens/);
    writeNativeSettings({ compaction: { methodOrder: ["snapcompact", "handoff", "shake"], thresholdPercent: 80, reserveTokens: null, remoteEndpoint: "https://llm.local/v1" } });
    const settings = readNativeSettings().settings.compaction;
    assert.deepEqual(settings.methodOrder, ["snapcompact", "handoff", "shake"]);
    assert.equal(settings.thresholdPercent, 80);
    // null means "delete the key": the key must not persist.
    assert.equal(settings.reserveTokens, undefined);
    assert.doesNotMatch(readFileSync(join(process.env.PI_CODING_AGENT_DIR, "config.yml"), "utf8"), /reserveTokens/);
    assert.equal(settings.remoteEndpoint, "https://llm.local/v1");
  });
});
test("preserves TUI-set compaction keys when ompweb saves an unrelated setting", () => {
  withAgentDir((dir) => {
    // The TUI writes keys ompweb's allowlist did not know about (thresholdPercent,
    // handoffSaveToDisk, methodOrder). An ompweb save must merge into the document,
    // never replace it — those keys must survive.
    writeFileSync(join(dir, "config.yml"), [
      "compaction:",
      "  enabled: true",
      "  thresholdPercent: 90",
      "  handoffSaveToDisk: true",
      "  methodOrder:",
      "    - remote",
      "    - snapcompact",
      "    - handoff",
      "    - soft",
      "    - shake",
      "  asyncEnabled: true",
      "  idleEnabled: false",
      "retry:",
      "  enabled: true",
    ].join("\n"), "utf8");
    const before = readNativeSettings();
    // Simulate the UI flipping the auto-continue toggle: the snapshot is the
    // parsed allowlist projection plus the patched field.
    writeNativeSettings({ ...before.settings, compaction: { ...before.settings.compaction, autoContinue: false } });
    const file = readFileSync(join(dir, "config.yml"), "utf8");
    for (const key of ["thresholdPercent: 90", "handoffSaveToDisk: true", "asyncEnabled: true", "idleEnabled: false"]) {
      assert.match(file, new RegExp(key.replace(/[.]/g, "\\.")));
    }
    const after = readNativeSettings().settings.compaction;
    assert.equal(after.thresholdPercent, 90);
    assert.equal(after.handoffSaveToDisk, true);
    assert.equal(after.asyncEnabled, true);
    assert.equal(after.idleEnabled, false);
    assert.equal(after.autoContinue, false);
    assert.deepEqual(after.methodOrder, ["remote", "snapcompact", "handoff", "soft", "shake"]);
  });
});
test("first write into an empty document serializes compaction without undefined values", () => {
  withAgentDir(() => {
    // null means "delete the key" and cannot exist in a freshly created
    // document — it must be dropped, not serialized.
    writeNativeSettings({ compaction: { methodOrder: ["snapcompact", "handoff"], reserveTokens: null, thresholdPercent: 80 } });
    const file = readFileSync(join(process.env.PI_CODING_AGENT_DIR, "config.yml"), "utf8");
    assert.doesNotMatch(file, /undefined/);
    assert.doesNotMatch(file, /: null/);
    assert.doesNotMatch(file, /reserveTokens/);
    assert.match(file, /methodOrder/);
    assert.match(file, /thresholdPercent: 80/);
  });
});
test("persists and reads the externalThinking setting (v17.2.14+)", () => {
  withAgentDir(() => {
    assert.throws(() => writeNativeSettings({ externalThinking: "yes" }), /externalThinking must be a boolean/);
    writeNativeSettings({ externalThinking: true });
    assert.equal(readNativeSettings().settings.externalThinking, true);
    // Writes are incremental: an unrelated later write preserves the key.
    writeNativeSettings({ hideThinkingBlock: true });
    assert.equal(readNativeSettings().settings.externalThinking, true);
    assert.equal(readNativeSettings().settings.hideThinkingBlock, true);
  });
});
test("persists and validates retry settings", () => {
  withAgentDir(() => {
    writeNativeSettings({ retry: { enabled: false, maxRetries: 3, modelFallback: true } });
    const settings = readNativeSettings().settings.retry;
    assert.equal(settings?.enabled, false);
    assert.equal(settings?.maxRetries, 3);
    assert.equal(settings?.modelFallback, true);
    assert.throws(() => writeNativeSettings({ retry: { maxRetries: 99 } }), /Retry attempts must be an integer between 0 and 20/);
  });
});
test("persists and validates tool approval policies", () => {
  withAgentDir(() => {
    writeNativeSettings({ tools: { approval: { bash: "deny", extension: "allow" } } });
    const settings = readNativeSettings().settings;
    assert.equal(settings.tools.approval.bash, "deny");
    assert.equal(settings.tools.approval.extension, "allow");
    assert.throws(() => writeNativeSettings({ tools: { approval: { bash: "bogus" } } }), /Invalid Bash approval policy/);
    assert.throws(() => writeNativeSettings({ tools: { approval: { extension: "deny" } } }), /Invalid extension tool approval policy/);
  });
});

test("persists and validates the 16 newly mapped internal settings", () => {
  withAgentDir(() => {
    writeNativeSettings({
      modelRoles: { slow: "opencodex/opencode-go/deepseek-v4-flash:max", plan: "opencode-go/deepseek-v4-flash:max" },
      generateImage: { enabled: true },
      computer: { enabled: true },
      skills: { enableCodexUser: true, enableAgentsUser: false, enableClaudeUser: false, enableClaudeProject: true },
      bash: { autoBackground: { enabled: false } },
      providers: { memoryModel: "qwen3-1.7b", webSearchOrder: ["searxng", "bing"] },
      security: { enabled: true },
      github: { enabled: false },
      colorBlindMode: true,
      contextPromotion: { enabled: true },
      snapcompact: { toolResults: true },
      edit: { mode: "hashline" },
      composer: { shape: "box" },
      dev: { autoqaConsent: "granted" },
      symbolPreset: "unicode",
    });
    const settings = readNativeSettings().settings;
    assert.deepEqual(settings.modelRoles, { slow: "opencodex/opencode-go/deepseek-v4-flash:max", plan: "opencode-go/deepseek-v4-flash:max" });
    assert.equal(settings.generateImage?.enabled, true);
    assert.equal(settings.computer?.enabled, true);
    assert.deepEqual(settings.skills, { enableCodexUser: true, enableAgentsUser: false, enableClaudeUser: false, enableClaudeProject: true });
    assert.equal(settings.bash?.autoBackground?.enabled, false);
    assert.deepEqual(settings.providers, { memoryModel: "qwen3-1.7b", webSearchOrder: ["searxng", "bing"] });
    assert.equal(settings.security?.enabled, true);
    assert.equal(settings.github?.enabled, false);
    assert.equal(settings.colorBlindMode, true);
    assert.equal(settings.contextPromotion?.enabled, true);
    assert.equal(settings.snapcompact?.toolResults, true);
    assert.equal(settings.edit?.mode, "hashline");
    assert.equal(settings.composer?.shape, "box");
    assert.equal(settings.dev?.autoqaConsent, "granted");
    assert.equal(settings.symbolPreset, "unicode");
  });
});

test("rejects malformed new settings", () => {
  withAgentDir(() => {
    assert.throws(() => writeNativeSettings({ modelRoles: { slow: "" } }), /Model roles require non-empty role and model values/);
    assert.throws(() => writeNativeSettings({ providers: { webSearchOrder: [42] } }), /webSearchOrder must be an array of strings/);
    assert.throws(() => writeNativeSettings({ generateImage: { enabled: "yes" } }), /generateImage.enabled must be a boolean/);
    assert.throws(() => writeNativeSettings({ symbolPreset: "" }), /symbolPreset must be a non-empty string/);
    assert.throws(() => writeNativeSettings({ colorBlindMode: "no" }), /colorBlindMode must be a boolean/);
  });
});

test("null clears mapped string fields instead of writing null", () => {
  withAgentDir(() => {
    writeNativeSettings({
      providers: { memoryModel: "qwen3-1.7b" },
      edit: { mode: "hashline" },
      composer: { shape: "box" },
      dev: { autoqaConsent: "granted" },
      symbolPreset: "unicode",
    });
    // Clearing via null removes the keys from the YAML document.
    writeNativeSettings({
      providers: { memoryModel: null },
      edit: { mode: null },
      composer: { shape: null },
      dev: { autoqaConsent: null },
      symbolPreset: null,
    });
    const settings = readNativeSettings().settings;
    assert.equal(settings.providers?.memoryModel, undefined);
    assert.equal(settings.edit?.mode, undefined);
    assert.equal(settings.composer?.shape, undefined);
    assert.equal(settings.dev?.autoqaConsent, undefined);
    assert.equal(settings.symbolPreset, undefined);
    const file = readFileSync(join(dirFor(), "config.yml"), "utf8");
    assert.doesNotMatch(file, /memoryModel/);
    assert.doesNotMatch(file, /hashline/);
    assert.doesNotMatch(file, /: null/);
  });
});

function dirFor() {
  // withAgentDir already removed the dir; re-create the path used there.
  return process.env.PI_CODING_AGENT_DIR;
}
