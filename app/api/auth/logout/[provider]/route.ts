import { NextResponse } from "next/server";
import { disposeUtilityRpc, runUtilityCommand } from "@/lib/omp/rpc-utility";
import { invalidateModelsCache } from "@/lib/models-cache";
import { invalidateModelAvailability } from "@/lib/session-model-check";
import { planLogout, type LogoutAccount } from "@/lib/auth-logout";

export const dynamic = "force-dynamic";

const TERMINAL_GUIDANCE =
  "Run `omp` in a terminal and use /logout to remove the credential.";

/**
 * Disconnect a provider credential through omp's own RPC (omp ≥ 18.7.0:
 * `get_logout_accounts` lists a provider's stored credentials, `logout`
 * removes one). Older omp builds answer "Unknown command" and keep getting
 * the terminal-guidance 501 that predates the RPC.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  let credentialId: number | undefined;
  try {
    const body = (await req.json().catch(() => ({}))) as { credentialId?: unknown };
    if (body.credentialId !== undefined) {
      if (typeof body.credentialId !== "number" || !Number.isInteger(body.credentialId)) {
        return NextResponse.json(
          { error: "credentialId must be an integer", code: "credential_id_invalid" },
          { status: 400 },
        );
      }
      credentialId = body.credentialId;
    }
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON request body", code: "invalid_json" },
      { status: 400 },
    );
  }

  let accounts: LogoutAccount[];
  try {
    const listed = await runUtilityCommand<{ accounts?: unknown }>(
      { type: "get_logout_accounts", providerId: provider },
      30_000,
    );
    accounts = Array.isArray(listed.accounts)
      ? (listed.accounts as LogoutAccount[]).filter(
          (account) => typeof account?.credentialId === "number",
        )
      : [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unknown command/i.test(message)) {
      // omp predates the logout RPC (added in 18.7.0).
      return NextResponse.json(
        {
          error: `omp-web cannot disconnect "${provider}": this omp build exposes no logout command. ${TERMINAL_GUIDANCE}`,
          code: "logout_unsupported",
        },
        { status: 501 },
      );
    }
    return NextResponse.json({ error: message, code: "logout_accounts_failed" }, { status: 502 });
  }

  const plan = planLogout(accounts, credentialId);
  if (plan.kind === "none") {
    return NextResponse.json(
      { error: `No stored credentials for "${provider}".`, code: "no_accounts" },
      { status: 404 },
    );
  }
  if (plan.kind === "choose") {
    // Several accounts are stored; the client shows the selector and
    // retries with the chosen credentialId.
    return NextResponse.json(
      { error: `Multiple accounts are stored for "${provider}".`, code: "credential_choice_required", accounts: plan.accounts },
      { status: 409 },
    );
  }
  if (plan.kind === "not_found") {
    return NextResponse.json(
      {
        error: `Credential ${credentialId} is not stored for "${provider}".`,
        code: "credential_not_found",
        accounts: plan.accounts,
      },
      { status: 409 },
    );
  }

  try {
    const result = await runUtilityCommand<{ remainingSource?: string }>(
      { type: "logout", providerId: provider, credentialId: plan.credentialId },
      30_000,
    );
    // The credential store changed: refresh the model list and restart the
    // utility process so it re-reads the credentials (same dance as login).
    invalidateModelsCache();
    invalidateModelAvailability();
    disposeUtilityRpc();
    return NextResponse.json({ ok: true, remainingSource: result?.remainingSource });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message, code: "logout_failed" }, { status: 502 });
  }
}
