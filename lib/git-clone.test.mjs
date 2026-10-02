import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Pure helpers (URL validation, progress log) plus the clone route itself:
// the route's spawn env and abort wiring are exercised end-to-end with a fake
// `git` executable placed on PATH, so no network or real repository is needed.
const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": new URL("../", import.meta.url).pathname,
  },
});
const { appendProgress, cloneDirectoryName } = await jiti.import("./git-clone.ts");
const { POST, DELETE } = await jiti.import("../app/api/projects/clone/route.ts");

test("cloneDirectoryName derives git's directory name from https and ssh URLs", () => {
  assert.equal(cloneDirectoryName("https://github.com/kahme247/ompweb.git"), "ompweb");
  assert.equal(cloneDirectoryName("https://user:token@gitlab.example.com/group/sub/repo/"), "repo");
  assert.equal(cloneDirectoryName("git@github.com:kahme247/ompweb.git"), "ompweb");
  assert.equal(cloneDirectoryName("gh:owner/repo"), "repo");
  assert.equal(cloneDirectoryName("ssh://git@host:2222/srv/repo.git"), "repo");
  assert.equal(cloneDirectoryName("  git@host:repo  "), "repo");
  assert.equal(cloneDirectoryName("git@host:/srv/git/repo.git"), "repo");
  assert.equal(cloneDirectoryName("https://h/o/r.git?x=1#f"), "r");
});

test("cloneDirectoryName rejects non-https/ssh transports and unsafe names", () => {
  for (const url of [
    "",
    "http://github.com/o/r.git",
    "file:///tmp/repo",
    "ext::sh$IFS-c$IFS'touch$IFS/x'/x",
    "--upload-pack=touch /tmp/pwned",
    "/tmp/repo",
    "C:\\repos\\repo",
    "C:/repos/repo",
    "https://h/o/..\\..\\evil",
    "https://h/o/a$b",
    "https://github.com/o/r extra",
    "https://github.com/o/..",
    "https://github.com/",
  ]) {
    assert.equal(cloneDirectoryName(url), null, url);
  }
});

test("appendProgress applies carriage returns across chunks", () => {
  let log = appendProgress("", "Cloning into 'repo'...\n");
  log = appendProgress(log, "Receiving objects:  10% (1/10)\r");
  log = appendProgress(log, "Receiving objects:  50% (5/10)\r");
  assert.equal(log, "Cloning into 'repo'...\nReceiving objects:  50% (5/10)\r");
  log = appendProgress(log, "Receiving objects: 100% (10/10), done.\nResolving deltas: 100%\n");
  assert.equal(log, "Cloning into 'repo'...\nReceiving objects: 100% (10/10), done.\nResolving deltas: 100%\n");
});

test("appendProgress keeps only the latest 200 lines", () => {
  const log = appendProgress("", Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n"));
  const lines = log.split("\n");
  assert.equal(lines.length, 200);
  assert.equal(lines[0], "line 50");
});

// ---------------------------------------------------------------------------
// Route behavior: askpass blocking, cancellation, and pre-spawn aborts.
// A fake `git` executable on PATH records the env it received and sleeps,
// standing in for a long remote clone.
// ---------------------------------------------------------------------------

const CLONE_URL = "https://github.com/example/repo.git";
const CLONE_ID = "clone-test-1";

/** Spawns the route's clone request against a fake git and returns handles. */
async function startClone(t, { sleepSec = 60, exitCode = 0, trapTerm = false, preAbort = false }) {
  const binDir = mkdtempSync(join(tmpdir(), "omp-clone-fakegit-"));
  const envFile = join(binDir, "git-env.txt");
  const killFile = join(binDir, "killed.txt");
  const askpassFile = join(binDir, "askpass.txt");
  const workDir = mkdtempSync(join(tmpdir(), "omp-clone-work-"));
  const agentDir = mkdtempSync(join(tmpdir(), "omp-clone-agent-"));
  const target = join(workDir, "repo");

  // An inherited askpass helper that would prompt (and hang) if git used it.
  const askpass = join(binDir, "fake-askpass.sh");
  writeFileSync(askpass, `#!/bin/sh\necho PROMPTED > ${askpassFile}\nsleep 20\n`, { mode: 0o755 });

  const lines = [
    "#!/bin/sh",
    // Only the clone call dumps its env; `resolveProject` also runs git
    // (`rev-parse`) against the target and must not clobber the dump.
    'if [ "$1" = "clone" ]; then',
    `{
echo "GIT_TERMINAL_PROMPT=$GIT_TERMINAL_PROMPT"
echo "GIT_ASKPASS=$GIT_ASKPASS"
echo "SSH_ASKPASS=$SSH_ASKPASS"
echo "GIT_ALLOW_PROTOCOL=$GIT_ALLOW_PROTOCOL"
} > ${envFile}`,
  ];
  if (trapTerm) lines.push(`trap 'echo KILLED > ${killFile}' TERM`);
  lines.push(`sleep ${sleepSec}`);
  lines.push(`exit ${exitCode}`);
  lines.push("else");
  lines.push("exit 1");
  lines.push("fi");
  const gitPath = join(binDir, "git");
  writeFileSync(gitPath, lines.join("\n"), { mode: 0o755 });

  const previous = {
    PATH: process.env.PATH,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    GIT_ASKPASS: process.env.GIT_ASKPASS,
    SSH_ASKPASS: process.env.SSH_ASKPASS,
  };
  process.env.PATH = `${binDir}:${previous.PATH}`;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.GIT_ASKPASS = askpass;
  process.env.SSH_ASKPASS = askpass;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  const controller = new AbortController();
  if (preAbort) controller.abort();
  const req = new Request("http://localhost/api/projects/clone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: CLONE_ID, parent: workDir, url: CLONE_URL }),
    signal: controller.signal,
  });
  const response = await POST(req);
  return {
    response,
    controller,
    envFile,
    killFile,
    askpassFile,
    target,
    agentDir,
    workDir,
  };
}

async function collectFrames(response, timeoutMs = 15_000) {
  const frames = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const readAll = async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) if (line) frames.push(JSON.parse(line));
    }
    return frames;
  };
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`stream did not end in time; frames: ${JSON.stringify(frames)}`)), timeoutMs),
  );
  try {
    return await Promise.race([readAll(), timer]);
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

async function waitForFile(file, timeoutMs = 5000) {
  const start = Date.now();
  while (!existsSync(file)) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

test("successful clone blocks askpass prompts and registers the project", async (t) => {
  const { response, envFile, askpassFile, target, agentDir } = await startClone(t, { sleepSec: 0.3, exitCode: 0 });
  assert.equal(response.status, 200);

  const frames = await collectFrames(response);
  const last = frames[frames.length - 1];
  assert.equal(last.type, "done");
  assert.equal(last.path, target);

  // The env the route handed to git: terminal prompts off, inherited
  // GIT_ASKPASS/SSH_ASKPASS disabled (empty values), https/ssh only.
  const envDump = readFileSync(envFile, "utf8");
  assert.ok(envDump.includes("GIT_TERMINAL_PROMPT=0\n"), envDump);
  assert.ok(envDump.includes("GIT_ASKPASS=\n"), envDump);
  assert.ok(envDump.includes("SSH_ASKPASS=\n"), envDump);
  assert.ok(envDump.includes("GIT_ALLOW_PROTOCOL=https:ssh\n"), envDump);
  assert.ok(!existsSync(askpassFile), "the inherited askpass helper must never be invoked");

  // The clone is registered through the project registry like POST /api/projects.
  const registry = JSON.parse(readFileSync(join(agentDir, "projects.json"), "utf8"));
  const entry = registry.projects.find((p) => p.path === target);
  assert.ok(entry, "cloned directory must be registered as a project");
});

test("DELETE cancels an in-flight clone, kills git, and removes the target", async (t) => {
  const { response, envFile, killFile, target } = await startClone(t, { sleepSec: 60, trapTerm: true });
  assert.ok(await waitForFile(envFile), "fake git should have been spawned");

  const del = await DELETE(new Request("http://localhost/api/projects/clone", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: CLONE_ID }),
  }));
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { ok: true });

  const frames = await collectFrames(response);
  assert.equal(frames[frames.length - 1].type, "cancelled");
  assert.ok(await waitForFile(killFile), "git's process group must receive SIGTERM");
  assert.ok(!existsSync(target), "the partial clone must be removed");
});

test("a request aborted before spawn skips git and cleans up the target", async (t) => {
  const { response, envFile, target } = await startClone(t, { sleepSec: 60, preAbort: true });

  const frames = await collectFrames(response);
  assert.equal(frames[frames.length - 1].type, "cancelled");
  assert.ok(!existsSync(envFile), "git must not be spawned when the request is already aborted");
  assert.ok(!existsSync(target), "the pre-created target must be removed");
});

test("DELETE for an unknown clone id reports 404", async () => {
  const del = await DELETE(new Request("http://localhost/api/projects/clone", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "no-such-clone" }),
  }));
  assert.equal(del.status, 404);
  const body = await del.json();
  assert.equal(body.code, "clone_not_found");
});
