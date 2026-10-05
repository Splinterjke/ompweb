"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, RefreshCw, Search, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { createOmpwebClient } from "@/lib/client";
import type { MemoryBankInfo, MemoryItem, MemoryTable } from "@/lib/memory-types";
import { Tooltip } from "../ui/primitives";

/**
 * Single-page read-only viewer for Mnemopi memory banks. All data access goes
 * through lib/memory-client (GET-only routes that open the live SQLite
 * databases strictly read-only); nothing here can mutate an agent's memory.
 */

const PAGE_LIMIT = 50;
const SEARCH_DEBOUNCE_MS = 300;
const client = createOmpwebClient("legacy-http");

const TABLE_KEYS: Record<MemoryTable, { labelKey: string; fallback: string }> = {
  working: { labelKey: "memory.tabWorking", fallback: "Working" },
  episodic: { labelKey: "memory.tabEpisodic", fallback: "Episodic" },
  facts: { labelKey: "memory.tabFacts", fallback: "Facts" },
};

/** "2026-10-05T17:40:05.331Z" / "2026-10-05 17:40:05" → "2026-10-05 17:40". */
function formatTimestamp(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  const normalized = value.replace("T", " ").replace("Z", "");
  return normalized.slice(0, 16);
}

function formatScore(value: unknown): string | null {
  const num = typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : Number.NaN;
  return Number.isFinite(num) ? num.toFixed(2) : null;
}

function chipStyle(): React.CSSProperties {
  return {
    fontFamily: "var(--font-mono)",
    fontSize: "calc(9.5px * var(--ui-font-scale-sm, 1))",
    color: "var(--text-dim)",
    background: "var(--bg-subtle)",
    borderRadius: 6,
    padding: "1px 5px",
    whiteSpace: "nowrap",
  };
}

export function MemoryPanel() {
  const { t } = useI18n();
  const tt = useCallback((key: string, fallback: string) => {
    const translated = t(key);
    return translated === key ? fallback : translated;
  }, [t]);

  const [banks, setBanks] = useState<MemoryBankInfo[] | null>(null);
  const [banksError, setBanksError] = useState<string | null>(null);
  const [banksRefresh, setBanksRefresh] = useState(0);
  const [bank, setBank] = useState<string | null>(null);
  const [table, setTable] = useState<MemoryTable>("facts");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [total, setTotal] = useState(0);
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const rowsRequestRef = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    client.memory.listBanks(controller.signal)
      .then(({ banks: list }) => {
        if (cancelled) return;
        setBanks(list);
        setBanksError(null);
        setBank((current) => (current && list.some((entry) => entry.name === current) ? current : list[0]?.name ?? null));
      })
      .catch((fetchError: unknown) => {
        if (cancelled || controller.signal.aborted) return;
        setBanksError(String(fetchError instanceof Error ? fetchError.message : fetchError));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [banksRefresh]);

  // Rows for the selected bank/table/search. The request token keeps a slow
  // earlier response from overwriting a newer page (bank switch mid-flight).
  useEffect(() => {
    if (!bank) return;
    const request = ++rowsRequestRef.current;
    setLoading(true);
    setError(null);
    setExpandedId(null);
    const controller = new AbortController();
    client.memory.query(bank, table, { q: debouncedQuery, limit: PAGE_LIMIT, offset: 0 }, controller.signal)
      .then((data) => {
        if (request !== rowsRequestRef.current) return;
        setTotal(data.total);
        setItems(data.items);
        setLoading(false);
      })
      .catch((fetchError: unknown) => {
        if (request !== rowsRequestRef.current || controller.signal.aborted) return;
        setError(String(fetchError instanceof Error ? fetchError.message : fetchError));
        setItems([]);
        setTotal(0);
        setLoading(false);
      });
    return () => controller.abort();
  }, [bank, table, debouncedQuery]);

  const loadMore = useCallback(() => {
    if (!bank || items.length >= total) return;
    const request = rowsRequestRef.current;
    setLoadingMore(true);
    client.memory.query(bank, table, { q: debouncedQuery, limit: PAGE_LIMIT, offset: items.length })
      .then((data) => {
        if (request !== rowsRequestRef.current) return;
        setTotal(data.total);
        setItems((current) => [...current, ...data.items]);
      })
      .catch(() => { /* keep the current page; the button stays for a retry */ })
      .finally(() => setLoadingMore(false));
  }, [bank, table, debouncedQuery, items.length, total]);

  if (banksError && !banks) {
    return (
      <div style={{ height: "100%", display: "grid", placeItems: "center", padding: 20, color: "var(--text-dim)", fontSize: "calc(12px * var(--ui-font-scale-lg, 1))", textAlign: "center" }}>
        <div>
          <div style={{ marginBottom: 10 }}>{tt("memory.error", "Failed to load memory banks")}</div>
          <button type="button" onClick={() => setBanksRefresh((value) => value + 1)} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", padding: "5px 12px", cursor: "pointer", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))" }}>
            {tt("memory.retry", "Retry")}
          </button>
        </div>
      </div>
    );
  }

  if (!banks) {
    return (
      <div style={{ height: "100%", display: "grid", placeItems: "center", color: "var(--text-dim)", fontSize: "calc(12px * var(--ui-font-scale-lg, 1))" }} role="status">
        {tt("memory.loading", "Loading memory…")}
      </div>
    );
  }

  if (banks.length === 0) {
    return (
      <div style={{ height: "100%", display: "grid", placeItems: "center", padding: 24, color: "var(--text-dim)", fontSize: "calc(12px * var(--ui-font-scale-lg, 1))", textAlign: "center" }}>
        {tt("memory.noBanks", "No memory banks found. Enable the mnemopi memory backend in omp settings.")}
      </div>
    );
  }

  const selected = banks.find((entry) => entry.name === bank) ?? banks[0];

  return (
    <div data-testid="memory-panel" style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column", background: "var(--bg)", color: "var(--text)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)", flexShrink: 0 }}>
        <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
          <select
            aria-label={tt("memory.bankLabel", "Memory bank")}
            value={selected.name}
            onChange={(event) => setBank(event.target.value)}
            style={{ width: "100%", appearance: "none", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", padding: "5px 22px 5px 8px", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", cursor: "pointer" }}
          >
            {banks.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name} ({entry.counts.facts ?? 0}F · {entry.counts.working ?? 0}W · {entry.counts.episodic ?? 0}E · {entry.counts.gists ?? 0}G)
              </option>
            ))}
          </select>
          <ChevronDown size={12} aria-hidden style={{ position: "absolute", right: 7, top: "50%", transform: "translateY(-50%)", color: "var(--text-dim)", pointerEvents: "none" }} />
        </div>
        <Tooltip content={tt("memory.refresh", "Reload banks")}>
          <button type="button" aria-label={tt("memory.refresh", "Reload banks")} onClick={() => setBanksRefresh((value) => value + 1)} style={{ display: "grid", placeItems: "center", width: 26, height: 26, flexShrink: 0, border: 0, borderRadius: 5, background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}>
            <RefreshCw size={13} aria-hidden />
          </button>
        </Tooltip>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <div role="tablist" aria-label={tt("memory.tablesLabel", "Memory tables")} style={{ display: "flex", gap: 2, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", padding: 2, background: "var(--bg-panel)" }}>
          {(Object.keys(TABLE_KEYS) as MemoryTable[]).map((key) => {
            const activeTable = key === table;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={activeTable}
                onClick={() => setTable(key)}
                style={{ border: "none", borderRadius: 6, padding: "3px 9px", background: activeTable ? "var(--bg-selected)" : "transparent", color: activeTable ? "var(--text)" : "var(--text-muted)", cursor: "pointer", fontSize: "calc(10.5px * var(--ui-font-scale-sm, 1))", fontWeight: activeTable ? 600 : 500 }}
              >
                {tt(TABLE_KEYS[key].labelKey, TABLE_KEYS[key].fallback)}
              </button>
            );
          })}
        </div>
        <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
          <Search size={12} aria-hidden style={{ position: "absolute", left: 7, top: "50%", transform: "translateY(-50%)", color: "var(--text-dim)" }} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tt("memory.searchPlaceholder", "Search memories…")}
            aria-label={tt("memory.searchPlaceholder", "Search memories…")}
            style={{ width: "100%", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", padding: "4px 22px 4px 22px", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", outline: "none" }}
          />
          {query && (
            <button type="button" aria-label={tt("memory.clearSearch", "Clear search")} onClick={() => setQuery("")} style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)", display: "grid", placeItems: "center", width: 16, height: 16, border: 0, borderRadius: 4, background: "transparent", color: "var(--text-dim)", cursor: "pointer" }}>
              <X size={11} aria-hidden />
            </button>
          )}
        </div>
      </div>

      {selected.error && (
        <div style={{ padding: "8px 10px", color: "var(--text-muted)", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", borderBottom: "1px solid var(--border)" }}>
          {tt("memory.bankError", "This bank database could not be opened read-only")}: {selected.error}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "6px 8px" }}>
        {error ? (
          <div style={{ padding: 16, color: "var(--text-dim)", fontSize: "calc(12px * var(--ui-font-scale-lg, 1))", textAlign: "center" }} role="alert">
            {tt("memory.loadRowsFailed", "Failed to load memories")}: {error}
          </div>
        ) : loading ? (
          <div style={{ padding: 16, color: "var(--text-dim)", fontSize: "calc(12px * var(--ui-font-scale-lg, 1))", textAlign: "center" }} role="status">
            {tt("memory.loading", "Loading memory…")}
          </div>
        ) : items.length === 0 ? (
          <div style={{ padding: 16, color: "var(--text-dim)", fontSize: "calc(12px * var(--ui-font-scale-lg, 1))", textAlign: "center" }}>
            {debouncedQuery ? tt("memory.emptySearch", "No entries match the search.") : tt("memory.empty", "This bank has no entries in this table.")}
          </div>
        ) : (
          <>
            {items.map((item, index) => {
              const id = String(item.id ?? item.fact_id ?? `row-${index}`);
              const expanded = expandedId === id;
              const content = typeof item.content === "string" ? item.content : typeof item.object === "string" ? item.object : "";
              const headline = table === "facts"
                ? [item.subject, item.predicate].filter((part) => typeof part === "string" && part).join(" · ")
                : (typeof item.memory_type === "string" ? item.memory_type : typeof item.source === "string" ? item.source : "");
              const score = formatScore(item.importance ?? item.confidence);
              const when = formatTimestamp(item.timestamp ?? item.created_at);
              const recall = typeof item.recall_count === "number" ? item.recall_count : null;
              const summaryOf = typeof item.summary_of === "string" && item.summary_of ? item.summary_of.split(",").length : 0;
              return (
                <button
                  key={`${id}-${index}`}
                  type="button"
                  onClick={() => setExpandedId(expanded ? null : id)}
                  aria-expanded={expanded}
                  style={{ display: "block", width: "100%", textAlign: "left", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: expanded ? "var(--bg-panel)" : "var(--bg)", padding: "7px 9px", marginBottom: 6, cursor: "pointer", color: "var(--text)" }}
                >
                  {headline && <div style={{ ...chipStyle(), display: "inline-block", marginBottom: 4, color: "var(--accent)" }}>{headline}</div>}
                  <div style={{ fontSize: "calc(11.5px * var(--ui-font-scale-sm, 1))", lineHeight: 1.5, wordBreak: "break-word", whiteSpace: expanded ? "pre-wrap" : "normal", ...(expanded ? {} : { display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" as const, overflow: "hidden" }) }}>
                    {table === "facts" ? `${item.subject ?? ""} → ${item.predicate ?? ""} → ${content}` : content}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 5 }}>
                    {score && <span style={chipStyle()}>{table === "facts" ? `c:${score}` : `i:${score}`}</span>}
                    {recall !== null && <span style={chipStyle()}>×{recall}</span>}
                    {summaryOf > 0 && <span style={chipStyle()}>Σ{summaryOf}</span>}
                    {when && <span style={chipStyle()}>{when}</span>}
                  </div>
                </button>
              );
            })}
            {items.length < total && (
              <button type="button" onClick={loadMore} disabled={loadingMore} style={{ width: "100%", border: "1px dashed var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text-muted)", padding: "6px 10px", cursor: loadingMore ? "default" : "pointer", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))" }}>
                {loadingMore ? tt("memory.loading", "Loading memory…") : `${tt("memory.loadMore", "Load more")} (${items.length}/${total})`}
              </button>
            )}
          </>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "4px 10px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)", flexShrink: 0, color: "var(--text-dim)", fontSize: "calc(10px * var(--ui-font-scale-sm, 1))", fontFamily: "var(--font-mono)" }}>
        <span>{`${total} ${tt("memory.entries", "entries")}`}</span>
        <span>{selected.name}{selected.mtimeMs ? ` · ${formatTimestamp(new Date(selected.mtimeMs).toISOString())}` : ""}</span>
      </div>
    </div>
  );
}
