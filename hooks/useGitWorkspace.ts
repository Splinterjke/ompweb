import { useEffect, useState } from "react";

/** Retries of a FAILED probe (2 s, 4 s, 8 s, 16 s, 30 s); after that the caller
 *  is left with `unavailable` rather than a guess. A cwd change restarts it. */
const MAX_ATTEMPTS = 5;

export interface GitWorkspaceState {
  /** `true`/`false` are the server's ANSWER; `null` means no answer yet, a
   *  failed probe included. Only `true` may enable a git surface. */
  isRepository: boolean | null;
  /** The last probe could not be read at all — the host is offline, has not
   *  authorized this folder, or the folder no longer exists. That is NOT an
   *  answer about git: since the workspace operations moved to the host daemon,
   *  every one of those comes back as an error, and calling it "not a git
   *  repository" sends the user to look at Git instead of at the host. */
  unavailable: boolean;
}

/** Whether `cwd` is a git repository, probed through the owning host. */
export function useGitWorkspace(cwd: string | null | undefined): GitWorkspaceState {
  const [isRepository, setIsRepository] = useState<boolean | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  // `tick` re-runs the probe; `attempt` only counts, so clearing the count on a
  // recovered answer cannot itself re-probe (one wasted request per recovery).
  const [tick, setTick] = useState(0);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!cwd) {
      setIsRepository(null);
      setUnavailable(false);
      return;
    }
    let cancelled = false;
    fetch(`/api/git/status?${new URLSearchParams({ cwd })}`)
      .then(async (res) => (res.ok ? { ok: true as const, data: await res.json() } : { ok: false as const }))
      .then((outcome) => {
        if (cancelled) return;
        if (outcome.ok) {
          setIsRepository(Boolean((outcome.data as { isGitRepository?: boolean }).isGitRepository));
          setUnavailable(false);
          setAttempt(0);
          return;
        }
        setIsRepository(null);
        setUnavailable(true);
      })
      .catch(() => {
        if (cancelled) return;
        setIsRepository(null);
        setUnavailable(true);
      });
    return () => { cancelled = true; };
  }, [cwd, tick]);

  useEffect(() => {
    if (!unavailable || !cwd || attempt >= MAX_ATTEMPTS) return;
    const timer = setTimeout(() => {
      setAttempt((n) => n + 1);
      setTick((n) => n + 1);
    }, Math.min(2000 * 2 ** attempt, 30_000));
    return () => clearTimeout(timer);
  }, [unavailable, attempt, cwd]);

  // A workspace switch restarts the retry budget with the new cwd.
  useEffect(() => { setAttempt(0); }, [cwd]);

  return { isRepository, unavailable };
}
