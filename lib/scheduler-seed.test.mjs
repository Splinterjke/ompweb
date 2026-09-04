import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createJiti } from "jiti";

// Isolate the store in a temp agent dir before any store call resolves it.
const agentDir = mkdtempSync(join(tmpdir(), "omp-scheduler-seed-test-"));
const cwdDir = mkdtempSync(join(tmpdir(), "omp-scheduler-seed-cwd-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.chdir(cwdDir);

before(() => {
  // The seed resolves the script from the server cwd (repo root / install
  // root), so the test controls "is the script present" via this dir.
  writeFileSync(join(cwdDir, "ompweb-rebuild-restart.sh"), "#!/usr/bin/env bash\nexit 0\n");
});

after(() => {
  process.chdir(join(tmpdir()));
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(cwdDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url);
const store = await jiti.import("./scheduler-store.ts");

test("ensureSeedSchedulers seeds the rebuild script once, as a manual-launch entry", () => {
  const id = store.ensureSeedSchedulers();
  assert.ok(id, "seeding returns the new entry id");

  const entries = store.loadSchedulerFile().schedulers;
  const entry = entries.find((e) => e.id === id);
  assert.ok(entry, "seeded entry is persisted");
  assert.equal(entry.name, "OmpWeb Rebuild & Restart");
  assert.equal(entry.script, join(cwdDir, "ompweb-rebuild-restart.sh"));
  assert.deepEqual(entry.schedule, { kind: "manual" });
  assert.equal(entry.enabled, true);
  assert.equal(entry.nextRunAt, null, "manual schedulers have no next slot");
  assert.equal(entry.timeoutMs, 20 * 60_000);
  assert.equal(entry.human, "Manual launch");
  assert.equal(entries.length, 1, "exactly one seeded entry");

  // Idempotent: a second call must not duplicate the entry.
  assert.equal(store.ensureSeedSchedulers(), null, "no duplicate on re-seed");
  assert.equal(store.loadSchedulerFile().schedulers.length, 1);
});

test("ensureSeedSchedulers skips when the rebuild script is absent from cwd", () => {
  rmSync(join(cwdDir, "ompweb-rebuild-restart.sh"), { force: true });
  try {
    assert.equal(store.ensureSeedSchedulers(), null, "absent script yields no entry");
    // The previously seeded entry survives; nothing is added or removed.
    assert.equal(store.loadSchedulerFile().schedulers.length, 1);
  } finally {
    writeFileSync(join(cwdDir, "ompweb-rebuild-restart.sh"), "#!/usr/bin/env bash\nexit 0\n");
  }
});

test("ensureSeedSchedulers renames a pre-existing entry carrying the legacy display name", () => {
  // Simulate a config seeded before the display-name change: same script,
  // old name. The seed must reclaim that entry (rename) and NOT add a second.
  const script = join(cwdDir, "ompweb-rebuild-restart.sh");
  store.saveSchedulerFile({
    version: 1,
    schedulers: [
      {
        id: "s-legacy-rebuild",
        name: "Rebuild & restart",
        script,
        args: [],
        schedule: { kind: "manual" },
        enabled: true,
        timeoutMs: 20 * 60_000,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
        nextRunAt: null,
        human: "Manual launch",
        runs: [],
      },
    ],
  });
  try {
    assert.equal(store.ensureSeedSchedulers(), null, "no new entry is added");
    const entries = store.loadSchedulerFile().schedulers;
    assert.equal(entries.length, 1, "still exactly one entry");
    assert.equal(entries[0].name, "OmpWeb Rebuild & Restart", "legacy entry renamed");
    // Idempotent afterwards: the new name now matches the seed.
    assert.equal(store.ensureSeedSchedulers(), null);
    assert.equal(store.loadSchedulerFile().schedulers.length, 1);
  } finally {
    // Reset to a clean config for any following tests.
    store.saveSchedulerFile({ version: 1, schedulers: [] });
  }
});
