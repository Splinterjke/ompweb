"use client";

import { useState, useRef, useCallback, useEffect } from "react";

export interface UseDictationOptions {
  onTranscript: (text: string) => void;
  onError?: (error: string) => void;
}

export const MAX_RECORDING_MS = 300_000;
const STT_TIMEOUT_MS = 60_000;

/**
 * Live capture state polled by RecordingDeck (timer + waveform) without
 * re-rendering the hook's consumer. Mutated in place; identity is stable.
 */
export interface DictationCapture {
  analyser: AnalyserNode | null;
  startedAt: number;
  pausedAccum: number;
  pausedAt: number | null;
  finalDurationMs?: number | null;
}

function normalizeErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object" && "message" in error) {
    const message: unknown = error.message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

export function useDictation({ onTranscript, onError }: UseDictationOptions) {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isReviewing, setIsReviewing] = useState(false);
  const [isPlayingPreview, setIsPlayingPreview] = useState(false);
  const [previewCurrentTime, setPreviewCurrentTime] = useState(0);
  const [previewDuration, setPreviewDuration] = useState(0);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const cancelledRef = useRef(false);
  const isStartingRef = useRef(false);
  const maxTimeoutRef = useRef<number | null>(null);
  const pausePreviewTimeoutRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const captureRef = useRef<DictationCapture>({ analyser: null, startedAt: 0, pausedAccum: 0, pausedAt: null, finalDurationMs: null });
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const immediateSendRef = useRef(false);
  // Audio kept after a failed/timed-out transcription so the user can retry
  // instead of losing the recording.
  const pendingAudioRef = useRef<{ blob: Blob; ext: string } | null>(null);

  const teardownPreviewAudio = useCallback(() => {
    if (pausePreviewTimeoutRef.current !== null) {
      window.clearTimeout(pausePreviewTimeoutRef.current);
      pausePreviewTimeoutRef.current = null;
    }
    if (previewAudioRef.current) {
      try {
        previewAudioRef.current.pause();
        previewAudioRef.current.src = "";
      } catch {}
      previewAudioRef.current = null;
    }
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setIsPlayingPreview(false);
    setPreviewCurrentTime(0);
    setPreviewDuration(0);
  }, []);

  const resetCaptureState = useCallback(() => {
    captureRef.current = { analyser: null, startedAt: 0, pausedAccum: 0, pausedAt: null, finalDurationMs: null };
  }, []);
  const clearMaxTimeout = useCallback(() => {
    if (maxTimeoutRef.current !== null) {
      window.clearTimeout(maxTimeoutRef.current);
      maxTimeoutRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    clearMaxTimeout();
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      try {
        mediaRecorderRef.current.stop();
      } catch {}
    }
    mediaRecorderRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      void audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    teardownPreviewAudio();
    resetCaptureState();
    setIsRecording(false);
    setIsPaused(false);
    setIsReviewing(false);
    setIsTranscribing(false);
  }, [clearMaxTimeout, teardownPreviewAudio, resetCaptureState]);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      pendingAudioRef.current = null;
      teardownPreviewAudio();
      cleanup();
    };
  }, [cleanup, teardownPreviewAudio]);

  const runTranscription = useCallback(async (blob: Blob, ext: string) => {
    setIsTranscribing(true);
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const timeoutId = window.setTimeout(() => {
      abortController.abort(new DOMException("Transcription timed out", "TimeoutError"));
    }, STT_TIMEOUT_MS);

    try {
      const body = new FormData();
      body.append("file", blob, ext);

      const res = await fetch("/api/stt", {
        method: "POST",
        body,
        signal: abortController.signal,
      });
      if (cancelledRef.current) return;
      const data = await res.json();
      if (cancelledRef.current) return;
      if (!res.ok) {
        const message = normalizeErrorMessage(data?.error, "Transcription failed");
        setTranscribeError(message);
        onError?.(message);
        return;
      }
      if (typeof data.text === "string" && data.text.trim()) {
        if (!cancelledRef.current) {
          pendingAudioRef.current = null;
          onTranscript(data.text.trim());
        }
      } else if (!cancelledRef.current) {
        const message = "No speech detected";
        setTranscribeError(message);
        onError?.(message);
      }
    } catch (err) {
      if (cancelledRef.current) return;
      if (err instanceof DOMException && err.name === "TimeoutError") {
        const message = "Transcription timed out";
        setTranscribeError(message);
        onError?.(message);
        return;
      }
      if (err instanceof DOMException && err.name === "AbortError") return;
      const message = err instanceof Error ? err.message : normalizeErrorMessage(err, "Transcription failed");
      setTranscribeError(message);
      onError?.(message);
    } finally {
      window.clearTimeout(timeoutId);
      if (abortControllerRef.current === abortController) {
        abortControllerRef.current = null;
      }
      setIsTranscribing(false);
    }
  }, [onTranscript, onError]);

  // Ends capture and moves the session into transcription. Gates on the live
  // MediaRecorder state (not the isRecording closure) because the 5-minute
  // cap timeout captures this callback from the render that started the
  // recording. Sets isTranscribing eagerly so the deck never flashes back to
  // the text composer between recorder.stop() and the async onstop event.
  const getCapturedBlob = useCallback(() => {
    if (pendingAudioRef.current) return pendingAudioRef.current;
    if (chunksRef.current.length === 0) return null;
    const recorder = mediaRecorderRef.current;
    const mimeType = recorder?.mimeType || "audio/webm";
    const blob = new Blob(chunksRef.current, { type: mimeType });
    const ext = mimeType.includes("mp4") ? "audio.mp4" : mimeType.includes("ogg") ? "audio.ogg" : "audio.webm";
    return { blob, ext };
  }, []);

  const setupPreviewAudio = useCallback((blob: Blob) => {
    // Pause/detach any previous preview element before replacing it so a
    // still-playing preview cannot outlive the controls that reference it.
    teardownPreviewAudio();
    try {
      const url = URL.createObjectURL(blob);
      previewUrlRef.current = url;
      const audio = new Audio(url);
      audio.preload = "auto";
      previewAudioRef.current = audio;
      audio.ontimeupdate = () => {
        setPreviewCurrentTime(audio.currentTime);
      };
      audio.onloadedmetadata = () => {
        if (Number.isFinite(audio.duration)) {
          setPreviewDuration(audio.duration);
        }
      };
      audio.onended = () => {
        setIsPlayingPreview(false);
        setPreviewCurrentTime(0);
      };
      audio.onpause = () => {
        setIsPlayingPreview(false);
      };
      audio.onplay = () => {
        setIsPlayingPreview(true);
      };
      audio.onerror = () => {
        setIsPlayingPreview(false);
      };
      return audio;
    } catch {
      return null;
    }
  }, [teardownPreviewAudio]);

  const playPreview = useCallback(() => {
    let audio = previewAudioRef.current;
    if (!audio) {
      const captured = getCapturedBlob();
      if (!captured) return;
      audio = setupPreviewAudio(captured.blob);
    }
    if (audio) {
      if (audio.ended || (Number.isFinite(audio.duration) && audio.currentTime >= audio.duration)) {
        audio.currentTime = 0;
      }
      audio.play().catch(() => {
        setIsPlayingPreview(false);
      });
    }
  }, [getCapturedBlob, setupPreviewAudio]);

  const pausePreview = useCallback(() => {
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
    }
    setIsPlayingPreview(false);
  }, []);

  const seekPreview = useCallback((seconds: number) => {
    if (previewAudioRef.current) {
      previewAudioRef.current.currentTime = Math.max(0, seconds);
      setPreviewCurrentTime(Math.max(0, seconds));
    }
  }, []);

  // Ends capture and moves the session into transcription or review. Gates on the live
  // MediaRecorder state (not the isRecording closure) because the 5-minute
  // cap timeout captures this callback from the render that started the
  // recording.
  const finishCapture = useCallback((options?: { immediateSend?: boolean }) => {
    clearMaxTimeout();
    immediateSendRef.current = options?.immediateSend ?? false;
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    const capture = captureRef.current;
    const finalMs = Math.max(
      0,
      performance.now() - capture.startedAt - (capture.pausedAccum + (capture.pausedAt !== null ? performance.now() - capture.pausedAt : 0)),
    );
    capture.finalDurationMs = finalMs;
    try {
      recorder.stop();
    } catch {}
    if (audioContextRef.current) {
      void audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    captureRef.current.analyser = null;
    setIsRecording(false);
    setIsPaused(false);
    if (options?.immediateSend) {
      setIsTranscribing(true);
    } else {
      setIsReviewing(true);
    }
  }, [clearMaxTimeout]);

  const start = useCallback(async () => {
    if (isStartingRef.current || isRecording || isTranscribing) return;
    isStartingRef.current = true;
    cleanup();
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    cancelledRef.current = false;
    chunksRef.current = [];
    immediateSendRef.current = false;
    pendingAudioRef.current = null;
    teardownPreviewAudio();
    setTranscribeError(null);
    setIsTranscribing(false);
    setIsReviewing(false);
    if (
      typeof navigator?.mediaDevices?.getUserMedia !== "function" ||
      typeof window === "undefined" ||
      typeof window.MediaRecorder === "undefined"
    ) {
      isStartingRef.current = false;
      onError?.("Microphone not supported in this browser or context");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      captureRef.current = { analyser: null, startedAt: performance.now(), pausedAccum: 0, pausedAt: null };
      if (typeof window.AudioContext === "function") {
        let ctx: AudioContext | null = null;
        try {
          ctx = new AudioContext();
          audioContextRef.current = ctx;
          if (ctx.state === "suspended") void ctx.resume();
          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          source.connect(analyser);
          captureRef.current.analyser = analyser;
        } catch {
          // Own the failure: never leave a live context behind untracked.
          void ctx?.close().catch(() => {});
          audioContextRef.current = null;
        }
      }

      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onstop = () => {
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }
        if (cancelledRef.current) return;
        clearMaxTimeout();
        if (chunksRef.current.length === 0) {
          const message = "No speech detected";
          setTranscribeError(message);
          setIsTranscribing(false);
          setIsReviewing(false);
          onError?.(message);
          return;
        }
        const mimeType = recorder.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const ext = mimeType.includes("mp4") ? "audio.mp4" : mimeType.includes("ogg") ? "audio.ogg" : "audio.webm";
        pendingAudioRef.current = { blob, ext };
        if (immediateSendRef.current) {
          void runTranscription(blob, ext);
        } else {
          setIsReviewing(true);
          setupPreviewAudio(blob);
        }
      };

      recorder.start(100);
      setIsRecording(true);
      maxTimeoutRef.current = window.setTimeout(() => {
        finishCapture();
      }, MAX_RECORDING_MS);
    } catch (err) {
      cleanup();
      onError?.(err instanceof Error ? err.message : "Microphone access denied");
    } finally {
      isStartingRef.current = false;
    }
  }, [isRecording, isTranscribing, cleanup, clearMaxTimeout, runTranscription, onError, finishCapture]);

  const togglePause = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || isTranscribing || transcribeError) return;
    if (recorder.state === "recording") {
      try {
        recorder.requestData();
      } catch {}
      recorder.pause();
      captureRef.current.pausedAt = performance.now();
      setIsPaused(true);
      if (pausePreviewTimeoutRef.current !== null) {
        window.clearTimeout(pausePreviewTimeoutRef.current);
      }
      pausePreviewTimeoutRef.current = window.setTimeout(() => {
        pausePreviewTimeoutRef.current = null;
        const captured = getCapturedBlob();
        if (captured) setupPreviewAudio(captured.blob);
      }, 0);
    } else if (recorder.state === "paused") {
      if (pausePreviewTimeoutRef.current !== null) {
        window.clearTimeout(pausePreviewTimeoutRef.current);
        pausePreviewTimeoutRef.current = null;
      }
      pausePreview();
      teardownPreviewAudio();
      const { pausedAt, pausedAccum } = captureRef.current;
      if (pausedAt !== null) {
        captureRef.current.pausedAccum = pausedAccum + (performance.now() - pausedAt);
      }
      captureRef.current.pausedAt = null;
      recorder.resume();
      setIsPaused(false);
    }
  }, [isTranscribing, transcribeError, getCapturedBlob, setupPreviewAudio, pausePreview, teardownPreviewAudio]);

  const confirmTranscribe = useCallback(() => {
    const pending = pendingAudioRef.current || getCapturedBlob();
    if (!pending || isTranscribing) return;
    pausePreview();
    teardownPreviewAudio();
    setIsReviewing(false);
    setTranscribeError(null);
    void runTranscription(pending.blob, pending.ext);
  }, [getCapturedBlob, isTranscribing, pausePreview, teardownPreviewAudio, runTranscription]);
  const cancel = useCallback(() => {
    cancelledRef.current = true;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    pendingAudioRef.current = null;
    setTranscribeError(null);
    setIsTranscribing(false);
    setIsReviewing(false);
    teardownPreviewAudio();
    resetCaptureState();
    cleanup();
  }, [cleanup, teardownPreviewAudio, resetCaptureState]);

  const retry = useCallback(() => {
    const pending = pendingAudioRef.current;
    if (!pending || isTranscribing) return;
    pausePreview();
    teardownPreviewAudio();
    setTranscribeError(null);
    void runTranscription(pending.blob, pending.ext);
  }, [isTranscribing, pausePreview, teardownPreviewAudio, runTranscription]);
  const toggle = useCallback(() => {
    if (isRecording) finishCapture();
    else void start();
  }, [isRecording, start, finishCapture]);

  return {
    isRecording,
    isPaused,
    isReviewing,
    isTranscribing,
    isPlayingPreview,
    previewCurrentTime,
    previewDuration,
    transcribeError,
    captureRef,
    start,
    stop: finishCapture,
    cancel,
    toggle,
    togglePause,
    retry,
    playPreview,
    pausePreview,
    seekPreview,
    confirmTranscribe,
  };
}
