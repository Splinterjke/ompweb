import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// Pure roster predicates of the #167 warning; the stateful send-warning
// behavior lives in useAgentSession.ts and needs the rpc harness.

const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});
const { isUnknownSlashCommand, slashCommandName } = await jiti.import("@/hooks/useAgentSession-commands.ts");

// ISSUE #167: omp reports 47 runnable builtins over RPC; `/guided-goal`,
// `/vibe`, `/budget` and `/goal` are TUI-only and absent from that list, so the
// client has to name them instead of letting them land as silent prompt text.
test("ISSUE #167 a command missing from omp's roster is reported, not run silently", () => {
  const known = ["add-dir", "compact", "model", "todo", "mcp", "session"];
  assert.equal(isUnknownSlashCommand("/guided-goal", known), true);
  assert.equal(isUnknownSlashCommand("/guided-goal ship the thing", known), true);
  assert.equal(isUnknownSlashCommand("/Goal", known), true, "matching is case-insensitive both ways");
  assert.equal(isUnknownSlashCommand("/todo", known), false);
  assert.equal(isUnknownSlashCommand("/compact now", known), false);
  // Builtins are hidden from the palette but still executed by omp.
  assert.equal(isUnknownSlashCommand("/shake", [...known, "shake"]), false);
  // No roster yet (or a failed fetch) is not evidence that anything is unknown.
  assert.equal(isUnknownSlashCommand("/guided-goal", []), false);
  // Not command-shaped, so never a false alarm on a path, URL or plain prose.
  for (const text of ["explain /guided-goal", "//host/path", "/1st thing", "plain text", ""]) {
    assert.equal(isUnknownSlashCommand(text, known), false, text);
    assert.equal(slashCommandName(text), null, text);
  }
  assert.equal(slashCommandName("  /guided-goal ship it  "), "guided-goal");
  assert.equal(slashCommandName("/todo"), "todo");
});
