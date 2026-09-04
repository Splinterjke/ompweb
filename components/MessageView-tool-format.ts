import { isRecord } from "@/lib/type-guards";

export interface HubSendSummary {
  to: string[];
  message: string;
  snippet: string;
}

/** Outgoing agent steering: `hub` with `op: "send"` — the TUI's `IRC → X` row. */
export function getHubSendSummary(input: unknown): HubSendSummary | null {
  if (!isRecord(input) || input.op !== "send") return null;
  const raw = Array.isArray(input.to) ? input.to : typeof input.to === "string" ? [input.to] : [];
  const to = raw
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .slice(0, 10);
  if (to.length === 0) return null;
  const message = typeof input.message === "string" ? input.message : "";
  const firstLine = message.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  const snippet = firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
  return { to, message, snippet };
}

export interface HubJobRow {
  id: string;
  type: string;
  status: string;
  label: string;
  durationMs?: number;
  resolvedModel?: string;
}

/** Live job roster: `hub` with `op: "jobs"` — the TUI's `waiting on N jobs` row. */
export function getHubJobs(details: unknown): HubJobRow[] | null {
  if (!isRecord(details) || details.op !== "jobs" || !Array.isArray(details.jobs)) return null;
  const rows: HubJobRow[] = [];
  for (const raw of details.jobs) {
    if (!isRecord(raw)) continue;
    const id = typeof raw.id === "string" && raw.id ? raw.id : null;
    if (!id) continue;
    rows.push({
      id,
      type: typeof raw.type === "string" ? raw.type : "task",
      status: typeof raw.status === "string" ? raw.status : "running",
      label: typeof raw.label === "string" && raw.label ? raw.label : id,
      ...(typeof raw.durationMs === "number" && Number.isFinite(raw.durationMs) ? { durationMs: raw.durationMs } : {}),
      ...(typeof raw.resolvedModel === "string" && raw.resolvedModel ? { resolvedModel: raw.resolvedModel } : {}),
    });
    if (rows.length >= 50) break;
  }
  return rows.length > 0 ? rows : null;
}

export function getHubJobsHeader(jobs: HubJobRow[]): string {
  const waiting = jobs.some((job) => job.status === "running" || job.status === "started" || job.status === "waiting");
  return waiting ? `waiting on ${jobs.length} job${jobs.length === 1 ? "" : "s"}` : `${jobs.length} job${jobs.length === 1 ? "" : "s"}`;
}
