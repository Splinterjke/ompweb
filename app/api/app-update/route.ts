import { NextResponse } from "next/server";
import { checkNpmUpdate, runNpmUpdate } from "@/lib/npm-update";
import { wasUiUpdated } from "@/lib/ui-refresh-bus";
import { isUpdateDisabled } from "@/lib/update-policy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get("force") === "1";
  const status = await checkNpmUpdate(force);
  // Per-boot rebuild flag (not part of the cached npm status — it is process-local).
  return NextResponse.json({ ...status, updated: wasUiUpdated() }, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST() {
  if (isUpdateDisabled()) {
    return NextResponse.json(
      { error: "Updates are disabled (OMP_WEB_DISABLE_AUTOUPDATE)", code: "updates_disabled" },
      { status: 403 },
    );
  }
  try {
    const output = await runNpmUpdate();
    return NextResponse.json({
      success: true,
      output: output.slice(-2000),
      restartRequired: true,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), code: "update_failed" },
      { status: 502 },
    );
  }
}
