import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "ompweb-session-preferences-"));
const path = join(root, "preferences.json");
process.env.OMP_WEB_SESSION_PREFERENCES = path;
const subject = await import(`./session-preferences.ts?test=${Date.now()}`);

test.after(() => {
  delete process.env.OMP_WEB_SESSION_PREFERENCES;
  rmSync(root, { recursive: true, force: true });
});

test("persists advisor choice per session", () => {
  assert.equal(subject.getSessionAdvisorEnabled("one"), false);
  subject.setSessionAdvisorEnabled("one", true);
  subject.setSessionAdvisorEnabled("two", false);
  assert.equal(subject.getSessionAdvisorEnabled("one"), true);
  assert.equal(subject.getSessionAdvisorEnabled("two"), false);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).sessions.one.advisorEnabled, true);
});
