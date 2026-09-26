"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createOmpwebClient } from "@/lib/client";
import type { GitStatusResponse } from "@/lib/git-types";

const client = createOmpwebClient("legacy-http");
const POLL_INTERVAL_MS = 5000;

/**
 * Polls the local git working tree (/api/git/status) while `enabled`.
 * Backs the composer git-changes bar: the 5s silent poll keeps the diff
 * counts in sync with commits made by the agent or a terminal, and the
 * server-side TTL cache collapses these polls into a single git process.
 */
export function useGitStatus(cwd: string | null | undefined, enabled: boolean = true) {
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);
  const inFlightRef = useRef(false);
  const load = useCallback(
    async (silent: boolean) => {
      if (!cwd) return;
      // A slow repository can outlive the 5s interval; never stack polls —
      // at most one in-flight request per cwd, the next tick catches up.
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const result = await client.git.changes(cwd);
        if (!aliveRef.current) return;
        setStatus(result);
        setError(null);
      } catch (e) {
        if (!aliveRef.current) return;
        if (silent) return; // keep the last good data on a transient failure
        setStatus(null);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        inFlightRef.current = false;
        if (!aliveRef.current || silent) return;
        setLoading(false);
      }
    },
    [cwd],
  );

  useEffect(() => {
    aliveRef.current = true;
    if (!enabled || !cwd) {
      setStatus(null);
      setLoading(false);
      return;
    }
    void load(false);
    const interval = window.setInterval(() => void load(true), POLL_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
      return () => {
        aliveRef.current = false;
        inFlightRef.current = false;
        window.clearInterval(interval);
        document.removeEventListener("visibilitychange", onVisibility);
      };
  }, [cwd, enabled, load]);

  const refresh = useCallback(() => void load(false), [load]);

  return { status, loading, error, refresh };
}

/** Per-cwd summary of a dirty git working tree. */
export interface CwdGitStats {
  /** Total files with local changes vs HEAD. */
  files: number;
  added: number;
  modified: number;
  deleted: number;
  untracked: number;
  /** Tracked diff lines vs HEAD (untracked excluded). */
  diffAdded: number;
  diffDeleted: number;
}

const MAX_STATS_CWDS = 12;

/**
 * Polls /api/git/status for a set of working directories and returns a
 * dirty-only summary per cwd (empty record when a repo is clean).
 * Backs the workspace-header git stats chip in the sidebar: one shared
 * poller for all tracked cwds (deduped + capped), same 5s cadence as the
 * git changes bar, so the server-side TTL cache coalesces requests.
 * The returned record keeps a stable reference while the data is
 * unchanged, so memoized rows don't re-render.
 */
export function useGitStats(cwds: string[], enabled: boolean = true): Record<string, CwdGitStats> {
  const [stats, setStats] = useState<Record<string, CwdGitStats>>({});
  // Dedupe + cap so a huge session list can't spawn an unbounded number
  // of parallel status polls.
  const listKey = (enabled ? [...new Set(cwds)].slice(0, MAX_STATS_CWDS) : []).join("\u0000");

  useEffect(() => {
    const list = listKey ? listKey.split("\u0000") : [];
    if (list.length === 0) {
      // Placement hidden (or no visible workspaces): stop polling but keep
      // the last-known stats, so re-enabling the placement shows them
      // immediately instead of waiting for a fresh (potentially slow) scan.
      return;
    }
    let disposed = false;
    // A slow repository can outlive the 5s interval; never stack rounds —
    // at most one in-flight batch, the next tick catches up.
    let inFlight = false;
    let pending = 0;

    const poll = () => {
      if (inFlight) return;
      inFlight = true;
      pending = list.length;
      const settleOne = () => {
        pending -= 1;
        if (pending === 0) inFlight = false;
      };
      // Stream each repo's result as it arrives so fast repos show their stats
      // immediately instead of waiting for the slowest repo in the batch.
      for (const cwd of list) {
        client
          .git.changes(cwd)
          .then((response) => {
            if (disposed) return;
            if (!response.isGitRepository || response.files.length === 0) {
              // Repo clean or not a git repo: drop its entry so the chip
              // disappears, keeping a stable reference when it was absent.
              setStats((prev) => {
                if (!(cwd in prev)) return prev;
                const next = { ...prev };
                delete next[cwd];
                return next;
              });
              return;
            }
            let added = 0;
            let modified = 0;
            let deleted = 0;
            let untracked = 0;
            for (const file of response.files) {
              if (file.status === "added") added += 1;
              else if (file.status === "deleted") deleted += 1;
              else if (file.status === "untracked") untracked += 1;
              else modified += 1; // modified | renamed | conflict
            }
            const entry: CwdGitStats = {
              files: response.files.length,
              added,
              modified,
              deleted,
              untracked,
              diffAdded: response.diffAdded ?? 0,
              diffDeleted: response.diffDeleted ?? 0,
            };
            // Stable reference while this repo's data is unchanged.
            setStats((prev) => (JSON.stringify(prev[cwd]) === JSON.stringify(entry) ? prev : { ...prev, [cwd]: entry }));
          })
          .catch(() => {})
          .finally(settleOne);
      }
    };

    void poll();
    const interval = window.setInterval(() => poll(), POLL_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") poll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [listKey]);

  return stats;
}
