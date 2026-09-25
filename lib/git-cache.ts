/**
 * Short-TTL, single-flight cache for git read endpoints (status / log).
 *
 * The git tab, the composer git bar, the sidebar project badges and the
 * git-graph modal all poll /api/git/status for the same repository, and each
 * miss spawns a fresh `git` process (via the Rust host in Rust mode). The
 * cache collapses concurrent calls into one in-flight git run and serves
 * repeat calls within the TTL without touching git at all.
 *
 * Held on globalThis so Next.js hot-reload / module re-evaluation cannot
 * split the cache across module instances (same pattern as the session-list
 * and github-status caches).
 */

interface CacheEntry {
  value: unknown;
  expiresAt: number;
  /** In-flight promise; concurrent callers share it (single-flight). */
  promise: Promise<unknown> | null;
}

declare global {
  var __ompGitReadCache: Map<string, CacheEntry> | undefined;
}

function getCache(): Map<string, CacheEntry> {
  if (!globalThis.__ompGitReadCache) globalThis.__ompGitReadCache = new Map();
  return globalThis.__ompGitReadCache;
}

/**
 * Run `factory` and memoize its result under `key` for `ttlMs`. Concurrent
 * callers within the TTL share the single in-flight promise, so N simultaneous
 * requests spawn exactly one git process. Failures are never cached.
 */
export async function withGitReadCache<T>(
  key: string,
  ttlMs: number,
  factory: () => Promise<T>,
): Promise<T> {
  const cache = getCache();
  const now = Date.now();
  const existing = cache.get(key);
  if (existing) {
    if (existing.expiresAt > now) {
      if (existing.promise) return existing.promise as Promise<T>;
      return existing.value as T;
    }
    cache.delete(key);
  }
  const promise = factory().then(
    (value) => {
      // Replace the in-flight entry with the resolved value.
      cache.set(key, { value, expiresAt: Date.now() + ttlMs, promise: null });
      return value;
    },
    (error: unknown) => {
      cache.delete(key);
      throw error;
    },
  );
  cache.set(key, { value: null, expiresAt: 0, promise });
  return promise as Promise<T>;
}

/**
 * Drop all cached git read results. Called after a mutating git operation
 * (commit / push / checkout) so the next read is always fresh. The cache is
 * small (a few entries per repo), so a full clear is the simplest correct
 * invalidation: any cwd in the repo is affected by any mutation.
 */
export function invalidateGitReadCache(): void {
  if (globalThis.__ompGitReadCache) globalThis.__ompGitReadCache.clear();
}
