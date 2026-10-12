import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("top bar surfaces selected model output capacity without provider quota claims", async () => {
  const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  assert.match(source, /modelCapacity?.maxTokens/);
  assert.match(source, /tooltipMaxOutput/);
  assert.doesNotMatch(source, /provider quota|remaining allowance|reset time/i);
});

test("Git trigger button opens the git-graph modal beside the file viewer", async () => {
  const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  assert.match(source, /GitGraphModal/);
  assert.match(source, /data-git-graph-trigger/);
  assert.match(source, /setGitGraphOpen\(true\)/);
  assert.match(source, /rightPanelInset/);
  // The floating edge handle was removed — only the top-bar trigger remains.
  assert.doesNotMatch(source, /github-fixed-trigger/);
  assert.doesNotMatch(source, /showChat \? 48 : 4/);
  // The trigger is no longer draggable — no drag handlers or position storage.
  assert.doesNotMatch(source, /handleGithubTriggerPointerDown/);
  assert.doesNotMatch(source, /GITHUB_TRIGGER_STORAGE_KEY/);
  assert.doesNotMatch(source, /double-click to reset/i);
  // The button is disabled (with a tooltip) when the workspace is not a git repo.
  assert.match(source, /gitWorkspace === false/);
  assert.match(source, /appShell\.githubStatusNotGit/);
});

test("title wand gates on any committed turn and keeps the busy mirror through session start", async () => {
  const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  // A compacted session can legitimately keep a window without user turns —
  // a user-message-only gate disabled the wand there with a misleading
  // "Send a message before naming this session" tooltip.
  assert.match(source, /statsForSession\.userMessages \+ statsForSession\.assistantMessages > 0/);
  // Stats count only for THEIR session; stats leaking from the previous one
  // must not arm the wand of a conversation-less session.
  assert.match(source, /sessionStats\.sessionId === selectedSession\.id/);
  // The busy mirror is push-only. A blind reset keyed on the session id used
  // to clobber the push of a run whose ChatWindow never remounted — starting
  // a new session (id appears mid-run, same ChatWindow, busy never flips)
  // left the wand enabled for the whole first run.
  assert.doesNotMatch(source, /setSelectedSessionBusy\(false\)[\s\S]{0,160}\}, \[selectedSession\?\.id\]\)/);
});
