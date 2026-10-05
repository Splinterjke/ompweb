import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

// Memory routes must never touch the live mnemopi databases, so every test
// runs against fixture banks in a fresh temp agent dir (PI_CODING_AGENT_DIR
// is resolved per call in lib/omp/paths.ts). The fixture databases are
// written here in tmp; the routes then open them read-only.

const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": new URL("../", import.meta.url).pathname,
  },
});
const { GET: listBanks } = await jiti.import("../app/api/memory/banks/route.ts");
const { GET: getBank } = await jiti.import("../app/api/memory/banks/[bank]/route.ts");

function createFixtureBank(banksRoot, name, rows) {
  const dir = join(banksRoot, name);
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "mnemopi.db"));
  db.exec(`
    CREATE TABLE working_memory (id TEXT PRIMARY KEY, content TEXT, memory_type TEXT, importance REAL, timestamp TEXT, recall_count INTEGER);
    CREATE TABLE episodic_memory (id TEXT PRIMARY KEY, content TEXT, source TEXT, importance REAL, summary_of TEXT, timestamp TEXT);
    CREATE TABLE facts (fact_id TEXT PRIMARY KEY, subject TEXT, predicate TEXT, object TEXT, confidence REAL, created_at TEXT);
    CREATE TABLE gists (id TEXT PRIMARY KEY, text TEXT, time_scope TEXT);
  `);
  for (const row of rows.working ?? []) db.prepare("INSERT INTO working_memory VALUES (?, ?, ?, ?, ?, ?)").run(...row);
  for (const row of rows.episodic ?? []) db.prepare("INSERT INTO episodic_memory VALUES (?, ?, ?, ?, ?, ?)").run(...row);
  for (const row of rows.facts ?? []) db.prepare("INSERT INTO facts VALUES (?, ?, ?, ?, ?, ?)").run(...row);
  for (const row of rows.gists ?? []) db.prepare("INSERT INTO gists VALUES (?, ?, ?)").run(...row);
  db.close();
}

function setupFixtureBanks(t) {
  const agentDir = mkdtempSync(join(tmpdir(), "ompweb-memory-test-"));
  const banksRoot = join(agentDir, "memories", "mnemopi", "banks");
  createFixtureBank(banksRoot, "alpha-1", {
    working: [
      ["w2", "Goal mode tracks the session objective", "fact", 0.9, "2026-10-05T10:00:00.000Z", 3],
      ["w1", "Plain older note", "preference", 0.4, "2026-10-04T10:00:00.000Z", 0],
    ],
    episodic: [
      ["e1", "Deployed the memory viewer", "sleep_consolidation", 0.6, "w1,w2", "2026-10-05T09:00:00.000Z"],
    ],
    facts: [
      ["f1", "Goal mode", "is", "session-scoped", 0.7, "2026-10-05 08:00:00"],
      ["f2", "Mnemopi", "stores", "goal-mode notes as facts", 0.8, "2026-10-04 08:00:00"],
      ["f3", "SQLite", "supports", "read-only mode", 0.9, "2026-10-03 08:00:00"],
    ],
    gists: [["g1", "A gist", "recent"]],
  });
  createFixtureBank(banksRoot, "empty-2", {});
  const previousOverride = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousOverride === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousOverride;
    rmSync(agentDir, { recursive: true, force: true });
  });
  return agentDir;
}

const banksJson = async () => {
  const res = await listBanks();
  assert.equal(res.status, 200);
  return res.json();
};

const query = async (bank, search = "") => {
  return getBank(new Request(`http://localhost/api/memory/banks/${bank}${search}`), {
    params: Promise.resolve({ bank }),
  });
};

test("banks route lists fixture banks with per-table counts", async (t) => {
  setupFixtureBanks(t);
  const { banks } = await banksJson();
  assert.deepEqual(banks.map((bank) => bank.name), ["alpha-1", "empty-2"]);
  assert.deepEqual(banks[0].counts, { working: 2, episodic: 1, facts: 3, gists: 1 });
  assert.ok(banks[0].mtimeMs > 0);
  assert.equal(banks[0].error, undefined);
  assert.deepEqual(banks[1].counts, { working: 0, episodic: 0, facts: 0, gists: 0 });
});

test("facts page is newest-first with whitelisted columns only", async (t) => {
  setupFixtureBanks(t);
  const res = await query("alpha-1", "?table=facts");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.total, 3);
  assert.deepEqual(data.items.map((item) => item.fact_id), ["f1", "f2", "f3"]);
  // The fixture facts table has no timestamp column; the reader must select
  // only the intersection of its whitelist and the live schema.
  assert.deepEqual(Object.keys(data.items[0]).sort(), ["confidence", "created_at", "fact_id", "object", "predicate", "subject"]);
});

test("substring search filters facts and working memory", async (t) => {
  setupFixtureBanks(t);
  const facts = await (await query("alpha-1", "?table=facts&q=goal")).json();
  assert.equal(facts.total, 2);
  assert.deepEqual(facts.items.map((item) => item.fact_id), ["f1", "f2"]);

  const working = await (await query("alpha-1", "?table=working&q=GOAL%20MODE")).json();
  assert.equal(working.total, 1, "LIKE search is case-insensitive");
  assert.equal(working.items[0].id, "w2");
  assert.equal(working.items[0].recall_count, 3);

  const none = await (await query("alpha-1", "?table=working&q=zzz-missing")).json();
  assert.equal(none.total, 0);
  assert.deepEqual(none.items, []);
});

test("episodic returns curated columns and facts pagination honors limit/offset", async (t) => {
  setupFixtureBanks(t);
  const episodic = await (await query("alpha-1", "?table=episodic")).json();
  assert.deepEqual(Object.keys(episodic.items[0]).sort(), ["content", "id", "importance", "source", "summary_of", "timestamp"]);
  const page1 = await (await query("alpha-1", "?table=facts&limit=2&offset=0")).json();
  const page2 = await (await query("alpha-1", "?table=facts&limit=2&offset=2")).json();
  assert.deepEqual(page1.items.map((item) => item.fact_id), ["f1", "f2"]);
  assert.deepEqual(page2.items.map((item) => item.fact_id), ["f3"]);
  assert.equal(page2.total, 3);
});

test("unknown bank answers 404, traversal payload never escapes the banks root", async (t) => {
  setupFixtureBanks(t);
  for (const name of ["missing-bank", "..", "../..", "..%2f..", "/etc/passwd"]) {
    const res = await query(encodeURIComponent(name), "?table=facts");
    assert.equal(res.status, 404, name);
    assert.equal((await res.json()).code, "unknown_bank");
  }
});

test("unknown table answers 400 with a stable code", async (t) => {
  setupFixtureBanks(t);
  const res = await query("alpha-1", "?table=working_memory");
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "unknown_table");
});

test("routes read through a concurrent writer without blocking it (read-only open)", async (t) => {
  const agentDir = setupFixtureBanks(t);
  // The live mnemopi backend keeps writing while the panel reads: a
  // read-only open must serve fresh rows and must not fight for write locks.
  const writer = new DatabaseSync(join(agentDir, "memories", "mnemopi", "banks", "alpha-1", "mnemopi.db"));
  const before = await (await query("alpha-1", "?table=facts")).json();
  writer.exec("INSERT INTO facts VALUES ('f9','X','y','z',0.1,'2026-10-06 08:00:00')");
  const after = await (await query("alpha-1", "?table=facts")).json();
  assert.equal(before.total, 3);
  assert.equal(after.total, 4);
  writer.close();
});
