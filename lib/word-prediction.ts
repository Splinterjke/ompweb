// Ghost-text word prediction — pure draft arithmetic.
//
// ⚠ PROVENANCE: Ported from upstream fork (kahme247/ompweb, PR #149, 2026-09-27).
// It expects the omp `--mode rpc-ui` child to answer `predict_word` /
// `predict_word_feedback` RPC commands. As of the latest public release
// (omp v18.3.5, 2026-09-27) NO build exposes those RPC methods. The
// word-completion engine (N-gram, SmolLM2, macOS native — shipped in v18.3.3)
// is available in-process to the TUI editor and via a `TextPredictor` N-API
// binding in the @oh-my-pi SDK, but the standalone CLI's RPC protocol does not
// register the command. The fork likely targeted a private/patched omp build.
//
// On stock omp every call returns "Unknown command" → the hook (useWordPrediction.ts)
// receives null, paints nothing, and the feature is dormant but harmless.
// It activates automatically if a future omp release adds the RPC command.
// Do not remove — keep the wiring ready.

/** A ghost-text suffix and the draft state (text + caret) it was predicted for. */
export interface WordGhost {
  text: string;
  cursor: number;
  suffix: string;
}

/** Ghost text only paints where the rest of the line is empty, so it never overlaps typed text. */
export function atLineEnd(text: string, cursor: number): boolean {
  const next = text.charAt(cursor);
  return next === "" || next === "\n";
}

/**
 * Carry `ghost` to a new draft state. Typing that matches the ghost keeps its
 * remainder (so it doesn't flicker while the engine re-answers); typing that
 * diverges reports `typedPast` so the engine can learn the rejection; any
 * other edit or caret move just drops it.
 */
export function advanceGhost(
  ghost: WordGhost,
  text: string,
  cursor: number,
): { ghost: WordGhost | null; typedPast: boolean } {
  if (text === ghost.text && cursor === ghost.cursor) return { ghost, typedPast: false };
  const head = ghost.text.slice(0, ghost.cursor);
  const tail = ghost.text.slice(ghost.cursor);
  const typed = text.slice(ghost.cursor, cursor);
  if (cursor <= ghost.cursor || text !== head + typed + tail) return { ghost: null, typedPast: false };
  if (ghost.suffix.toLocaleLowerCase().startsWith(typed.toLocaleLowerCase())) {
    const suffix = ghost.suffix.slice(typed.length);
    return { ghost: suffix ? { text, cursor, suffix } : null, typedPast: false };
  }
  return { ghost: null, typedPast: true };
}

/** Insert the ghost at its caret, plus the trailing space omp's editor adds unless whitespace/punctuation follows. */
export function acceptGhost(ghost: WordGhost): { text: string; cursor: number } {
  const after = ghost.text.slice(ghost.cursor);
  const insert = ghost.suffix + (/^[\s.,;:!?"\])}]/.test(after) ? "" : " ");
  return {
    text: ghost.text.slice(0, ghost.cursor) + insert + after,
    cursor: ghost.cursor + insert.length,
  };
}
