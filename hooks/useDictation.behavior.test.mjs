import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { act, cleanup, renderHook } from "@testing-library/react/pure.js";

// These tests execute the dictation state machine against fake
// getUserMedia/MediaRecorder/AudioContext implementations. They assert the
// observable hook state a consumer renders from (isRecording/isPaused/
// isReviewing, live analyser, active-time accounting, blob-URL lifetime) —
// the states the composer and RecordingDeck actually read.

const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});
const { useDictation } = await jiti.import("../hooks/useDictation.ts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function settle(ms = 20) {
  await act(async () => {
    await sleep(ms);
  });
}

let world;

class FakeTrack {
  constructor() {
    this.stopped = false;
  }
  stop() {
    this.stopped = true;
  }
}

class FakeMediaRecorder {
  constructor(stream) {
    this.stream = stream;
    this.state = "inactive";
    this.mimeType = "audio/webm";
    this.timeslice = null;
    this.ondataavailable = null;
    this.onstop = null;
    world.recorders.push(this);
  }
  start(timeslice) {
    this.state = "recording";
    this.timeslice = timeslice ?? null;
  }
  requestData() {
    this.ondataavailable?.({ data: new Blob(["chunk"], { type: this.mimeType }) });
  }
  pause() {
    this.state = "paused";
  }
  resume() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["chunk"], { type: this.mimeType }) });
    this.onstop?.();
  }
}

class FakeAudioContext {
  constructor() {
    this.state = "running";
    this.closed = false;
  }
  createMediaStreamSource() {
    return { connect: () => {} };
  }
  createAnalyser() {
    return {
      fftSize: 2048,
      frequencyBinCount: 128,
      getByteFrequencyData: () => {},
      connect: () => {},
    };
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

class FakePreviewAudio {
  constructor(src) {
    this.src = src;
    this.currentTime = 0;
    this.duration = 1;
    this.ended = false;
    this.paused = true;
  }
  play() {
    this.paused = false;
    this.onplay?.();
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.onpause?.();
  }
}

const overrides = [];
function override(target, key, replacement) {
  overrides.push({ target, key, original: Object.getOwnPropertyDescriptor(target, key) });
  Object.defineProperty(target, key, { configurable: true, writable: true, value: replacement });
}

beforeEach(() => {
  world = { recorders: [], createdUrls: [], revokedUrls: [], tracks: [] };
  const track = new FakeTrack();
  world.tracks.push(track);
  override(navigator, "mediaDevices", {
    getUserMedia: async () => ({ getTracks: () => [track] }),
  });
  override(window, "MediaRecorder", FakeMediaRecorder);
  override(globalThis, "MediaRecorder", FakeMediaRecorder);
  override(window, "AudioContext", FakeAudioContext);
  override(globalThis, "AudioContext", FakeAudioContext);
  override(window, "Audio", FakePreviewAudio);
  override(globalThis, "Audio", FakePreviewAudio);
  override(URL, "createObjectURL", (blob) => {
    const url = `blob:fake/${world.createdUrls.length}`;
    world.createdUrls.push({ url, blob });
    return url;
  });
  override(URL, "revokeObjectURL", (url) => {
    world.revokedUrls.push(url);
  });
  override(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => ({ text: "transcribed words" }),
  }));
});

afterEach(() => {
  try {
    cleanup();
  } finally {
    while (overrides.length) {
      const { target, key, original } = overrides.pop();
      if (original) Object.defineProperty(target, key, original);
      else delete target[key];
    }
  }
});

function mountDictation() {
  const transcripts = [];
  const errors = [];
  const view = renderHook(() =>
    useDictation({
      onTranscript: (text) => transcripts.push(text),
      onError: (message) => errors.push(message),
    }),
  );
  return { view, transcripts, errors };
}

test("starting capture puts the hook in the recording state with a live analyser", async () => {
  const { view, errors } = mountDictation();

  await act(async () => {
    view.result.current.toggle();
  });
  await settle();

  assert.equal(errors.length, 0, `unexpected dictation errors: ${errors.join(" | ")}`);
  assert.equal(view.result.current.isRecording, true, "consumer must see isRecording after start");
  assert.equal(view.result.current.isPaused, false);
  assert.equal(view.result.current.isReviewing, false);
  assert.equal(world.recorders.length, 1);
  assert.equal(world.recorders[0].state, "recording");
  assert.equal(world.recorders[0].timeslice, 100, "timeslice keeps chunks flowing for preview");
  assert.notEqual(view.result.current.captureRef.current.analyser, null, "waveform needs a live analyser");
  assert.ok(view.result.current.captureRef.current.startedAt > 0, "timer needs a start stamp");
});

test("pause then resume keeps the timer base and analyser while accumulating paused time", async () => {
  const { view } = mountDictation();

  await act(async () => {
    view.result.current.toggle();
  });
  await settle();

  const { startedAt, analyser } = view.result.current.captureRef.current;

  await act(async () => {
    view.result.current.togglePause();
  });
  await settle(40);

  assert.equal(view.result.current.isPaused, true);
  assert.ok(view.result.current.captureRef.current.pausedAt !== null);

  await act(async () => {
    view.result.current.togglePause();
  });
  await settle();

  const capture = view.result.current.captureRef.current;
  assert.equal(view.result.current.isPaused, false);
  assert.equal(capture.startedAt, startedAt, "resume must not reset the elapsed base");
  assert.equal(capture.analyser, analyser, "resume must not drop the live analyser");
  assert.equal(capture.pausedAt, null);
  assert.ok(capture.pausedAccum > 0, "paused time must be subtracted from active elapsed time");
  assert.equal(world.recorders[0].state, "recording");
});

test("stopping capture enters review with a playable preview, and confirming releases it", async () => {
  const { view, transcripts } = mountDictation();

  await act(async () => {
    view.result.current.toggle();
  });
  await settle();

  await act(async () => {
    view.result.current.stop();
  });
  await settle();

  assert.equal(view.result.current.isReviewing, true);
  assert.equal(view.result.current.isRecording, false);
  assert.equal(world.createdUrls.length, 1, "review mode needs a preview blob URL");
  assert.ok(world.tracks[0].stopped, "microphone tracks must be released on stop");

  await act(async () => {
    view.result.current.playPreview();
  });
  await settle();
  assert.equal(view.result.current.isPlayingPreview, true);

  await act(async () => {
    view.result.current.confirmTranscribe();
  });
  await settle(60);

  assert.deepEqual(world.revokedUrls, [world.createdUrls[0].url], "confirming must revoke the preview URL");
  assert.equal(view.result.current.isReviewing, false);
  assert.deepEqual(transcripts, ["transcribed words"]);
});

test("cancelling during capture clears state and releases the microphone", async () => {
  const { view, transcripts } = mountDictation();

  await act(async () => {
    view.result.current.toggle();
  });
  await settle();

  await act(async () => {
    view.result.current.cancel();
  });
  await settle();

  assert.equal(view.result.current.isRecording, false);
  assert.equal(view.result.current.isPaused, false);
  assert.equal(view.result.current.isReviewing, false);
  assert.equal(view.result.current.isTranscribing, false);
  assert.equal(view.result.current.captureRef.current.analyser, null);
  assert.ok(world.tracks[0].stopped);
  assert.deepEqual(transcripts, []);
});
