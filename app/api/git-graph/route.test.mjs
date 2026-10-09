// Route-level exercise of the git-graph dispatcher (app/api/git-graph/route.ts):
// fixture repositories in os.tmpdir, POSTs go straight to the exported handler.
// NOTE: this file requires lib/git-graph/engine.ts (and its dataSource/shims)
// to exist; before the engine port lands jiti fails on the import, so the
// suite only goes green once S1 is in place.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, appendFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": new URL("../../../", import.meta.url).pathname,
  },
});
const { POST } = await jiti.import("./route.ts");
const { allowFileRoot } = await jiti.import("@/lib/file-access.ts");

// Fixture repository: main branch with two commits and an extra ref so the
// commit payloads carry ref labels.
function makeFixtureRepo(name) {
  const repo = mkdtempSync(join(tmpdir(), name));
  const git = (args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "graph-test@example.com"]);
  git(["config", "user.name", "Graph Test"]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(["add", "a.txt"]);
  git(["commit", "-m", "first commit"]);
  appendFileSync(join(repo, "a.txt"), "two\n");
  git(["add", "a.txt"]);
  git(["commit", "-m", "second commit"]);
  git(["branch", "feature"]);
  const head = git(["rev-parse", "HEAD"]).toString().trim();
  // The route gate uses the same allow-list as app/api/git/status.
  allowFileRoot(repo);
  return { repo, head };
}

const fixture = makeFixtureRepo("git-graph-route-");
after(() => rmSync(fixture.repo, { recursive: true, force: true }));

function post(body) {
  return POST(new Request("http://localhost/api/git-graph", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

test("loadRepos answers the single-repo set with the injected boot repo", async () => {
  const response = await post({ command: "loadRepos", check: true, repo: fixture.repo });
  assert.equal(response.status, 200);
  const msg = await response.json();
  assert.equal(msg.command, "loadRepos");
  assert.deepEqual(Object.keys(msg.repos), [fixture.repo]);
  assert.equal(msg.lastActiveRepo, fixture.repo);
  assert.equal(msg.loadViewTo, null);
  assert.deepEqual(msg.workspaceFolderPaths, { [fixture.repo]: [] });
});

test("loadCommits returns the fixture commits with ref labels on head", async () => {
  const response = await post({
    command: "loadCommits",
    repo: fixture.repo,
    refreshId: 1,
    branches: null,
    authors: null,
    maxCommits: 50,
    showTags: true,
    showRemoteBranches: true,
    includeCommitsMentionedByReflogs: false,
    onlyFollowFirstParent: false,
    commitOrdering: "date",
    remotes: [],
    hideRemotes: [],
    stashes: [],
    simplifyByDecoration: false,
    pathFilter: null,
  });
  assert.equal(response.status, 200);
  const msg = await response.json();
  assert.equal(msg.command, "loadCommits");
  assert.equal(msg.error, null);
  assert.equal(msg.refreshId, 1);
  assert.equal(msg.commits.length, 2);
  assert.equal(msg.commits[0].hash, fixture.head);
  assert.equal(msg.commits[0].message, "second commit");
  // The main and feature refs both point at head (ref labels ride along on
  // the commit's heads array as branch names).
  const headLabels = msg.commits[0].heads;
  assert.ok(headLabels.includes("main"));
  assert.ok(headLabels.includes("feature"));
  assert.equal(msg.head, fixture.head);
});

test("commitDetails loads details for a concrete commit hash", async () => {
  const response = await post({
    command: "commitDetails",
    repo: fixture.repo,
    commitHash: fixture.head,
    hasParents: false,
    stash: null,
    avatarEmail: null,
    refresh: false,
  });
  assert.equal(response.status, 200);
  const msg = await response.json();
  assert.equal(msg.command, "commitDetails");
  assert.equal(msg.error, null);
  assert.equal(msg.commitDetails.hash, fixture.head);
  assert.equal(msg.commitDetails.body, "second commit");
  assert.equal(msg.avatar, null);
  assert.equal(msg.codeReview, null);
});

test("a repo outside the allow-list comes back as 403 access_denied", async () => {
  const response = await post({ command: "loadConfig", repo: "/definitely-not-an-allowed-root", remotes: [] });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.code, "access_denied");
});

test("a relative repo path is rejected before touching git", async () => {
  const response = await post({ command: "loadCommits", repo: "some/relative/path", refreshId: 0, branches: null, authors: null, maxCommits: 10, showTags: true, showRemoteBranches: false, includeCommitsMentionedByReflogs: false, onlyFollowFirstParent: false, commitOrdering: "date", remotes: [], hideRemotes: [], stashes: [], simplifyByDecoration: false, pathFilter: null });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, "repo_must_be_absolute");
});

test("an unknown command gets the defensive ack, not an HTTP error", async () => {
  const response = await post({ command: "totallyNotAGitGraphCommand", repo: fixture.repo });
  assert.equal(response.status, 200);
  const msg = await response.json();
  assert.equal(msg.command, "totallyNotAGitGraphCommand");
  assert.equal(msg.error, "not available");
});
