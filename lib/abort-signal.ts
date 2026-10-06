/**
 * Abort helpers for browser code. `AbortSignal.timeout` / `AbortSignal.any`
 * are missing from older mobile browsers (Chrome < 116, Safari < 17.4); calling
 * them there throws and takes the whole React tree down with the "unexpected
 * error" screen, so client code must use these instead.
 */

export interface TimeoutSignal {
  signal: AbortSignal;
  /** Release the timer and parent listeners once the request has settled. */
  clear: () => void;
}

/** A signal that aborts after `ms`, or as soon as `parent` aborts. */
export function timeoutSignal(ms: number, parent?: AbortSignal): TimeoutSignal {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.aborted ? parent.reason : new DOMException("The operation timed out.", "TimeoutError"));
  const timer = setTimeout(abort, ms);
  const onParentAbort = () => abort();
  if (parent) {
    if (parent.aborted) abort();
    else parent.addEventListener("abort", onParentAbort, { once: true });
  }
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

/** `fetch` that is aborted after `ms` (or when `parent` aborts). */
export async function fetchWithTimeout(input: RequestInfo | URL, ms: number, init: RequestInit = {}, parent?: AbortSignal): Promise<Response> {
  const { signal, clear } = timeoutSignal(ms, parent ?? init.signal ?? undefined);
  try {
    return await fetch(input, { ...init, signal });
  } finally {
    clear();
  }
}

/** Resolves after `ms`; executor form because `Promise.withResolvers` is missing in older browsers. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
