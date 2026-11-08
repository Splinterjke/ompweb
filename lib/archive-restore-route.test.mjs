// Route-level coverage for archiving and restoring across linked hosts (port
// of upstream f8de44d9). Upstream keeps these in a consolidated
// lib/session-routes.test.mjs; this repo splits route suites, so the new
// archive/restore tests live here and the rest of upstream's suite stays out
// (it asserts context/sync contracts this fork does not have).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { Database } from "bun:sqlite";
import { LinkDriver, linkHost, linkLocalDaemon, listedSession } from "./hosts/link-driver.test-helper.mjs";

const archiveRoute = await import("../app/api/sessions/archive/route.ts");
const sessionArchiveRoute = await import("../app/api/sessions/[id]/archive/route.ts");
const { invalidateSessionListCache, listAllSessions } = await import("./session-reader.ts");
const { closeHostLink, getHost, linkTimings } = await import("./hosts/hub.ts");
const { HostOpError } = await import("./hosts/link-protocol.ts");
const { revokeHost } = await import("./hosts/registry.ts");
const { closeOutboxStore } = await import("./message-outbox.ts");

/** Write a minimal session transcript (header + entries) and return its path. */
function writeSessionFile(dir, name, header, entries = []) {
  const filePath = join(dir, name);
  const lines = [JSON.stringify({ type: "session", version: 3, ...header })];
  for (const entry of entries) lines.push(JSON.stringify(entry));
  writeFileSync(filePath, `${lines.join("\n")}\n`);
  return filePath;
}

/** Point the omp agent dir at a throwaway location for the duration of `run`;
 * this machine's daemon serves it from this process (`daemonOps` null: no daemon links). */
async function withAgentDir(run, daemonOps = {}) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-session-routes-"));
  const projectDir = join(agentDir, "sessions", "-project");
  mkdirSync(projectDir, { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // The global session-list cache (30s TTL), the path cache and main's per-host
  // lists could hold entries from another test's agent dir; clear them so
  // resolution sees only THIS dir's files.
  invalidateSessionListCache();
  globalThis.__ompHostLists = undefined;
  if (daemonOps) await linkLocalDaemon(daemonOps);
  try {
    await run(projectDir);
  } finally {
    closeHostLink("local");
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionListCache();
    closeOutboxStore();
    rmSync(agentDir, { recursive: true, force: true });
  }
}
test("archive restore rejects malformed hosts and unlisted key aliases without consuming a local archive", async () => {
  await withAgentDir(async (dir) => {
    const archived = join(dir, "..", "..", "archive", "sessions", "-project");
    mkdirSync(archived, { recursive: true });
    const file = join(archived, "kept.jsonl.gz");
    const bytes = gzipSync(Buffer.from(`${JSON.stringify({ type: "session", version: 3, id: "kept-archive", cwd: dir })}\n`));
    writeFileSync(file, bytes);
    const post = (body) => archiveRoute.POST(new Request("http://localhost/api/sessions/archive", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    for (const hostId of [42, false, [], null, "", "   "]) {
      const response = await post({ key: "-project/kept.jsonl.gz", hostId });
      assert.equal(response.status, 400, `hostId ${JSON.stringify(hostId)}`);
      assert.deepEqual(readFileSync(file), bytes);
    }
    for (const key of ["-project/./kept.jsonl.gz", "-project/missing.jsonl.gz"]) {
      assert.equal((await post({ key })).status, 404);
      assert.deepEqual(readFileSync(file), bytes);
    }
    assert.equal((await post({ key: "-project/kept.jsonl.gz", hostId: "unknown-host" })).status, 404);
    assert.deepEqual(readFileSync(file), bytes);
  });
});
test("local archive restore preserves the archive when another host has its session ID", async () => {
  await withAgentDir(async (dir) => {
    const id = "0a000000-0000-4000-8000-000000000043";
    const archived = join(dir, "..", "..", "archive", "sessions", "-project");
    mkdirSync(archived, { recursive: true });
    const file = join(archived, "kept.jsonl.gz");
    const bytes = gzipSync(Buffer.from(`${JSON.stringify({ type: "session", version: 3, id, cwd: dir })}\n`));
    writeFileSync(file, bytes);
    const remote = await linkHost("Active remote");
    try {
      remote.serve({ listSessions: () => [listedSession(id)] });
      const response = await archiveRoute.POST(new Request("http://localhost/api/sessions/archive", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "-project/kept.jsonl.gz", hostId: "local" }),
      }));
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, "session_host_conflict");
      assert.deepEqual(readFileSync(file), bytes);
      assert.deepEqual((await listAllSessions()).map((session) => session.id), []);
    } finally {
      closeHostLink(remote.id);
    }
  });
});
test("GET /api/sessions/archive lists every host's archives newest first, tagged by host, and names a host it cannot read", async () => {
  await withAgentDir(async (dir) => {
    const archived = join(dir, "..", "..", "archive", "sessions", "-project");
    mkdirSync(archived, { recursive: true });
    const lines = [
      { type: "session", version: 3, id: "0a000000-0000-4000-8000-000000000040", cwd: dir, timestamp: "2026-01-15T00:00:00.000Z" },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-01-15T00:00:01.000Z", message: { role: "user", content: "local archived" } },
    ];
    const localFile = join(archived, "2026-01-15_local.jsonl.gz");
    writeFileSync(localFile, gzipSync(Buffer.from(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`)));
    // A local archive's date is its file's mtime.
    utimesSync(localFile, new Date("2026-01-15T00:00:00.000Z"), new Date("2026-01-15T00:00:00.000Z"));
    const remoteArchive = (key, archivedAt) => ({ key, id: key, cwd: "/srv/app", created: "2026-01-01T00:00:00.000Z", archivedAt, messageCount: 1, firstMessage: "remote", size: 10, status: "complete" });
    const remote = await linkHost("Remote");
    const broken = await linkHost("Broken");
    try {
      remote.serve({ listArchives: () => [remoteArchive("-srv/old.jsonl.gz", "2026-01-10T00:00:00.000Z"), remoteArchive("-srv/new.jsonl.gz", "2026-02-01T00:00:00.000Z")] });
      broken.serve({ listArchives: () => { throw new HostOpError(501, "unknown_op", "Unknown host op: listArchives"); } });
      const res = await archiveRoute.GET();
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      const body = await res.json();
      assert.deepEqual(body.archives.map((archive) => [archive.hostId, archive.key]), [
        [remote.id, "-srv/new.jsonl.gz"],
        ["local", "-project/2026-01-15_local.jsonl.gz"],
        [remote.id, "-srv/old.jsonl.gz"],
      ]);
      assert.deepEqual(body.unavailableHosts, [{ id: broken.id, label: "Broken" }]);
    } finally {
      closeHostLink(remote.id);
      closeHostLink(broken.id);
    }
  });
});
test("a corrupt local archive is reported as unavailable without hiding healthy linked archives or proving local absence", async () => {
  await withAgentDir(async (dir) => {
    const archived = join(dir, "..", "..", "archive", "sessions", "-project");
    mkdirSync(archived, { recursive: true });
    const corrupt = join(archived, "corrupt.jsonl.gz");
    writeFileSync(corrupt, "not a gzip stream");
    const healthy = await linkHost("Healthy archive");
    const broken = await linkHost("Unreadable remote");
    const id = "0a000000-0000-4000-8000-000000000063";
    try {
      healthy.serve({ listArchives: () => [remoteArchive(id)] });
      broken.serve({ listArchives: () => { throw Object.assign(new Error("remote disk I/O failed"), { code: "EIO" }); } });
      const response = await archiveRoute.GET();
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.archives.map((entry) => [entry.hostId, entry.id]), [[healthy.id, id]]);
      assert.deepEqual(body.unavailableHosts, [
        { id: "local", label: getHost("local").label },
        { id: broken.id, label: "Unreadable remote" },
      ]);
      // Direct discovery used by the outbox still fails closed; the UI's per-host isolation never converts it to [].
      const { listArchivedSessionInfos } = await import("./omp/archive.ts");
      await assert.rejects(listArchivedSessionInfos());
      assert.equal(readFileSync(corrupt, "utf8"), "not a gzip stream");
    } finally {
      closeHostLink(healthy.id);
      closeHostLink(broken.id);
    }
  });
});
test("POST /api/sessions/archive with a remote hostId restores on that host and returns the host's refusal as is", async () => {
  await withAgentDir(async () => {
    const id = "0a000000-0000-4000-8000-000000000041";
    const keys = [];
    const remote = await linkHost("Remote");
    try {
      remote.serve({
        listSessions: () => [],
        listArchives: () => ["-srv/new.jsonl.gz", "-srv/taken.jsonl.gz"].map((key) => ({
          key, id, cwd: "/srv/app", created: "2026-01-01T00:00:00.000Z", archivedAt: "2026-01-02T00:00:00.000Z",
          messageCount: 1, firstMessage: "remote", size: 10, status: "complete",
        })),
        restoreReserve: () => ({ ok: true, value: { instance: "d-remote" } }),
        restoreArchive({ key }) {
          keys.push(key);
          return key === "-srv/taken.jsonl.gz"
            ? { ok: false, status: 409, code: "archive_restore_failed", error: "Active session destination already exists" }
            : { ok: true, value: { sessionId: id } };
        },
      });
      const post = (key) => archiveRoute.POST(new Request("http://localhost/api/sessions/archive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, hostId: remote.id }),
      }));
      const restored = await post("-srv/new.jsonl.gz");
      assert.equal(restored.status, 200);
      assert.deepEqual(await restored.json(), { ok: true, sessionId: id });
      const taken = await post("-srv/taken.jsonl.gz");
      assert.equal(taken.status, 409);
      assert.deepEqual(await taken.json(), { error: "Active session destination already exists", code: "archive_restore_failed" });
      assert.deepEqual(keys, ["-srv/new.jsonl.gz", "-srv/taken.jsonl.gz"]);
      assert.equal((await post("-srv/./new.jsonl.gz")).status, 404);
      assert.equal((await post("-srv/missing.jsonl.gz")).status, 404);
      assert.deepEqual(keys, ["-srv/new.jsonl.gz", "-srv/taken.jsonl.gz"]);
      assert.deepEqual(restoreClaims(), [], "an answer, even a refusal, ends the claim");
    } finally {
      closeHostLink(remote.id);
    }
  });
});
test("remote archive restore rejects a session ID active on another host before consuming the archive", async () => {
  await withAgentDir(async (dir) => {
    const id = "0a000000-0000-4000-8000-000000000044";
    writeSessionFile(dir, "active.jsonl", { id, cwd: dir, timestamp: "2026-01-01T00:00:00.000Z" });
    const archives = [{
      key: "-srv/kept.jsonl.gz", id, cwd: "/srv/app", created: "2026-01-01T00:00:00.000Z",
      archivedAt: "2026-01-02T00:00:00.000Z", messageCount: 1, firstMessage: "remote", size: 10, status: "complete",
    }];
    let restores = 0;
    const remote = await linkHost("Archived remote");
    try {
      remote.serve({
        listSessions: () => [],
        listArchives: () => archives,
        restoreArchive() {
          restores++;
          archives.splice(0);
          return { ok: true, value: { sessionId: id } };
        },
      });
      const response = await archiveRoute.POST(new Request("http://localhost/api/sessions/archive", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: archives[0].key, hostId: remote.id }),
      }));
      assert.equal(response.status, 409);
      const body = await response.json();
      assert.equal(body.code, "session_host_conflict");
      assert.match(body.error, /another host/i);
      assert.equal(restores, 0);
      assert.equal(archives.length, 1);
    } finally {
      closeHostLink(remote.id);
    }
  });
});
test("local same-ID session at a different path blocks restore despite a warm empty daemon cache", async () => {
  await withAgentDir(async (dir) => {
    const id = "0a000000-0000-4000-8000-000000000048";
    assert.deepEqual(await getHost("local").sessionOps.listSessions(), []);
    writeSessionFile(dir, "different-active.jsonl", { id, cwd: dir, timestamp: "2026-01-01T00:00:00.000Z" });
    const archiveDir = join(dir, "..", "..", "archive", "sessions", "-project");
    mkdirSync(archiveDir, { recursive: true });
    const file = join(archiveDir, "kept.jsonl.gz");
    const bytes = gzipSync(Buffer.from(`${JSON.stringify({ type: "session", version: 3, id, cwd: dir })}\n`));
    writeFileSync(file, bytes);
    const response = await restoreRequest("-project/kept.jsonl.gz");
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "archive_restore_failed");
    assert.deepEqual(readFileSync(file), bytes);
    assert.equal(existsSync(join(dir, "kept.jsonl")), false);
  });
});
test("link loss during fresh conflict discovery preserves the remote archive", async () => {
  await withAgentDir(async () => {
    const id = "0a000000-0000-4000-8000-000000000049";
    const remote = await linkHost("Drops during listing");
    let restores = 0;
    try {
      remote.serve({ listArchives: () => [remoteArchive(id)],
        listSessions: () => { closeHostLink(remote.id); return []; },
        restoreArchive: () => { restores++; } });
      const response = await restoreRequest(remoteArchive(id).key, remote.id);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, "host_offline");
      assert.equal(restores, 0);
    } finally { closeHostLink(remote.id); }
  });
});

function restoreRequest(key, hostId = "local") {
  return archiveRoute.POST(new Request("http://localhost/api/sessions/archive", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, hostId }),
  }));
}

function remoteArchive(id) {
  return { key: "-srv/kept.jsonl.gz", id, cwd: "/srv/app", created: "2026-01-01T00:00:00.000Z",
    archivedAt: "2026-01-02T00:00:00.000Z", messageCount: 1, firstMessage: "", size: 10, status: "complete" };
}
test("capture A and replacement B have distinct restore targets: capture is refused and only B's ID is claimed", async () => {
  await withAgentDir(async () => {
    const a = "0a000000-0000-4000-8000-000000000061";
    const b = "0a000000-0000-4000-8000-000000000062";
    const original = remoteArchive(b);
    const capture = { ...remoteArchive(a), key: `${original.key}.11111111-2222-4333-8444-555555555555.restore-consume`, restorePending: true };
    const remote = await linkHost("Captured and replaced");
    const restoredKeys = [];
    try {
      remote.serve({
        listArchives: () => [capture, original],
        listSessions: () => [],
        restoreReserve: () => ({ ok: true, value: { instance: "d1" } }),
        restoreArchive: ({ key }) => {
          restoredKeys.push(key);
          const claims = restoreClaims();
          assert.deepEqual(claims.map((claim) => claim.session_id), [b]);
          return { ok: true, value: { sessionId: b } };
        },
      });
      const blocked = await restoreRequest(capture.key, remote.id);
      assert.deepEqual([blocked.status, (await blocked.json()).code], [409, "archive_restore_unconfirmed"]);
      assert.deepEqual(restoredKeys, []);
      const response = await restoreRequest(original.key, remote.id);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).sessionId, b);
      assert.deepEqual(restoredKeys, [original.key]);
    } finally { closeHostLink(remote.id); }
  });
});

/** The restore claims on disk as `{ session_id, host_id }` (`host_id` set: held for a remote restore); with `idleMs`, first
 * ages every claim to that long without renewal, as if its request had died. */
function restoreClaims(idleMs) {
  const db = new Database(join(process.env.PI_CODING_AGENT_DIR, "omp-web", "archive-restore-locks.sqlite"));
  try {
    if (idleMs !== undefined) db.prepare("UPDATE restore_claims SET renewed_at = ?").run(Date.now() - idleMs);
    return db.prepare("SELECT session_id, host_id FROM restore_claims").all().map((row) => ({ ...row }));
  } finally { db.close(true); }
}
test("restore checks raw same-host and later-host duplicate IDs without consuming either archive", async () => {
  await withAgentDir(async () => {
    const id = "0a000000-0000-4000-8000-000000000045";
    const selected = await linkHost("Selected");
    const later = await linkHost("Later");
    let restores = 0;
    let foreign = false;
    try {
      selected.serve({ listArchives: () => [remoteArchive(id)],
        listSessions: () => [{ ...listedSession(id), path: "/different/active.jsonl" }],
        restoreArchive: () => { restores++; return { ok: true, value: { sessionId: id } }; } });
      later.serve({ listSessions: () => foreign ? [listedSession(id)] : [] });
      const same = await restoreRequest(remoteArchive(id).key, selected.id);
      assert.equal(same.status, 409);
      assert.equal((await same.json()).code, "archive_restore_failed");
      foreign = true;
      const both = await restoreRequest(remoteArchive(id).key, selected.id);
      assert.equal(both.status, 409);
      assert.equal((await both.json()).code, "session_host_conflict");
      assert.equal(restores, 0);
    } finally {
      closeHostLink(selected.id);
      closeHostLink(later.id);
    }
  });
});
test("restore fails closed for an uncached offline host or a rejected linked listing", async () => {
  for (const offline of [true, false]) {
    await withAgentDir(async (dir) => {
      const id = "0a000000-0000-4000-8000-000000000046";
      const archiveDir = join(dir, "..", "..", "archive", "sessions", "-project");
      mkdirSync(archiveDir, { recursive: true });
      const file = join(archiveDir, "kept.jsonl.gz");
      const bytes = gzipSync(Buffer.from(`${JSON.stringify({ type: "session", version: 3, id, cwd: dir })}\n`));
      writeFileSync(file, bytes);
      const broken = await linkHost("Unavailable");
      const selected = await linkHost("Selected");
      let restores = 0;
      try {
        selected.serve({ listArchives: () => [remoteArchive(id)], listSessions: () => [],
          restoreArchive: () => { restores++; return { ok: true, value: { sessionId: id } }; } });
        if (offline) closeHostLink(broken.id);
        else broken.serve({ listSessions: () => { throw new Error("listing failed"); } });
        for (const [key, hostId] of [["-project/kept.jsonl.gz", "local"], [remoteArchive(id).key, selected.id]]) {
          const response = await restoreRequest(key, hostId);
          assert.equal(response.status, 503);
          const body = await response.json();
          assert.equal(body.code, offline ? "host_offline" : "host_sessions_unavailable");
          // Even a local restore names the offline host that blocks it.
          if (offline) assert.deepEqual([body.host, body.hostOffline], ["Unavailable", true]);
          assert.deepEqual(readFileSync(file), bytes);
          assert.equal(restores, 0);
        }
      } finally {
        closeHostLink(broken.id);
        closeHostLink(selected.id);
      }
    });
  }
});
test("concurrent same-ID restores on different hosts cannot both consume archives", async () => {
  await withAgentDir(async () => {
    const id = "0a000000-0000-4000-8000-000000000047";
    const first = await linkHost("First");
    const second = await linkHost("Second");
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const consumed = [];
    try {
      for (const remote of [first, second]) remote.serve({
        listArchives: () => [remoteArchive(id)], listSessions: () => [],
        restoreReserve: () => ({ ok: true, value: { instance: `d-${remote.id}` } }),
        restoreArchive: async () => {
          entered();
          await gate;
          consumed.push(remote.id);
          return { ok: true, value: { sessionId: id } };
        },
      });
      const winner = restoreRequest(remoteArchive(id).key, first.id);
      await started;
      try {
        const loser = await restoreRequest(remoteArchive(id).key, second.id);
        assert.equal(loser.status, 409);
        assert.equal((await loser.json()).code, "archive_restore_busy");
      } finally { release(); }
      assert.equal((await winner).status, 200);
      assert.deepEqual(consumed, [first.id]);
    } finally {
      release();
      closeHostLink(first.id);
      closeHostLink(second.id);
    }
  });
});

/** The daemon end of restore admission as `sessionOps` keeps it: a restore starts only under a claim that was reserved and
 * not fenced since. `state.published`: whether this host lists the session. */
function admissionOps(id, state) {
  return {
    listArchives: () => [remoteArchive(id)],
    listSessions: () => (state.published ? [listedSession(id)] : []),
    restoreReserve: ({ claim }) => { state.reserved.add(claim); return { ok: true, value: { instance: state.instance } }; },
    restoreFence: ({ claim }) => { state.reserved.delete(claim); return { ok: true, value: { instance: state.instance, running: state.running.has(claim) } }; },
  };
}

/** A restore request reaching the daemon: whether it started (nothing answers it, as when main stopped waiting). */
function deliverRestore(state, claim) {
  if (!state.reserved.delete(claim)) return false;
  state.running.add(claim);
  return true;
}

/** One daemon process's restore state: its `instance`, the tokens reserved and not spent or fenced, those running. */
const daemonState = (instance) => ({ instance, reserved: new Set(), running: new Set(), published: false });
test("a restore request a suspended sender delivers late is refused once another request fenced its claim, so only one host publishes", async () => {
  await withAgentDir(async () => {
    const id = "0a000000-0000-4000-8000-000000000053";
    const key = remoteArchive(id).key;
    const first = await linkHost("Suspended sender's host");
    const second = await linkHost("Other host");
    const daemon = daemonState("d1");
    // The sender held its claim and reserved here, then was suspended: its restore request reaches the daemon only later.
    const delayed = [];
    let secondRestores = 0;
    try {
      void first.serve(admissionOps(id, daemon), (message) => {
        if (message.type === "req" && message.op === "restoreArchive") delayed.push(message.args.claim);
      });
      second.serve({
        listArchives: () => [remoteArchive(id)], listSessions: () => [],
        restoreReserve: () => ({ ok: true, value: { instance: "d-second" } }),
        restoreArchive: () => { secondRestores++; return { ok: true, value: { sessionId: id } }; },
      });
      const timeout = linkTimings.opTimeoutMs;
      linkTimings.opTimeoutMs = 250;
      try { assert.equal((await restoreRequest(key, first.id)).status, 504); } finally { linkTimings.opTimeoutMs = timeout; }
      assert.equal(delayed.length, 1);
      assert.equal(daemon.running.size, 0, "the daemon has not seen the restore yet");
      // The claim is stale and the daemon says nothing runs, but only because its fence now revokes the claim: another host restores.
      restoreClaims(3_600_000);
      assert.equal((await restoreRequest(key, second.id)).status, 200);
      assert.equal(secondRestores, 1);
      // The suspended sender wakes and its request arrives: refused, so the session exists once.
      assert.equal(deliverRestore(daemon, delayed[0]), false);
      assert.equal(daemon.running.size, 0);
      assert.deepEqual(restoreClaims(), []);
    } finally {
      closeHostLink(first.id);
      closeHostLink(second.id);
    }
  });
});
test("a held restore on a daemon that cannot fence stays blocked", async () => {
  await withAgentDir(async () => {
    const id = "0a000000-0000-4000-8000-000000000052";
    const key = remoteArchive(id).key;
    const first = await linkHost("Daemon without restoreFence");
    const second = await linkHost("Other host");
    let secondRestores = 0;
    try {
      void first.serve({
        listArchives: () => [remoteArchive(id)], listSessions: () => [],
        restoreReserve: () => ({ ok: true, value: { instance: "d1" } }),
        restoreFence: () => { throw new HostOpError(501, "unknown_op", "Unknown host op: restoreFence"); },
      });
      second.serve({
        listArchives: () => [remoteArchive(id)], listSessions: () => [],
        restoreArchive: () => { secondRestores++; return { ok: true, value: { sessionId: id } }; },
      });
      const timeout = linkTimings.opTimeoutMs;
      linkTimings.opTimeoutMs = 250;
      try { assert.equal((await restoreRequest(key, first.id)).status, 504); } finally { linkTimings.opTimeoutMs = timeout; }
      restoreClaims(3_600_000);
      const refused = await restoreRequest(key, second.id);
      const body = await refused.json();
      assert.deepEqual([refused.status, body.code], [409, "archive_restore_unconfirmed"]);
      assert.match(body.error, /Unknown host op: restoreFence/);
      assert.equal(secondRestores, 0);
      assert.deepEqual(restoreClaims().map((claim) => claim.host_id), [first.id]);
    } finally {
      closeHostLink(first.id);
      closeHostLink(second.id);
    }
  });
});
test("a restore is never sent to a daemon that cannot reserve it, and leaves no claim behind", async () => {
  await withAgentDir(async () => {
    const id = "0a000000-0000-4000-8000-000000000055";
    const bare = await linkHost("Daemon without restoreReserve");
    let restores = 0;
    try {
      void bare.serve({
        listArchives: () => [remoteArchive(id)], listSessions: () => [],
        restoreReserve: () => { throw new HostOpError(501, "unknown_op", "Unknown host op: restoreReserve"); },
        restoreArchive: () => { restores++; return { ok: true, value: { sessionId: id } }; },
      });
      const response = await restoreRequest(remoteArchive(id).key, bare.id);
      assert.deepEqual([response.status, (await response.json()).code], [501, "unknown_op"]);
      assert.equal(restores, 0);
      assert.deepEqual(restoreClaims(), []);
    } finally {
      closeHostLink(bare.id);
    }
  });
});
test("a held restore whose host was unregistered stays blocked: unregistering does not stop its daemon", async () => {
  await withAgentDir(async () => {
    const id = "0a000000-0000-4000-8000-000000000054";
    const key = remoteArchive(id).key;
    const first = await linkHost("Soon unregistered");
    const second = await linkHost("Other host");
    const daemon = daemonState("d1");
    let secondRestores = 0;
    try {
      void first.serve(admissionOps(id, daemon), (message) => {
        if (message.type === "req" && message.op === "restoreArchive") deliverRestore(daemon, message.args.claim);
      });
      second.serve({
        listArchives: () => [remoteArchive(id)], listSessions: () => [],
        restoreReserve: () => ({ ok: true, value: { instance: "d-second" } }),
        restoreArchive: () => { secondRestores++; return { ok: true, value: { sessionId: id } }; },
      });
      const timeout = linkTimings.opTimeoutMs;
      linkTimings.opTimeoutMs = 250;
      try { assert.equal((await restoreRequest(key, first.id)).status, 504); } finally { linkTimings.opTimeoutMs = timeout; }
      revokeHost(first.id);
      restoreClaims(3_600_000);
      const refused = await restoreRequest(key, second.id);
      const body = await refused.json();
      assert.deepEqual([refused.status, body.code], [409, "archive_restore_unconfirmed"]);
      assert.match(body.error, /no longer registered/);
      assert.equal(secondRestores, 0);
      assert.deepEqual(restoreClaims().map((claim) => claim.host_id), [first.id]);
    } finally {
      closeHostLink(first.id);
      closeHostLink(second.id);
    }
  });
});
test("a restore whose daemon was replaced stays blocked: the replacement cannot fence the original, which may still publish; the original itself can", async () => {
  await withAgentDir(async () => {
    const id = "0a000000-0000-4000-8000-000000000056";
    const key = remoteArchive(id).key;
    const first = await linkHost("Replaced daemon");
    const second = await linkHost("Other host");
    // d1 took the restore and keeps running it: it is shared with another server, so losing this server's link ends nothing.
    const d1 = daemonState("d1");
    let secondRestores = 0;
    try {
      void first.serve(admissionOps(id, d1), (message) => {
        if (message.type === "req" && message.op === "restoreArchive") deliverRestore(d1, message.args.claim);
      });
      second.serve({
        listArchives: () => [remoteArchive(id)], listSessions: () => [],
        restoreReserve: () => ({ ok: true, value: { instance: "d-second" } }),
        restoreArchive: () => { secondRestores++; return { ok: true, value: { sessionId: id } }; },
      });
      const timeout = linkTimings.opTimeoutMs;
      linkTimings.opTimeoutMs = 250;
      try { assert.equal((await restoreRequest(key, first.id)).status, 504); } finally { linkTimings.opTimeoutMs = timeout; }
      assert.equal(d1.running.size, 1, "d1 has the restore");

      // d2, another process with this host's id and token, takes the link over. It reserved nothing, so its fence reports
      // nothing running: true of d2, and no proof about d1.
      const d2 = daemonState("d2");
      const replacement = new LinkDriver(first.id, first.token);
      await replacement.dial();
      void replacement.serve(admissionOps(id, d2));
      restoreClaims(3_600_000);
      for (const afterPublish of [false, true]) {
        const refused = await restoreRequest(key, second.id);
        const body = await refused.json();
        assert.deepEqual([refused.status, body.code], [409, "archive_restore_unconfirmed"]);
        assert.match(body.error, /replaced or restarted/);
        assert.equal(secondRestores, 0, "the other host's archive was never consumed");
        assert.deepEqual(restoreClaims().map((claim) => claim.host_id), [first.id]);
        // d1 finishes and publishes between the attempts: still blocked, and no duplicate follows.
        if (!afterPublish) Object.assign(d1, { published: true, running: new Set() });
      }

      // The original daemon is the one linked again (a fresh driver: its sequence numbers start over, as a redial that
      // acks nothing): its own fence is authoritative, and the published session is a conflict.
      const survivor = new LinkDriver(first.id, first.token);
      await survivor.dial();
      void survivor.serve(admissionOps(id, d1), () => {});
      const conflict = await restoreRequest(key, second.id);
      assert.deepEqual([conflict.status, (await conflict.json()).code], [409, "session_host_conflict"]);
      assert.equal(secondRestores, 0);
      assert.deepEqual(restoreClaims(), []);
    } finally {
      closeHostLink(first.id);
      closeHostLink(second.id);
    }
  });
});
test("a restore refused as not admitted keeps its claim: only the daemon that reserved the token can say it was never spent", async () => {
  await withAgentDir(async () => {
    const id = "0a000000-0000-4000-8000-000000000057";
    const key = remoteArchive(id).key;
    const first = await linkHost("Resent to a replacement");
    const second = await linkHost("Other host");
    // d1 reserved the token. The request was answered by the daemon linked now, d2, which never saw it: a refusal that proves
    // nothing about d1, which may be running a restore it was sent before the replacement.
    let fence = { instance: "d2", running: false };
    let secondRestores = 0;
    try {
      void first.serve({
        listArchives: () => [remoteArchive(id)], listSessions: () => [],
        restoreReserve: () => ({ ok: true, value: { instance: "d1" } }),
        restoreArchive: () => ({ ok: false, status: 409, code: "archive_restore_not_admitted", error: "This restore was not admitted or was fenced; the archive was not consumed" }),
        restoreFence: () => ({ ok: true, value: fence }),
      });
      second.serve({
        listArchives: () => [remoteArchive(id)], listSessions: () => [],
        restoreReserve: () => ({ ok: true, value: { instance: "d-second" } }),
        restoreArchive: () => { secondRestores++; return { ok: true, value: { sessionId: id } }; },
      });
      const refused = await restoreRequest(key, first.id);
      const body = await refused.json();
      assert.deepEqual([refused.status, body.code], [409, "archive_restore_unconfirmed"]);
      assert.match(body.error, /did not run this restore/);
      assert.deepEqual(restoreClaims().map((claim) => claim.host_id), [first.id], "a refusal to admit never releases the claim");

      // The fence is answered by d2: it cannot clear d1's claim, however long it has been idle.
      restoreClaims(3_600_000);
      const blocked = await restoreRequest(key, second.id);
      assert.deepEqual([blocked.status, (await blocked.json()).code], [409, "archive_restore_unconfirmed"]);
      assert.equal(secondRestores, 0);
      assert.deepEqual(restoreClaims().map((claim) => claim.host_id), [first.id]);

      // d1 itself answers the fence, with nothing running and its token revoked: now the claim may be taken over.
      fence = { instance: "d1", running: false };
      const taken = await restoreRequest(key, second.id);
      assert.equal(taken.status, 200);
      assert.equal(secondRestores, 1);
      assert.deepEqual(restoreClaims(), []);
    } finally {
      closeHostLink(first.id);
      closeHostLink(second.id);
    }
  });
});
test("a held claim written without the daemon process that took it is never taken over, and its host is not asked", async () => {
  await withAgentDir(async (dir) => {
    const id = "0a000000-0000-4000-8000-000000000058";
    const key = remoteArchive(id).key;
    const first = await linkHost("Earlier build's host");
    const second = await linkHost("Other host");
    let fences = 0;
    let secondRestores = 0;
    try {
      void first.serve({
        listArchives: () => [remoteArchive(id)], listSessions: () => [],
        restoreReserve: () => ({ ok: true, value: { instance: "d1" } }),
        restoreFence: () => { fences++; return { ok: true, value: { instance: "d1", running: false } }; },
      });
      second.serve({
        listArchives: () => [remoteArchive(id)], listSessions: () => [],
        restoreReserve: () => ({ ok: true, value: { instance: "d-second" } }),
        restoreArchive: () => { secondRestores++; return { ok: true, value: { sessionId: id } }; },
      });
      const timeout = linkTimings.opTimeoutMs;
      linkTimings.opTimeoutMs = 250;
      try { assert.equal((await restoreRequest(key, first.id)).status, 504); } finally { linkTimings.opTimeoutMs = timeout; }
      // The row as a build that recorded no process leaves it.
      const db = new Database(join(dir, "..", "..", "omp-web", "archive-restore-locks.sqlite"));
      try { db.prepare("UPDATE restore_claims SET instance = NULL").run(); } finally { db.close(true); }
      restoreClaims(3_600_000);
      const refused = await restoreRequest(key, second.id);
      const body = await refused.json();
      assert.deepEqual([refused.status, body.code], [409, "archive_restore_unconfirmed"]);
      assert.match(body.error, /without the daemon process/);
      assert.equal(fences, 0, "no answer could be matched to the claim, so none is asked for");
      assert.equal(secondRestores, 0);
      assert.deepEqual(restoreClaims().map((claim) => claim.host_id), [first.id]);
    } finally {
      closeHostLink(first.id);
      closeHostLink(second.id);
    }
  });
});
test("restore rejects invalid archive session IDs before invoking restore", async () => {
  await withAgentDir(async () => {
    const remote = await linkHost("Invalid archive");
    let restores = 0;
    try {
      remote.serve({ listArchives: () => [remoteArchive("../invalid")],
        restoreArchive: () => { restores++; } });
      const response = await restoreRequest(remoteArchive("../invalid").key, remote.id);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "archive_session_invalid");
      assert.equal(restores, 0);
    } finally { closeHostLink(remote.id); }
  });
});
test("archive restore retains an old daemon's unavailable response without invoking restore", async () => {
  await withAgentDir(async () => {
    let restores = 0;
    const remote = await linkHost("Old daemon");
    try {
      remote.serve({
        listArchives() { throw new HostOpError(501, "unknown_op", "Unknown host op: listArchives"); },
        restoreArchive() { restores++; },
      });
      const response = await archiveRoute.POST(new Request("http://localhost/api/sessions/archive", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "-srv/kept.jsonl.gz", hostId: remote.id }),
      }));
      assert.equal(response.status, 501);
      assert.equal((await response.json()).code, "unknown_op");
      assert.equal(restores, 0);
    } finally {
      closeHostLink(remote.id);
    }
  });
});
test("a remote session archives on its own host: POST /api/sessions/[id]/archive no longer answers 501", async () => {
  await withAgentDir(async () => {
    const id = "0a000000-0000-4000-8000-000000000042";
    const archivedIds = [];
    const remote = await linkHost("Remote");
    try {
      remote.serve({
        listSessions: () => [listedSession(id, "/srv/app")],
        archiveSession({ id: sessionId }) {
          archivedIds.push(sessionId);
          return { ok: true, value: { archivedPath: `/srv/archive/${sessionId}.jsonl.gz` } };
        },
      });
      const res = await sessionArchiveRoute.POST(new Request(`http://localhost/api/sessions/${id}/archive`, { method: "POST" }), { params: Promise.resolve({ id }) });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, archived: true, archivedPath: `/srv/archive/${id}.jsonl.gz` });
      assert.deepEqual(archivedIds, [id]);
    } finally {
      closeHostLink(remote.id);
    }
  });
});
