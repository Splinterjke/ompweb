import { NextResponse } from "next/server";
import { hostClient, rustBackendActive } from "@/lib/omp/host-client";
import { broadcastRefresh, markUiUpdated } from "@/lib/ui-refresh-bus";

export const dynamic = "force-dynamic";

// POST /api/ui/refresh — rebuild-driven page refresh.
//
// Called (via loopback curl) at the end of a successful ompweb rebuild so
// every connected desktop browser reloads and picks up the new bundle. The
// Rust host records the event on its journal (authority); the Node layer
// fans it out over the shared SSE stream. The SSE route is the only
// consumer of the bus, so the refresh frame reaches every open desktop tab.
// Mobile pages ignore the frame (they only reload on their own navigation).
export async function POST(request: Request) {
  // The rebuild script POSTs { updated: true } only after a successful build+deploy.
  // Record it for the current boot so /api/app-update and the SSE server_boot frame
  // can tell the UI this was a rebuild (new bundle) vs a plain restart.
  let updated = false;
  try {
    const body = (await request.json().catch(() => ({}))) as { updated?: unknown };
    updated = body.updated === true;
  } catch {
    // malformed body: treat as a plain refresh
  }
  if (updated) markUiUpdated();
  let hostSeq: number | null = null;
  if (rustBackendActive()) {
    try {
      const { seq } = await hostClient.ui.refresh();
      hostSeq = seq;
    } catch {
      // Non-fatal: the host may not be reachable (node rollback / dev
      // without a built host). The SSE broadcast still happens so the
      // browser pages reload; the journal record is best-effort.
    }
  }
  const delivered = broadcastRefresh();
  return NextResponse.json({
    ok: true,
    delivered,
    ...(hostSeq !== null ? { seq: hostSeq } : {}),
  });
}
