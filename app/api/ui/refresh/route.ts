import { broadcastRefresh, markUiUpdated } from "@/lib/ui-refresh-bus";


// POST /api/ui/refresh — rebuild-driven page refresh.
//
// Called (via loopback curl) at the end of a successful ompweb rebuild so
// every connected desktop browser reloads and picks up the new bundle. The
// SSE route is the only consumer of the bus, so the refresh frame reaches
// every open desktop tab. Mobile pages ignore the frame (they only reload on
// their own navigation).
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
  return Response.json({ ok: true, delivered: broadcastRefresh() });
}
