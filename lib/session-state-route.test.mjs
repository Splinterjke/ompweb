import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// The state route is the UI's liveness probe. When an omp child crashes it is
// removed from the live registry but a retained exit record stays behind — the
// route must report that record (running:false + exited) instead of falling
// through to file-based mode, so the sidebar can surface the crash notice.

const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": new URL("../", import.meta.url).pathname,
  },
});
const { GET } = await jiti.import("../app/api/sessions/[id]/state/route.ts");

const getState = (id) => GET(
  new Request(`http://localhost/api/sessions/${id}/state`),
  { params: Promise.resolve({ id }) },
);

test("state reports a retained exit before the session file exists", async (t) => {
  const id = "exited-before-file";
  const previousExited = globalThis.__ompExitedSessions;
  const previousSessions = globalThis.__ompSessions;
  globalThis.__ompExitedSessions = new Map([[
    id,
    { id, cwd: "/tmp/project", at: 123, code: 1, signal: null, detail: "startup failed" },
  ]]);
  globalThis.__ompSessions = new Map();
  t.after(() => {
    globalThis.__ompExitedSessions = previousExited;
    globalThis.__ompSessions = previousSessions;
  });

  const response = await getState(id);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    running: false,
    exited: { id, cwd: "/tmp/project", at: 123, code: 1, signal: null, detail: "startup failed" },
  });
});
