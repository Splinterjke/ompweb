import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("useDictation aborts in-flight transcription and silences transcript on cancellation", async () => {
  const source = await readFile(new URL("./useDictation.ts", import.meta.url), "utf8");

  // An AbortController must be held for in-flight requests
  assert.match(source, /abortControllerRef = useRef<AbortController \| null>\(null\)/);

  // Cancel must abort any pending fetch immediately
  assert.match(source, /abortControllerRef\.current\.abort\(\)/);

  // Unmount must also abort in-flight fetch
  assert.match(source, /return \(\) => \{\s*\n\s*cancelledRef\.current = true;/);

  // Late arrival after cancel must not invoke onTranscript or onError
  assert.match(source, /if \(!cancelledRef\.current\) \{\s*\n\s*pendingAudioRef\.current = null;\s*\n\s*onTranscript\(data\.text\.trim\(\)\);/);
});

test("useDictation supports pause and resume with active-time accounting", async () => {
  const source = await readFile(new URL("./useDictation.ts", import.meta.url), "utf8");

  // Native MediaRecorder pause/resume
  assert.match(source, /recorder\.pause\(\)/);
  assert.match(source, /recorder\.resume\(\)/);

  // Paused time is accumulated so the elapsed clock only counts active time
  assert.match(source, /captureRef\.current\.pausedAt = performance\.now\(\)/);
  assert.match(source, /captureRef\.current\.pausedAccum = pausedAccum \+ \(performance\.now\(\) - pausedAt\)/);

  // Pause toggle is a no-op once transcription or an error takes over
  assert.match(source, /if \(!recorder \|\| isTranscribing \|\| transcribeError\) return;/);
});

test("useDictation exposes a live analyser for the waveform", async () => {
  const source = await readFile(new URL("./useDictation.ts", import.meta.url), "utf8");

  assert.match(source, /createMediaStreamSource\(stream\)/);
  assert.match(source, /createAnalyser\(\)/);
  assert.match(source, /captureRef\.current\.analyser = analyser/);

  // The AudioContext must be closed on cleanup
  assert.match(source, /audioContextRef\.current\.close\(\)/);
});

test("useDictation retains audio after failure and supports retry", async () => {
  const source = await readFile(new URL("./useDictation.ts", import.meta.url), "utf8");

  // The recorded blob is kept for retry and only dropped on success or discard
  assert.match(source, /pendingAudioRef\.current = \{ blob, ext \}/);
  assert.match(source, /pendingAudioRef\.current = null;\s*\n\s*onTranscript/);

  // Retry re-runs transcription with the retained audio
  assert.match(source, /const retry = useCallback\(\(\) => \{\s*\n\s*const pending = pendingAudioRef\.current;/);
  assert.match(source, /void runTranscription\(pending\.blob, pending\.ext\)/);
});

test("useDictation surfaces timeout as an error instead of swallowing it", async () => {
  const source = await readFile(new URL("./useDictation.ts", import.meta.url), "utf8");

  // The fetch timeout aborts with a TimeoutError reason
  assert.match(source, /abort\(new DOMException\("Transcription timed out", "TimeoutError"\)\)/);

  // TimeoutError is handled distinctly from the user-cancel AbortError
  assert.match(source, /err\.name === "TimeoutError"/);
  assert.match(source, /err\.name === "AbortError"\) return;/);
});

test("ChatInput replaces the composer with the deck and routes dictation keys at window level", async () => {
  const source = await readFile(new URL("../components/ChatInput.tsx", import.meta.url), "utf8");

  // The deck covers every dictation state (recording, paused, transcribing, error)
  assert.match(source, /isRecording \|\| isPaused \|\| (?:isReviewing \|\| )?isTranscribing \|\| transcribeError \? \(/);

  // Window-level listener because the textarea is unmounted while the deck shows
  assert.match(source, /window\.addEventListener\("keydown", onKeyDown\)/);
  assert.match(source, /if \(e\.key === "Escape"\) \{\s*\n\s*e\.preventDefault\(\);\s*\n\s*cancelDictationAndReset\(\);/);
});

test("ChatInput supports transcribe-only and transcribe-and-send endings", async () => {
  const source = await readFile(new URL("../components/ChatInput.tsx", import.meta.url), "utf8");

  // Send mode flags the transcript to be sent once transcription succeeds,
  // and queue modes route through sendQueued — asserted as one wired block
  // so a regression in the branch cannot pass via unrelated string matches.
  assert.match(
    source,
    /const after = dictationAfterRef\.current;[\s\S]*?if \(after === "send"\) \{\s*\n\s*void handleSend\(finalText\);\s*\n\s*\} else if \(after === "steer" \|\| after === "followup"\) \{\s*\n\s*sendQueued\(after, finalText\);/,
  );

  // handleSend accepts the composed dictation text override
  assert.match(source, /async \(overrideText\?: string\) =>/);
});

test("useDictation supports playback preview while paused and review mode upon stop", async () => {
  const source = await readFile(new URL("./useDictation.ts", import.meta.url), "utf8");

  // Request data on pause to accumulate chunks for preview
  assert.match(source, /recorder\.requestData\(\)/);

  // Exposes preview playback and review states
  assert.match(source, /isReviewing/);
  assert.match(source, /isPlayingPreview/);
  assert.match(source, /playPreview/);
  assert.match(source, /pausePreview/);
  assert.match(source, /seekPreview/);
  assert.match(source, /confirmTranscribe/);

  // Stopping capture transitions to review state instead of immediately transcribing
  assert.match(source, /setIsReviewing\(true\)/);
});

test("RecordingDeck renders left preview play button when paused and in review mode", async () => {
  const deckSource = await readFile(new URL("../components/RecordingDeck.tsx", import.meta.url), "utf8");

  // Left play preview button when paused or in review mode
  assert.match(deckSource, /onPlayPreview/);
  assert.match(deckSource, /isPlayingPreview/);

  // Review mode renders discard and confirm buttons
  assert.match(deckSource, /isReviewing/);
  assert.match(deckSource, /onConfirmTranscribe/);
});
