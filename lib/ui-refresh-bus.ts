/**
 * UI refresh bus — fans a rebuild-driven "reload" signal out to every
 * connected browser over the shared /api/agent/running/events SSE stream.
 *
 * Each SSE stream registers a send function with the bus. When the ompweb
 * binary is rebuilt and the process restarts, the launcher (or a curl after
 * the build) calls POST /api/ui/refresh, which records the event on the Rust
 * host, flips the per-boot `updated` flag, and pushes a `{ type: "refresh" }`
 * frame to every registered stream.
 *
 * The refresh frame is informational: no client auto-reloads on it. The "OmpWeb
 * updated" notice surfaces via the server_boot epoch mismatch (see
 * SessionSidebar), and the user clicks "Refresh page" manually.
 *
 * The registry lives on `globalThis` so it survives Next.js dev hot-reload
 * (same pattern as the RPC session registry).
 */
type Send = () => void;

const REGISTRY_KEY = "ompweb:ui-refresh-bus" as const;

type Registry = { sends: Set<Send>; updated: boolean };

function registry(): Registry {
  const g = globalThis as Record<string, unknown>;
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = { sends: new Set<Send>(), updated: false };
  return g[REGISTRY_KEY] as Registry;
}

/**
 * Register an SSE stream for refresh broadcasts. The send function writes a
 * `{ type: "refresh" }` frame to that stream's controller. Returns an
 * unsubscribe function the stream must call on cleanup (abort/cancel).
 */
export function subscribeUiRefresh(send: Send): () => void {
  const entry = send;
  registry().sends.add(entry);
  return () => {
    registry().sends.delete(entry);
  };
}

/**
 * Push a `{ type: "refresh" }` frame to every connected stream.
 * Returns the number of streams that received it.
 */
export function broadcastRefresh(): number {
  let delivered = 0;
  for (const send of registry().sends) {
    try {
      send();
      delivered += 1;
    } catch {
      // controller already closed — the stream's cleanup will drop it.
    }
  }
  return delivered;
}

/**
 * Record that a NEW BUILD was deployed for the current boot (per-boot, in-memory:
 * a fresh process starts false). Called by POST /api/ui/refresh, which the rebuild
 * script invokes only after a successful build. The client uses this to show
 * "OmpWeb updated" (with a Refresh button) instead of the plain "OmpWeb started".
 */
export function markUiUpdated(): void {
  registry().updated = true;
}

/** True when this boot was a rebuild (a new build was deployed + restarted). */
export function wasUiUpdated(): boolean {
  return registry().updated;
}
