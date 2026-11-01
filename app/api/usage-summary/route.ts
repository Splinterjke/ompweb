import { getUsageSummary } from "@/lib/usage-summary";


export async function GET() {
  try {
    return Response.json(await getUsageSummary());
  } catch {
    return Response.json({ error: "usage summary unavailable", code: "usage_summary_unavailable" }, { status: 502 });
  }
}
