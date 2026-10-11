import { execFile } from "node:child_process";
import { NextResponse } from "next/server";
import { resolveOmpBin, wrapWindowsScript } from "@/lib/omp/omp-cli";
import { createChildProcessEnvironment } from "@/lib/project-command-env";

export const runtime = "nodejs";

const CLI_TIMEOUT_MS = 60_000;

type Credit = {
  id: string;
  title?: string;
  program?: string;
  status?: string;
  remainingCount?: number;
  usable?: boolean;
  requiresLimit?: boolean;
  clears?: string;
  blocking?: boolean;
  grantedAt?: number;
  expiresAt?: number;
};

export type UsageResetAccount = {
  provider: string;
  credentialId: string;
  email?: string;
  accountId?: string;
  orgName?: string;
  availableCount?: number;
  redeemableCount?: number;
  nextCreditId?: string;
  soonestExpiry?: number;
  unavailableReason?: string;
  error?: string;
  credits?: Credit[];
};

function runOmp(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const bin = resolveOmpBin();
  if (!bin) return Promise.reject(new Error("omp binary not found"));
  const launch = wrapWindowsScript(bin, args);
  const { promise, resolve, reject } = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
  execFile(launch.file, launch.args, {
    timeout: CLI_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    env: createChildProcessEnvironment({ FORCE_COLOR: "0", NO_COLOR: "1" }),
  }, (error, stdout, stderr) => {
    if (error && typeof (error as NodeJS.ErrnoException).code !== "number") {
      reject(error);
      return;
    }
    resolve({ code: (error as { code?: number } | null)?.code ?? 0, stdout: stdout ?? "", stderr: stderr ?? "" });
  });
  return promise;
}

function parseAccounts(stdout: string): { generatedAt: number; accounts: UsageResetAccount[] } | null {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(stdout.slice(start)) as { generatedAt?: number; accounts?: unknown };
    if (!Array.isArray(parsed.accounts)) return null;
    const accounts = parsed.accounts.filter((a): a is UsageResetAccount =>
      !!a && typeof a === "object" && typeof (a as UsageResetAccount).provider === "string" && (a as UsageResetAccount).credentialId !== undefined);
    return { generatedAt: typeof parsed.generatedAt === "number" ? parsed.generatedAt : Date.now(), accounts };
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    const { code, stdout, stderr } = await runOmp(["usage", "reset", "--json"]);
    const parsed = parseAccounts(stdout);
    if (!parsed) {
      return NextResponse.json({ error: stderr.trim() || stdout.trim() || "omp returned no reset data", code: "usage_reset_parse_failed", exitCode: code }, { status: 502 });
    }
    return NextResponse.json(parsed);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error), code: "usage_reset_failed" }, { status: 500 });
  }
}

// `omp usage reset <provider>/<credentialId>` spends one saved reset on a listed account.
const TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export async function POST(request: Request) {
  let body: { target?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body", code: "invalid_body" }, { status: 400 });
  }
  const target = typeof body.target === "string" ? body.target.trim() : "";
  if (!TARGET_PATTERN.test(target)) {
    return NextResponse.json({ error: "target must be '<provider>/<credentialId>' from the reset list", code: "invalid_target" }, { status: 400 });
  }
  try {
    const { code, stdout, stderr } = await runOmp(["usage", "reset", target]);
    const output = (stdout || stderr).trim().split("\n").slice(-6).join("\n");
    if (code !== 0) {
      return NextResponse.json({ error: output || `omp usage reset exited with ${code}`, code: "usage_reset_spend_failed", exitCode: code }, { status: 502 });
    }
    return NextResponse.json({ ok: true, output });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error), code: "usage_reset_failed" }, { status: 500 });
  }
}
