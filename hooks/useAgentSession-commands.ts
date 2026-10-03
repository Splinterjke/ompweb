// fs/React-free leaf module for slash-command roster logic, split out of
// useAgentSession.ts so the pure predicates are cheaply unit-testable and
// shareable — the same reason upstream keeps them in its stream module.

// omp exposes only the commands its RPC prompt path can actually run. TUI-only
// ones (`/guided-goal`, `/vibe`, `/budget`, …) never appear in `get_commands`,
// so the client has no way to run them and sending one lands in the transcript
// as literal prompt text with no hint that nothing happened (#167).
//
// Callers pass the FULL command list — including the builtins that
// `toSlashCommandInfo` hides from the palette, which are still executed by omp
// when typed and therefore must not warn. An empty list means the roster has
// not arrived yet (or failed), in which case saying "unknown" would be a guess.
export function isUnknownSlashCommand(text: string, knownNames: readonly string[]): boolean {
  if (knownNames.length === 0) return false;
  const match = /^\/([A-Za-z][A-Za-z0-9_-]*)/.exec(text.trim());
  if (!match) return false;
  const name = match[1].toLowerCase();
  return !knownNames.some((known) => known.toLowerCase() === name);
}

/** The bare command word of a prompt that tries to invoke a slash command. */
export function slashCommandName(text: string): string | null {
  return /^\/([A-Za-z][A-Za-z0-9_-]*)/.exec(text.trim())?.[1] ?? null;
}
