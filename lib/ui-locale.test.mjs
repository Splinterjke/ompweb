import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const uiLocale = await jiti.import("./ui-locale.ts");

const EVENT_TYPES = [
  "conversation_completed",
  "conversation_interrupted",
  "assistant_text",
  "thinking_completed",
  "subagent_completed",
  "user_prompt_sent",
  "provider_api_error",
  "task_completed",
  "context_compacted",
  "question_asked",
];

test("translateEventName resolves every event type in all three locales", () => {
  for (const locale of ["en", "zh-CN", "ja"]) {
    for (const type of EVENT_TYPES) {
      const name = uiLocale.translateEventName(type, locale);
      assert.ok(name.length > 0, `${locale}/${type} is empty`);
      // A resolved name must come from the dictionary, not fall back to the
      // raw event type (would mean a missing i18n key).
      assert.notEqual(name, type, `${locale}/${type} fell back to the raw type`);
    }
  }
});

test("translateEventName returns the en dictionary values verbatim", () => {
  assert.equal(uiLocale.translateEventName("conversation_completed", "en"), "Conversation completed");
  assert.equal(uiLocale.translateEventName("question_asked", "en"), "Assistant asked a question");
});

test("getUiLocale defaults to en and follows setUiLocale", () => {
  uiLocale.setUiLocale("en");
  assert.equal(uiLocale.getUiLocale(), "en");
  uiLocale.setUiLocale("zh-CN");
  assert.equal(uiLocale.getUiLocale(), "zh-CN");
  // translateEventName without an explicit locale uses the current UI locale.
  assert.equal(uiLocale.translateEventName("conversation_completed"), "会话完成");
  uiLocale.setUiLocale("ja");
  assert.equal(uiLocale.translateEventName("conversation_completed"), "会話完了");
  // Reset so other test files are unaffected.
  uiLocale.setUiLocale("en");
});

test("isUiLocale accepts only the three UI locales", () => {
  assert.ok(uiLocale.isUiLocale("en"));
  assert.ok(uiLocale.isUiLocale("zh-CN"));
  assert.ok(uiLocale.isUiLocale("ja"));
  assert.ok(!uiLocale.isUiLocale("fr"));
  assert.ok(!uiLocale.isUiLocale("en-GB"));
  assert.ok(!uiLocale.isUiLocale(undefined));
  assert.ok(!uiLocale.isUiLocale(1));
});

test("persistUiLocale survives a restart (lazy load on first getUiLocale)", async (t) => {
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const paths = await jiti.import("./omp/paths.ts");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ui-locale-test-"));
  const prevEnv = process.env.PI_CODING_AGENT_DIR;
  const prevLocale = globalThis.__ompUiLocale;
  process.env.PI_CODING_AGENT_DIR = tmp;
  delete globalThis.__ompUiLocale;
  t.after(() => {
    if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevEnv;
    globalThis.__ompUiLocale = prevLocale ?? "en";
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  try {
    if (paths.getAgentDir() !== tmp) {
      // A named profile is active, so the env override is not honored and
      // the test would write into the real agent dir — skip instead.
      t.skip("PI_CODING_AGENT_DIR override not honored (active profile)");
      return;
    }
    uiLocale.persistUiLocale("ja");
    assert.ok(fs.existsSync(path.join(tmp, "ui-locale.json")));
    // Simulate a server restart: in-memory mirror gone, disk remains.
    delete globalThis.__ompUiLocale;
    assert.equal(uiLocale.getUiLocale(), "ja");
    // Corrupt file falls back to the default instead of throwing.
    fs.writeFileSync(path.join(tmp, "ui-locale.json"), "not-json", "utf8");
    delete globalThis.__ompUiLocale;
    assert.equal(uiLocale.getUiLocale(), "en");
  } finally {
    // Ensure the module ends in a known in-memory state for later tests.
    uiLocale.setUiLocale("en");
  }
});
