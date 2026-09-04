import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": new URL("..", import.meta.url).pathname.replace(/\/$/, "") },
});

const {
  scanAllRoots,
  getSkillDetail,
  toggleSkill,
  createSkill,
  deleteSkill,
  isSkillName,
} = await jiti.import("./skill-hub/skill-hub-service.ts");

const {
  parseFrontmatter,
  repairFrontmatterFileText,
} = await jiti.import("./skill-hub/skill-hub-diagnostics.ts");

test("isSkillName validates kebab-case skill names correctly", () => {
  assert.equal(isSkillName("demo-skill"), true);
  assert.equal(isSkillName("pdf-extractor"), true);
  assert.equal(isSkillName("Skill123"), false);
  assert.equal(isSkillName("under_score"), false);
  assert.equal(isSkillName(""), false);
});

test("parseFrontmatter parses valid YAML frontmatter and extracts fields", () => {
  const text = `---
name: sample-skill
description: A sample skill for testing
whenToUse: When running unit tests
---

# Sample Skill

Instructions here.
`;
  const res = parseFrontmatter(text);
  assert.equal("value" in res, true);
  if ("value" in res) {
    assert.equal(res.value.name, "sample-skill");
    assert.equal(res.value.description, "A sample skill for testing");
    assert.equal(res.value.whenToUse, "When running unit tests");
    assert.equal(res.value.invocation.modelInvocable, true);
    assert.equal(res.value.invocation.userInvocable, true);
  }
});

test("repairFrontmatterFileText fixes unquoted colons in scalar fields", () => {
  const broken = `---
name: aws-deploy
description: Deploy services: ECS, Fargate and Lambda
---

Body text.`;
  const fixed = repairFrontmatterFileText(broken);
  assert.notEqual(fixed, null);
  assert.match(fixed, /'Deploy services: ECS, Fargate and Lambda'/);
  const parsed = parseFrontmatter(fixed);
  assert.equal("value" in parsed, true);
});

test("toggleSkill enables skills with disable-model-invocation frontmatter and .disabled files", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "skill-hub-toggle-test-"));
  try {
    const testSkillDir = join(tempDir, ".agents", "skills", "test-toggle-skill");
    mkdirSync(testSkillDir, { recursive: true });
    const skillFile = join(testSkillDir, "SKILL.md");
    writeFileSync(
      skillFile,
      `---\ndisable-model-invocation: true\nname: test-toggle-skill\ndescription: Test toggling\n---\n\nContent\n`,
      "utf8"
    );

    // Initial scan: should be disabled because disable-model-invocation: true
    const cat1 = await scanAllRoots({ cwd: tempDir });
    assert.equal(cat1.disabled.some((d) => d.name === "test-toggle-skill"), true);
    assert.equal(cat1.skills.some((s) => s.name === "test-toggle-skill"), false);

    // Enable it
    const res1 = await toggleSkill("test-toggle-skill", true, { cwd: tempDir });
    assert.equal(res1.ok, true);
    assert.equal(res1.catalog.skills.some((s) => s.name === "test-toggle-skill"), true);
    assert.equal(res1.catalog.disabled.some((d) => d.name === "test-toggle-skill"), false);

    // Disable it
    const res2 = await toggleSkill("test-toggle-skill", false, { cwd: tempDir });
    assert.equal(res2.ok, true);
    assert.equal(res2.catalog.skills.some((s) => s.name === "test-toggle-skill"), false);
    assert.equal(res2.catalog.disabled.some((d) => d.name === "test-toggle-skill"), true);

    // Re-enable it
    const res3 = await toggleSkill("test-toggle-skill", true, { cwd: tempDir });
    assert.equal(res3.ok, true);
    assert.equal(res3.catalog.skills.some((s) => s.name === "test-toggle-skill"), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("parseFrontmatter respects hide: true as disabling model invocation", () => {
  const text = `---\nname: hide-skill\ndescription: Test hide\nhide: true\n---\n\nBody`;
  const res = parseFrontmatter(text);
  assert.equal("value" in res, true);
  if ("value" in res) {
    assert.equal(res.value.invocation.modelInvocable, false);
  }
});
