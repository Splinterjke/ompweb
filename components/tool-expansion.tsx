"use client";
import { createContext, useCallback, useContext, useState } from "react";

/**
 * The user's explicit open/collapse choice for tool-call rows, hoisted out of
 * `ToolCallBlock`'s local state and keyed by the stable `toolCallId`.
 *
 * Rows are remounted by far more than a click: virtual-window recycling, a
 * transcript reload (external file write, cold-start watcher, terminal
 * reload), and the live-tail → process-group key reshuffle at run end all
 * destroy component-local state, silently collapsing rows the user opened by
 * hand. Same reason `CommittedTranscript` hoists the per-group "Process
 * details" state (`processExpanded`) — this covers the rows inside.
 *
 * The provider lives in `ChatWindow` so it spans both the committed
 * transcript and the streaming bubble: a row the user opened while streaming
 * stays open when the same toolCallId commits. The store resets with the
 * ChatWindow instance, i.e. per session (AppShell keys ChatWindow by session).
 * Outside a provider (SSR harnesses, dialogs rendering a single message) the
 * consumer hook is null and ToolCallBlock keeps its local state.
 */
export interface ToolExpansionStore {
  /** The stored override for a row key, or null when the user never toggled it. */
  get: (key: string) => boolean | null;
  set: (key: string, value: boolean) => void;
}

const ToolExpansionContext = createContext<ToolExpansionStore | null>(null);

/** Consumer seam for the store above; null outside a provider. */
export function useToolExpansionStore(): ToolExpansionStore | null {
  return useContext(ToolExpansionContext);
}

export function ToolExpansionProvider({ children }: { children: React.ReactNode }) {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const get = useCallback((key: string): boolean | null => overrides[key] ?? null, [overrides]);
  const set = useCallback((key: string, value: boolean) => {
    setOverrides((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }));
  }, []);
  const store: ToolExpansionStore = { get, set };
  return <ToolExpansionContext.Provider value={store}>{children}</ToolExpansionContext.Provider>;
}
