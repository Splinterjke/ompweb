"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { getFileIcon } from "./FileIcons";

export interface Tab {
  id: string;
  label: string;
  filePath: string;
  sourceSessionId?: string | null;
}

interface Props {
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
}

export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab }: Props) {
  const { t } = useI18n();
  const [hoveredClose, setHoveredClose] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the active tab visible when the bar overflows horizontally.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeTabId)}"]`);
    if (!active) return;
    const listRect = list.getBoundingClientRect();
    const tabRect = active.getBoundingClientRect();
    if (tabRect.left < listRect.left) {
      list.scrollLeft -= listRect.left - tabRect.left;
    } else if (tabRect.right > listRect.right) {
      list.scrollLeft += tabRect.right - listRect.right;
    }
  }, [activeTabId, tabs]);

  const selectTabById = (id: string) => {
    const tab = tabs.find((item) => item.id === id);
    if (tab) onSelectTab(tab.id);
  };

  const focusTabById = (id: string) => {
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"]`)?.focus();
    });
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLElement>, id: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectTabById(id);
      return;
    }

    const index = tabs.findIndex((item) => item.id === id);
    if (index < 0 || tabs.length === 0) return;
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex !== null) {
      event.preventDefault();
      const nextId = tabs[nextIndex].id;
      selectTabById(nextId);
      focusTabById(nextId);
      return;
    }

    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      onCloseTab(id);
    }
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Open files"
      className="tabbar-scroll"
      style={{
        display: "flex",
        alignItems: "flex-end",
        background: "var(--bg-panel)",
        overflowX: "auto",
        flexShrink: 0,
        height: 36,
      }}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            data-tab-id={tab.id}
            className="tabbar-tab ui-focus-ring"
            onClick={() => onSelectTab(tab.id)}
            role="tab"
            tabIndex={isActive ? 0 : -1}
            aria-selected={isActive}
            aria-label={tab.filePath}
            onKeyDown={(event) => handleTabKeyDown(event, tab.id)}
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault();
            }}
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              e.stopPropagation();
              onCloseTab(tab.id);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              height: 36,
              paddingLeft: 12,
              paddingRight: 6,
              borderRight: "1px solid var(--border)",
              background: isActive ? "var(--bg)" : "var(--bg-panel)",
              cursor: "pointer",
              fontSize: "calc(12px * var(--ui-font-scale-lg, 1))",
              color: isActive ? "var(--text)" : "var(--text-muted)",
              whiteSpace: "nowrap",
              maxWidth: 180,
              minWidth: 80,
              flexShrink: 0,
              userSelect: "none",
              position: "relative",
              transition: `background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)`,
            }}
          >
            {isActive && (
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: 2,
                  background: "var(--accent)",
                  borderTopLeftRadius: "var(--radius-control)",
                  borderTopRightRadius: "var(--radius-control)",
                }}
              />
            )}
            <span style={{ flexShrink: 0, opacity: isActive ? 1 : 0.7, display: "flex", alignItems: "center" }}>
              {getFileIcon(tab.label, 13)}
            </span>
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                flex: 1,
                fontWeight: isActive ? 500 : 400,
              }}
              title={tab.filePath}
            >
              {tab.label}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
              tabIndex={isActive ? 0 : -1}
              onKeyDown={(event) => event.stopPropagation()}
              className="tabbar-close ui-focus-ring"
              onMouseEnter={() => setHoveredClose(tab.id)}
              onMouseLeave={() => setHoveredClose(null)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 24, height: 24,
                background: hoveredClose === tab.id ? "var(--bg-hover)" : "transparent",
                border: "none",
                borderRadius: "var(--radius-control)",
                color: hoveredClose === tab.id ? "var(--text)" : "var(--text-dim)",
                cursor: "pointer",
                padding: 0,
                flexShrink: 0,
                transition: `background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)`,
              }}
              title={t("tabBar.close")}
              aria-label={t("tabBar.closeTab", { label: tab.label })}
            >
              <X size={11} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
