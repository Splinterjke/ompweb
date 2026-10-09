/**
 * Per-model auto-compaction points (omp >= 18.8.5, `compaction.modelThresholds`
 * in config.yml). Values follow the upstream `/models` Roles-view syntax:
 * absolute token budgets (`90000`, `90k`, `1M`) or a percentage of the model's
 * context window (`80%`). Keys are `provider/model-id` or `provider/*`; the
 * exact model key wins over the provider wildcard. Pure parsing/formatting —
 * reading config.yml and rendering stay with the callers.
 */

export type CompactionThresholdValue = string | number;

export type ParsedCompactionThreshold =
  | { kind: "tokens"; tokens: number }
  | { kind: "percent"; percent: number };

/** Parse one threshold value; null for anything unusable. */
export function parseCompactionThreshold(value: CompactionThresholdValue | undefined | null): ParsedCompactionThreshold | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? { kind: "tokens", tokens: Math.round(value) } : null;
  }
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(raw);
  if (percent) {
    const p = Number(percent[1]);
    return p > 0 && p <= 100 ? { kind: "percent", percent: p } : null;
  }
  const suffixed = /^(\d+(?:\.\d+)?)\s*([km])$/.exec(raw);
  if (suffixed) {
    const n = Number(suffixed[1]) * (suffixed[2] === "m" ? 1_000_000 : 1_000);
    return n > 0 ? { kind: "tokens", tokens: Math.round(n) } : null;
  }
  const plain = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isFinite(plain) && plain > 0 ? { kind: "tokens", tokens: Math.round(plain) } : null;
}

/** Pick the effective configured threshold for one model: the exact
 * `provider/model-id` key wins over the `provider/*` wildcard. */
export function resolveModelThreshold(
  provider: string,
  modelId: string,
  thresholds: Record<string, CompactionThresholdValue> | undefined,
): { value: CompactionThresholdValue; source: string } | null {
  if (!thresholds) return null;
  const exact = `${provider}/${modelId}`;
  const wildcard = `${provider}/*`;
  if (Object.prototype.hasOwnProperty.call(thresholds, exact)) return { value: thresholds[exact], source: exact };
  if (Object.prototype.hasOwnProperty.call(thresholds, wildcard)) return { value: thresholds[wildcard], source: wildcard };
  return null;
}

/** Compact token count for labels: 90000 → `90k`, 1500000 → `1.5M`, 999 → `999`. */
export function formatHumanTokens(tokens: number): string {
  const trim = (n: number) => String(Number(n.toFixed(2)));
  if (tokens >= 1_000_000) return `${trim(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${trim(tokens / 1_000)}k`;
  return String(tokens);
}

/** Human description of one threshold. Percent values resolve against the
 * model's context window when one is known (`80% · 160k`), and the resolved
 * token count is returned for tooltips either way. */
export function describeCompactionThreshold(
  threshold: ParsedCompactionThreshold,
  contextWindow?: number,
): { label: string; tokens?: number } {
  if (threshold.kind === "tokens") {
    return { label: formatHumanTokens(threshold.tokens), tokens: threshold.tokens };
  }
  const resolved = contextWindow && contextWindow > 0 ? Math.round((contextWindow * threshold.percent) / 100) : undefined;
  return {
    label: resolved !== undefined ? `${threshold.percent}% · ${formatHumanTokens(resolved)}` : `${threshold.percent}%`,
    tokens: resolved,
  };
}
