import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// Real POST /api/sessions/[id]/auto-name with a live wrapper faked through the
// process-wide registry. A run in flight must answer 409 session_busy instead
// of the stored/derived fallback (the reported bug: renaming an active session
// "succeeded" with its unchanged title plus the misleading "generator
// returned nothing" toast — the wrapper cannot run `/rename`, a prompt,
// beside a turn).
const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});
const autoNameRoute = await jiti.import("../app/api/sessions/[id]/auto-name/route.ts");

const SID = "autoname-route-session";
const agentDir = mkdtempSync(join(tmpdir(), "omp-web-auto-name-route-"));
const projectDir = join(agentDir, "sessions", "-project");
mkdirSync(projectDir, { recursive: true });
writeFileSync(
  join(projectDir, "2026-01-01_chat.jsonl"),
  `${[
    { type: "session", version: 3, id: SID, cwd: tmpdir(), timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hello world" } },
  ].map((line) => JSON.stringify(line)).join("\n")}\n`,
);

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

/** Replace the process-wide wrapper registry for one test. */
function useRegistry(t, wrappers) {
  const previousSessions = globalThis.__ompSessions;
  globalThis.__ompSessions = new Map(Object.entries(wrappers));
  t.after(() => {
    globalThis.__ompSessions = previousSessions;
  });
}

const post = (id) => autoNameRoute.POST(
  new Request(`http://localhost/api/sessions/${id}/auto-name`, { method: "POST" }),
  { params: Promise.resolve({ id }) },
);

test("auto-name reports session_busy while a run is in flight", async (t) => {
  useRegistry(t, {
    [SID]: {
      isAlive: () => true,
      isRunning: () => true,
      generateTitle: async () => null,
      send: async () => { throw new Error("no fallback may be saved mid-run"); },
    },
  });
  const response = await post(SID);
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "session_busy");
});

test("an idle session with no generated title keeps its derived display title", async (t) => {
  const sent = [];
  useRegistry(t, {
    [SID]: {
      isAlive: () => true,
      isRunning: () => false,
      generateTitle: async () => null,
      send: async (command) => { sent.push(command); },
    },
  });
  const response = await post(SID);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.generated, false, "omp generated nothing, so the title is the fallback");
  // The scan already titles an untitled session with its first message, so
  // the fallback is that title and nothing is rewritten on disk.
  assert.equal(body.title, "hello world");
  assert.deepEqual(sent, [], "an already-correct display title must not be rewritten");
});
