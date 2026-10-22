"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Grace the externally-driven badge survives on its last observed file
 *  activity. The hub's 5s `externally-running` heartbeat refreshes it while
 *  a CLI session keeps writing, so a genuinely running CLI badge persists. */
export const EXTERNAL_BADGE_TTL_MS = 15_000;

/**
 * The running-session id set behind the sidebar's badges.
 *
 * Two feeds share one Set, and the handoff between them raced (the bug this
 * hook exists for):
 * - AUTHORITATIVE: the RPC `running` frame (a full snapshot per transition)
 *   and the pre-SSE `/api/sessions` fallback — both replace the set whole.
 * - EXTERNAL: sessions a live CLI process writes — or the WEB child writes
 *   during a moment its wrapper's running flags are false (the window around
 *   auto-compaction and maintenance continuation turns, where the child is
 *   still working while `isRunning()` is momentarily false). Each id gets a
 *   TTL timer refreshed by the heartbeat while file writes continue.
 *
 * The race: an id gets marked external during its wrapper's false-flag
 * window, and seconds later an authoritative frame re-adds it (the
 * continuation turn resumed — the session IS running again). The stale TTL
 * timer then fired mid-run and DELETED the authoritative id, and the badge
 * stayed lost until the next `running` transition — minutes or hours into a
 * long turn. So: authoritative feeds clear the timers of the ids they
 * claim, and an expiry callback never removes an id the latest
 * authoritative snapshot claims.
 */
export function useRunBadges(expiryMs: number = EXTERNAL_BADGE_TTL_MS) {
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const expiryRef = useRef<Map<string, number>>(new Map());
  const authoritativeRef = useRef<Set<string>>(new Set());

  /** Applies a full running-id snapshot (RPC `running` frame or the list
   *  fallback used before SSE is authoritative). */
  const applyAuthoritative = useCallback((ids: string[]) => {
    const next = new Set(ids);
    authoritativeRef.current = next;
    // Drop expiry timers that raced ahead of this snapshot: the ids they
    // hold are authoritative now, and a late expiry would erase the badge
    // of a running session (the regression this prevents).
    for (const id of next) {
      const timer = expiryRef.current.get(id);
      if (timer !== undefined) {
        clearTimeout(timer);
        // The guard's body does more than clear: it forgets the handle too.
        expiryRef.current.delete(id);
      }
    }
    setRunningSessionIds(next);
  }, []);

  /** Marks ids as externally running (live file activity, no RPC run). The
   *  badge expires once the writes stop and the heartbeat stops refreshing
   *  it — unless an authoritative snapshot has claimed the id since. */
  const markExternallyRunning = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setRunningSessionIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next.size === prev.size ? prev : next;
    });
    for (const id of ids) {
      // The authoritative snapshot already claims this id: its badge belongs
      // to the running-frame feed, which has no expiry. Arming a TTL here
      // would only erase it while the RPC set is unchanged.
      if (authoritativeRef.current.has(id)) continue;
      clearTimeout(expiryRef.current.get(id));
      expiryRef.current.set(id, window.setTimeout(() => {
        expiryRef.current.delete(id);
        setRunningSessionIds((prev) => {
          if (!prev.has(id) || authoritativeRef.current.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, expiryMs));
    }
  }, [expiryMs]);

  useEffect(() => () => {
    for (const timer of expiryRef.current.values()) clearTimeout(timer);
    expiryRef.current.clear();
  }, []);

  return { runningSessionIds, applyAuthoritative, markExternallyRunning };
}
