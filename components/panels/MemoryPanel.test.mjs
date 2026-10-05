import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { bankForWorkspace } = await jiti.import("./MemoryPanel.tsx");

const banks = (names) => names.map((name) => ({ name, counts: { working: 0, episodic: 0, facts: 0, gists: 0 }, mtimeMs: 0 }));

test("a workspace claims its mnemopi bank by the directory base name", () => {
  const list = banks(["ompweb-2oa6n9z4asyg0", "Minrtans_Services-1zts7q1iw8qnt", "work-2jwgbf0qzo223"]);
  assert.equal(bankForWorkspace(list, "/work/ompweb")?.name, "ompweb-2oa6n9z4asyg0");
  assert.equal(bankForWorkspace(list, "/data/Minrtans_Services")?.name, "Minrtans_Services-1zts7q1iw8qnt");
  assert.equal(bankForWorkspace(list, "/work/ompweb/")?.name, "ompweb-2oa6n9z4asyg0", "trailing separator is ignored");
  assert.equal(bankForWorkspace(list, "/work/OMPWEB")?.name, "ompweb-2oa6n9z4asyg0", "matching is case-insensitive");
  assert.equal(bankForWorkspace(list, "C:\\work\\ompweb")?.name, "ompweb-2oa6n9z4asyg0", "windows separators resolve too");
});

test("no bank for the workspace answers null (the caller keeps the first bank)", () => {
  const list = banks(["ompweb-2oa6n9z4asyg0"]);
  assert.equal(bankForWorkspace(list, "/work/other-repo"), null);
  assert.equal(bankForWorkspace(list, null), null);
  assert.equal(bankForWorkspace(list, "/"), null);
  // A prefix collision must not claim a longer-named bank: "omp" ≠ "ompweb-…"
  assert.equal(bankForWorkspace(list, "/work/omp"), null);
});
