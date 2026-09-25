"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useGlobalKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useSidebarHistory } from "@/hooks/useSidebarHistory";
import { ConfirmDialog } from "./ui/field";
import { SessionSidebar } from "./SessionSidebar";
import { BackendHealthBanner } from "./BackendDiagnostics";
import { Tooltip, TooltipProvider } from "./ui/primitives";
import { ToastProvider } from "./ui/toast";
import { toast } from "./ui/toast";
import { ChatWindow } from "./ChatWindow";
import { TabBar, type Tab } from "./TabBar";
import { BranchNavigator } from "./BranchNavigator";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { Check, Folder, GitBranch, History, Menu, Moon, PanelLeft, PanelRight, Search, Sun, Terminal, TerminalSquare, Wand2, X } from "lucide-react";
import { ThemePicker } from "./ThemePicker";
import { DesktopUpdateBanner } from "./DesktopUpdateBanner";
import { OmpSetupWizard } from "./OmpSetupWizard";
import { TerminalTabs } from "./terminal/TerminalTabs";
import { RightWorkbench, type WorkbenchView } from "./panels/RightWorkbench";
import { PanelErrorBoundary } from "./panels/PanelErrorBoundary";
import { AgentsPanel } from "./agents/AgentsPanel";
import { FileExplorer } from "./FileExplorer";
import { SubagentDetailPanel } from "./agents/SubagentDetailPanel";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { useIsMobile } from "@/hooks/useIsMobile";
import { copyText } from "@/lib/clipboard";
import { getFileName } from "@/lib/file-paths";
import { buildAtMentionText, buildFileAtMentionsText, buildFileLineMentionText } from "@/lib/file-fuzzy";
import { getInitialNavigation } from "@/lib/initial-navigation";
import { comparableProjectPath } from "@/lib/comparable-path";
import { showBrowserNotification, showCompletionNotification } from "@/lib/browser-notifications";
import type { ManagedProject, SessionInfo, SessionTreeNode } from "@/lib/types";
import type { ChatInputHandle } from "./ChatInput";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { SubagentInfo } from "@/hooks/useAgentSession";
import type { SettingsTab } from "./SettingsTabs";
import { SettingsConfig } from "./SettingsConfig";
import { ArchiveBrowser } from "./ArchiveBrowser";
import { GitGraphModal } from "./GitGraphModal";
import { UpdateNoticeDialog } from "./UpdateNoticeDialog";
import { WorkspaceSelector } from "./WorkspaceSelector";
import { UsageDashboardModal } from "./usage/UsageDashboardModal";
import { getSeenStartedAt, isUpdateNoticeEnabled, markSeenStartedAt } from "@/lib/update-notice";
import { publishSessionsChanged } from "@/lib/session-change-bus";
import { removeBootSkeleton } from "@/lib/boot-skeleton";
// The settings shell is part of the app bundle so opening it does not fetch or compile a modal chunk. The file viewer remains on demand.
const FileViewer = dynamic(() => import("./FileViewer").then((m) => m.FileViewer), {
  ssr: false,
  loading: () => <PanelLoadingFallback />,
});

// Resizable desktop sidebar: the width is stored on the container as the
// --sidebar-width CSS variable (globals.css) and persisted between sessions.
const SIDEBAR_WIDTH_STORAGE_KEY = "omp-web:sidebar-width";
const TOOL_CALLS_COLLAPSED_STORAGE_KEY = "omp-web:tool-calls-collapsed";
const THINKING_DISPLAY_MODE_STORAGE_KEY = "omp-web:thinking-display-mode";
const EXTENDED_THINKING_BLOCK_STORAGE_KEY = "omp-web:extended-thinking-block";
const EXTENDED_BLOCKS_STORAGE_KEY = "omp-web:extended-detail-blocks";
const GIT_GRAPH_SIZE_STORAGE_KEY = "omp-web:git-graph-size";
const SESSION_INFO_BUTTON_STORAGE_KEY = "omp-web:session-info-button";
const JUMP_TO_BOTTOM_BUTTON_STORAGE_KEY = "omp-web:jump-to-bottom-button";
const TOOL_OUTPUT_CAP_STORAGE_KEY = "omp-web:tool-output-cap";
const THINKING_AUTO_FOLLOW_STORAGE_KEY = "omp-web:thinking-auto-follow";
const MESSAGE_ACTIONS_VISIBLE_STORAGE_KEY = "omp-web:message-actions-visible";
const PROCESS_DETAILS_AUTO_EXPAND_STORAGE_KEY = "omp-web:process-details-auto-expand";
const MESSAGE_TIME_FORMAT_STORAGE_KEY = "omp-web:message-time-format";
const PANELS_SWAPPED_STORAGE_KEY = "omp-web:panels-swapped";
const SESSION_GIT_STATS_STORAGE_KEY = "omp-web:session-git-stats";
export type MessageTimeFormat = "24h" | "ampm";
const GIT_GRAPH_DEFAULT_SIZE = 80;
const GIT_GRAPH_MIN_SIZE = 40;
const GIT_GRAPH_MAX_SIZE = 95;
const GIT_GRAPH_SIZE_PRESETS = [40, 50, 60, 70, 80, 90, 95];
export type ThinkingDisplayMode = "auto" | "collapsed" | "expanded";
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 520;
const RIGHT_PANEL_MIN_WIDTH = 220;
const RIGHT_PANEL_MAX_WIDTH = 640;
const RIGHT_PANEL_DEFAULT_WIDTH = 480;
const SIDEBAR_DEFAULT_WIDTH = 260;
function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}
function clampRightPanelWidth(width: number): number {
  return Math.min(RIGHT_PANEL_MAX_WIDTH, Math.max(RIGHT_PANEL_MIN_WIDTH, Math.round(width)));
}
function loadSidebarWidth(): number {
  if (typeof window === "undefined") return SIDEBAR_DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    const width = raw ? Number(raw) : NaN;
    return Number.isFinite(width) ? clampSidebarWidth(width) : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}
const CommandPalette = dynamic(() => import("./CommandPalette").then((m) => m.CommandPalette), {
  ssr: false,
});

function PanelLoadingFallback() {
  const { t } = useI18n();
  return (
    <div role="status" style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: "calc(12px * var(--ui-font-scale-lg, 1))" }}>
      {t("appShell.loading")}
    </div>
  );
}

function UpdateToast({ currentVersion, availableVersion, command, onOpenSettings }: {
  currentVersion: string | null | undefined;
  availableVersion: string;
  command: string;
  onOpenSettings: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <div>{t("appShell.updateVersion", { current: currentVersion ?? "?", available: availableVersion })}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label={t("appShell.updateOpenSettings")}
          style={{ padding: "3px 9px", border: "1px solid var(--accent)", borderRadius: "var(--radius-control)", background: "var(--accent)", color: "var(--bg)", cursor: "pointer", fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", fontWeight: 600 }}
        >
          {command}
        </button>
      </div>
    </>
  );
}

function UpdateToastTitle({ product }: { product: "app" | "omp" }) {
  const { t } = useI18n();
  return t(product === "app" ? "appShell.appUpdateAvailable" : "appShell.ompUpdateAvailable");
}


type SessionCopyField = "file" | "id";
type AutoNameStatus =
  | { kind: "idle" }
  | { kind: "naming" }
  | { kind: "success" }
  | { kind: "error"; message: string };

export function AppShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [initialNavigation] = useState(() => getInitialNavigation(searchParams));
  const { isDark, preference, toggleTheme } = useTheme();
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  // When user clicks +, we only store the cwd — no fake session id
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  const [workspaceOptions, setWorkspaceOptions] = useState<{ projects: ManagedProject[]; selectedProject: string | null; cwd: string | null }>({ projects: [], selectedProject: null, cwd: null });
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const handleWorkspaceOptionsChange = useCallback((projects: ManagedProject[], selectedProject: string | null, cwd: string | null) => {
    setWorkspaceOptions({ projects, selectedProject, cwd });
  }, []);
  const [initialCwdStatus, setInitialCwdStatus] = useState<"idle" | "validating" | "ready" | "error">(
    () => initialNavigation.requestedCwd ? "validating" : "idle",
  );
  const [initialCwdError, setInitialCwdError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionKey, setSessionKey] = useState(0);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [explorerRefreshing, setExplorerRefreshing] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [archiveBrowserOpen, setArchiveBrowserOpen] = useState(false);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSidebarReady, setMobileSidebarReady] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window === "undefined") return SIDEBAR_DEFAULT_WIDTH;
    return loadSidebarWidth();
  });
  // Whether the active workspace is a git repository. `null` means not probed
  // yet; the GitGraph button stays disabled until the probe confirms a repo, so
  // a fresh page load never shows it as enabled for a non-repo workspace.
  const [gitWorkspace, setGitWorkspace] = useState<boolean | null>(null);
  const [gitGraphModalSize, setGitGraphModalSize] = useState(() => {
    if (typeof window === "undefined") return GIT_GRAPH_DEFAULT_SIZE;
    const raw = window.localStorage.getItem(GIT_GRAPH_SIZE_STORAGE_KEY);
    const parsed = raw === null ? Number.NaN : Number(raw);
    if (!Number.isFinite(parsed)) return GIT_GRAPH_DEFAULT_SIZE;
    const clamped = Math.min(GIT_GRAPH_MAX_SIZE, Math.max(GIT_GRAPH_MIN_SIZE, Math.round(parsed)));
    // The size control is a fixed preset list; snap any legacy stored value
    // outside it to the default so the select never renders blank.
    return GIT_GRAPH_SIZE_PRESETS.includes(clamped) ? clamped : GIT_GRAPH_DEFAULT_SIZE;
  });
  const [toolCallsDefaultCollapsed, setToolCallsDefaultCollapsed] = useState(true);
  const [thinkingDisplayMode, setThinkingDisplayMode] = useState<ThinkingDisplayMode>("auto");
  const [extendedThinkingBlock, setExtendedThinkingBlock] = useState(false);
  const [extendedBlocks, setExtendedBlocks] = useState(false);
  // Session Info button below the composer (Interface & Behavior switch).
  // Absent or corrupt stored values keep the button visible.
  const [sessionInfoButtonVisible, setSessionInfoButtonVisible] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      return window.localStorage.getItem(SESSION_INFO_BUTTON_STORAGE_KEY) !== "false";
    } catch {
      return true;
    }
  });
  // Jump-to-bottom button above the composer (Interface & Behavior switch).
  // Absent or corrupt stored values keep the button visible.
  const [showJumpToBottomButton, setShowJumpToBottomButton] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      return window.localStorage.getItem(JUMP_TO_BOTTOM_BUTTON_STORAGE_KEY) !== "false";
    } catch {
      return true;
    }
  });
  // Per-session git change stats under session names (Interface & Behavior
  // switch). Absent or corrupt stored values keep the stats visible.
  const [sessionGitStatsVisible, setSessionGitStatsVisible] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      return window.localStorage.getItem(SESSION_GIT_STATS_STORAGE_KEY) !== "false";
    } catch {
      return true;
    }
  });
  // Cap expanded tool-call output at a fixed height (Interface & Behavior
  // switch). Defaults to on; an absent/corrupt stored value keeps the cap.
  const [toolOutputCapEnabled, setToolOutputCapEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      return window.localStorage.getItem(TOOL_OUTPUT_CAP_STORAGE_KEY) !== "false";
    } catch {
      return true;
    }
  });
  // Auto-follow (bottom-pinned scroll) for streaming thinking blocks (Interface
  // & Behavior switch). Only meaningful while "Limit tool output height" is on —
  // the capped body is the only scrollable thinking surface. Defaults to on; an
  // absent/corrupt stored value keeps follow enabled.
  const [thinkingAutoFollowEnabled, setThinkingAutoFollowEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      return window.localStorage.getItem(THINKING_AUTO_FOLLOW_STORAGE_KEY) !== "false";
    } catch {
      return true;
    }
  });
  // Message action buttons (copy / fork / edit) under messages (Interface &
  // Behavior switch). Absent or corrupt stored values keep the buttons visible.
  const [messageActionsVisible, setMessageActionsVisible] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      return window.localStorage.getItem(MESSAGE_ACTIONS_VISIBLE_STORAGE_KEY) !== "false";
    } catch {
      return true;
    }
  });
  // Auto-expand the "Process details" group of the last turn before a compaction
  // block when the user opens the pre-compaction history (Interface & Behavior
  // switch). Defaults to off; an absent/corrupt stored value keeps it collapsed.
  const [processDetailsAutoExpand, setProcessDetailsAutoExpand] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(PROCESS_DETAILS_AUTO_EXPAND_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  // Message timestamp format: 24h (default) or 12h AM/PM. Absent or corrupt
  // stored values keep the 24-hour default.
  const [messageTimeFormat, setMessageTimeFormat] = useState<MessageTimeFormat>(() => {
    if (typeof window === "undefined") return "24h";
    try {
      return window.localStorage.getItem(MESSAGE_TIME_FORMAT_STORAGE_KEY) === "ampm" ? "ampm" : "24h";
    } catch {
      return "24h";
    }
  });
  // Swap the left/right docked panels: the session sidebar moves to the right,
  // the file workbench to the left (desktop only; mobile is an overlay).
  const [panelsSwapped, setPanelsSwapped] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(PANELS_SWAPPED_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  // Desktop only: on mobile the panels are overlays, so swapping is a no-op.
  const panelsSwappedActive = panelsSwapped && !isMobile;
  const [sidebarResizing, setSidebarResizing] = useState(false);
  // Right workbench rail width, user-adjustable via the drag handle on its
  // left edge (mirrors the sidebar resize). Persisted to
  // "omp-right-panel-width"; the load clamps into the min/max bounds.
  const [rightPanelWidth, setRightPanelWidth] = useState<number>(() => {
    if (typeof window === "undefined") return RIGHT_PANEL_DEFAULT_WIDTH;
    try {
      const raw = localStorage.getItem("omp-right-panel-width");
      const parsed = raw ? Number(raw) : RIGHT_PANEL_DEFAULT_WIDTH;
      return Number.isFinite(parsed) ? clampRightPanelWidth(parsed) : RIGHT_PANEL_DEFAULT_WIDTH;
    } catch {
      return RIGHT_PANEL_DEFAULT_WIDTH;
    }
  });
  // Live subagent roster lifted from the active ChatWindow (session-scoped).
  const [subagents, setSubagents] = useState<SubagentInfo[] | null>(null);
  const [selectedSubagent, setSelectedSubagent] = useState<SubagentInfo | null>(null);
  useEffect(() => {
    // A transcript belongs to one parent session. Never leave a detail view
    // pointing at the previous session while the sidebar selection changes.
    setSelectedSubagent(null);
  }, [selectedSession?.id, newSessionCwd]);

  // Active drag handlers so an unmount mid-drag can detach them.
  const sidebarResizeHandlersRef = useRef<{ onMove: (ev: MouseEvent) => void; onUp: () => void } | null>(null);
  // DOM element + live width during a drag (see handleSidebarResizeStart).
  const sidebarContainerRef = useRef<HTMLDivElement>(null);
  const pendingSidebarWidthRef = useRef<number>(SIDEBAR_DEFAULT_WIDTH);
  const rightPanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // T1.3: first interactive frame mounted → shell_mounted stage for the
    // desktop startup timeline (no-op in plain browsers).
    (window as { ompWebDesktop?: { startupStage?: (stage: string) => void } }).ompWebDesktop?.startupStage?.("shell_mounted");
    try {
      setToolCallsDefaultCollapsed(window.localStorage.getItem(TOOL_CALLS_COLLAPSED_STORAGE_KEY) !== "false");
    } catch {
      // Keep the compact default when storage is unavailable.
    }
    try {
      const savedThinkingMode = window.localStorage.getItem(THINKING_DISPLAY_MODE_STORAGE_KEY);
      if (savedThinkingMode === "collapsed" || savedThinkingMode === "expanded" || savedThinkingMode === "auto") {
        setThinkingDisplayMode(savedThinkingMode);
      }
    } catch {
      // Keep the auto default when storage is unavailable.
    }
    try {
      setExtendedThinkingBlock(window.localStorage.getItem(EXTENDED_THINKING_BLOCK_STORAGE_KEY) === "true");
      setExtendedBlocks(window.localStorage.getItem(EXTENDED_BLOCKS_STORAGE_KEY) === "true");
    } catch {
      // Keep the compact defaults when storage is unavailable.
    }
  }, []);
  // Interface & Behavior switches: full-width thinking/tool detail rows and
  // uncapped expanded Interrupted/Compaction blocks (CSS hooks on <html>).
  useEffect(() => {
    document.documentElement.dataset.extendedThinking = String(extendedThinkingBlock);
  }, [extendedThinkingBlock]);
  useEffect(() => {
    document.documentElement.dataset.extendedBlocks = String(extendedBlocks);
  }, [extendedBlocks]);
  useEffect(() => {
    document.documentElement.dataset.toolOutputCap = String(toolOutputCapEnabled);
  }, [toolOutputCapEnabled]);
  const handleToolCallsDefaultCollapsedChange = useCallback((collapsed: boolean) => {
    setToolCallsDefaultCollapsed(collapsed);
    try {
      window.localStorage.setItem(TOOL_CALLS_COLLAPSED_STORAGE_KEY, String(collapsed));
    } catch {
      // The preference still applies for this page load.
    }
  }, []);
  const handleThinkingDisplayModeChange = useCallback((mode: ThinkingDisplayMode) => {
    setThinkingDisplayMode(mode);
    try {
      window.localStorage.setItem(THINKING_DISPLAY_MODE_STORAGE_KEY, mode);
    } catch {}
  }, []);
  const handleExtendedThinkingBlockChange = useCallback((enabled: boolean) => {
    setExtendedThinkingBlock(enabled);
    try {
      window.localStorage.setItem(EXTENDED_THINKING_BLOCK_STORAGE_KEY, String(enabled));
    } catch {}
  }, []);
  const handleExtendedBlocksChange = useCallback((enabled: boolean) => {
    setExtendedBlocks(enabled);
    try {
      window.localStorage.setItem(EXTENDED_BLOCKS_STORAGE_KEY, String(enabled));
    } catch {}
  }, []);
  const handleSessionInfoButtonChange = useCallback((visible: boolean) => {
    setSessionInfoButtonVisible(visible);
    try {
      window.localStorage.setItem(SESSION_INFO_BUTTON_STORAGE_KEY, String(visible));
    } catch {
      // The preference still applies for this page load.
    }
  }, []);
  const handleShowJumpToBottomButtonChange = useCallback((visible: boolean) => {
    setShowJumpToBottomButton(visible);
    try {
      window.localStorage.setItem(JUMP_TO_BOTTOM_BUTTON_STORAGE_KEY, String(visible));
    } catch {
      // The preference still applies for this page load.
    }
  }, []);
  const handleSessionGitStatsChange = useCallback((visible: boolean) => {
    setSessionGitStatsVisible(visible);
    try {
      window.localStorage.setItem(SESSION_GIT_STATS_STORAGE_KEY, String(visible));
    } catch {
      // The preference still applies for this page load.
    }
  }, []);
  const handleToolOutputCapChange = useCallback((enabled: boolean) => {
    setToolOutputCapEnabled(enabled);
    try {
      window.localStorage.setItem(TOOL_OUTPUT_CAP_STORAGE_KEY, String(enabled));
    } catch {
      // The preference still applies for this page load.
    }
  }, []);
  const handleThinkingAutoFollowChange = useCallback((enabled: boolean) => {
    setThinkingAutoFollowEnabled(enabled);
    try {
      window.localStorage.setItem(THINKING_AUTO_FOLLOW_STORAGE_KEY, String(enabled));
    } catch {
      // The preference still applies for this page load.
    }
  }, []);
  const handleMessageActionsVisibleChange = useCallback((visible: boolean) => {
    setMessageActionsVisible(visible);
    try {
      window.localStorage.setItem(MESSAGE_ACTIONS_VISIBLE_STORAGE_KEY, String(visible));
    } catch {
      // The preference still applies for this page load.
    }
  }, []);
  const handleProcessDetailsAutoExpandChange = useCallback((enabled: boolean) => {
    setProcessDetailsAutoExpand(enabled);
    try {
      window.localStorage.setItem(PROCESS_DETAILS_AUTO_EXPAND_STORAGE_KEY, String(enabled));
    } catch {
      // The preference still applies for this page load.
    }
  }, []);
  const handleMessageTimeFormatChange = useCallback((format: MessageTimeFormat) => {
    setMessageTimeFormat(format);
    try {
      window.localStorage.setItem(MESSAGE_TIME_FORMAT_STORAGE_KEY, format);
    } catch {
      // The preference still applies for this page load.
    }
  }, []);
  const handlePanelsSwappedChange = useCallback((swapped: boolean) => {
    setPanelsSwapped(swapped);
    try {
      window.localStorage.setItem(PANELS_SWAPPED_STORAGE_KEY, String(swapped));
    } catch {
      // The preference still applies for this page load.
    }
  }, []);
  const handleGitGraphModalSizeChange = useCallback((size: number) => {
    const clamped = Math.min(GIT_GRAPH_MAX_SIZE, Math.max(GIT_GRAPH_MIN_SIZE, Math.round(size)));
    setGitGraphModalSize(clamped);
    try {
      window.localStorage.setItem(GIT_GRAPH_SIZE_STORAGE_KEY, String(clamped));
    } catch {
      // The preference still applies for this page load.
    }
  }, []);
  // Persist the committed width (after each change; skipped mid-drag, then
  // written once the drag ends). The first run is skipped so the mount-time
  // default cannot overwrite the stored width before it is loaded.
  const sidebarWidthMountedRef = useRef(false);
  useEffect(() => {
    if (!sidebarWidthMountedRef.current) {
      sidebarWidthMountedRef.current = true;
      return;
    }
    if (sidebarResizing) return;
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
    } catch {
      // ignore storage quota / privacy-mode errors
    }
  }, [sidebarWidth, sidebarResizing]);
  const [appUpdateAvailable, setAppUpdateAvailable] = useState(false);
  const [ompUpdateAvailable, setOmpUpdateAvailable] = useState(false);
  const [ompMissing, setOmpMissing] = useState(false);
  const [ompMissingDismissed, setOmpMissingDismissed] = useState(false);
  const [ompSetupOpen, setOmpSetupOpen] = useState(false);
  const [startedNoticeVisible, setStartedNoticeVisible] = useState(false);
  const [ompVersion, setOmpVersion] = useState<string | null>(null);
  // True when the current server boot was a rebuild (new bundle deployed + restarted),
  // so the start notice shows "OmpWeb updated" with a Refresh button.
  const [startedNoticeIsUpdate, setStartedNoticeIsUpdate] = useState(false);
  // On mobile the sidebar is an overlay drawer; hide it by default so the chat
  // is visible on load. Runs once the breakpoint resolves after hydration.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);
  useEffect(() => {
    setMobileSidebarReady(true);
  }, []);
  // Pause continuous animations when the browser tab is hidden to conserve power
  useEffect(() => {
    if (typeof document === "undefined") return;
    const updateVisibility = () => {
      document.documentElement.setAttribute("data-hidden", document.hidden ? "true" : "false");
    };
    updateVisibility();
    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);
  // Chrome does not blur a focused descendant when a subtree becomes
  // aria-hidden + inert (e.g. tapping a session button closes the mobile
  // drawer), which leaves focus trapped where assistive tech cannot see it.
  // Blur synchronously in the same commit so the AX tree never observes a
  // focused element inside the hidden sidebar.
  useLayoutEffect(() => {
    if (sidebarOpen || !mobileSidebarReady) return;
    const container = sidebarContainerRef.current;
    const active = document.activeElement;
    if (container && active instanceof HTMLElement && container.contains(active)) {
      active.blur();
    }
  }, [sidebarOpen, mobileSidebarReady]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/omp-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "check" }),
      signal: controller.signal,
    })
      .then((response) => response.ok ? response.json() : null)
      .then((data: { currentVersion?: string | null; availableVersion?: string | null; updateAvailable?: boolean; updateCommand?: string } | null) => {
        setOmpUpdateAvailable(Boolean(data?.updateAvailable));
        if (!data?.updateAvailable || !data.availableVersion) return;
        const cmd = data.updateCommand || "omp update";
        let toastId: string | null = null;
        toastId = toast.info(
          <UpdateToastTitle product="omp" />,
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}><UpdateToast currentVersion={data.currentVersion} availableVersion={data.availableVersion} command={cmd} onOpenSettings={() => { setSettingsTab("system"); if (toastId) toast.close(toastId); }} /></div>,
          { variant: "update" },
        );
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  // Detect a missing omp runtime once at startup so the UI can prompt the
  // install command instead of failing on the first AI request.
  useEffect(() => {
    void fetch("/api/omp-version")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { version?: string | null } | null) => {
        const version = data?.version ?? null;
        setOmpVersion(version);
        const missing = !version;
        setOmpMissing(missing);
        setOmpSetupOpen(missing);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/app-update", { signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((data: { currentVersion?: string; availableVersion?: string | null; updateAvailable?: boolean; updateCommand?: string; startedAt?: number; updated?: boolean } | null) => {
        setAppUpdateAvailable(Boolean(data?.updateAvailable));
        setStartedNoticeIsUpdate(Boolean(data?.updated));
        // "OmpWeb started" notice: shown once per server boot (boot epoch from
        // /api/app-update) so a rebuild/restart always surfaces the running
        // Omp version. The latch is per browser tab; a new boot epoch
        // re-arms it.
        const startedAt = typeof data?.startedAt === "number" ? data.startedAt : 0;
        if (startedAt && isUpdateNoticeEnabled() && getSeenStartedAt() !== startedAt) {
          setStartedNoticeIsUpdate(Boolean(data?.updated));
          setStartedNoticeVisible(true);
          lastNoticeBootRef.current = startedAt;
          markSeenStartedAt(startedAt);
        }
        if (!data?.updateAvailable || !data.availableVersion) return;
        const cmd = data.updateCommand || "npm install -g @Splinterjke/ompweb";
        let toastId: string | null = null;
        toastId = toast.info(
          <UpdateToastTitle product="app" />,
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}><UpdateToast currentVersion={data.currentVersion} availableVersion={data.availableVersion} command={cmd} onOpenSettings={() => { setSettingsTab("system"); if (toastId) toast.close(toastId); }} /></div>,
          { variant: "update" },
        );
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);

  // Branch navigator state — populated by ChatWindow via onBranchDataChange
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(null);
  const branchLeafChangeFnRef = useRef<((leafId: string | null) => void) | null>(null);

  const handleBranchDataChange = useCallback((tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => {
    setBranchTree(tree);
    setBranchActiveLeafId(activeLeafId);
    branchLeafChangeFnRef.current = onLeafChange;
  }, []);
  const handleBranchLeafChange = useCallback((leafId: string | null) => {
    branchLeafChangeFnRef.current?.(leafId);
  }, []);

  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [systemPromptLoading, setSystemPromptLoading] = useState(false);
  const systemPromptLoaderRef = useRef<(() => Promise<void>) | null>(null);
  const systemPromptLoadIdRef = useRef(0);
  const systemBtnRef = useRef<HTMLButtonElement>(null);
  const [gitGraphOpen, setGitGraphOpen] = useState(false);
  // Workspace whose GitGraph is open. Null = the active workspace (top-panel
  // button / default). Set by a per-workspace "Open GitGraph" button in the
  // sidebar so the modal shows that workspace's graph, not the active one.
  const [gitGraphCwd, setGitGraphCwd] = useState<string | null>(null);
  const handleOpenGitGraph = useCallback((cwd?: string | null) => {
    setGitGraphCwd(cwd ?? null);
    setGitGraphOpen(true);
  }, []);

  const handleSystemPromptChange = useCallback((prompt: string | null) => {
    setSystemPrompt(prompt);
    setSystemPromptLoading(false);
  }, []);

  const handleSystemPromptLoaderChange = useCallback((loader: (() => Promise<void>) | null) => {
    systemPromptLoadIdRef.current += 1;
    systemPromptLoaderRef.current = loader;
    setSystemPromptLoading(false);
  }, []);

  // Session stats (tokens + cost) — populated by ChatWindow, displayed in top bar
  const [sessionStats, setSessionStats] = useState<SessionStatsInfo | null>(null);
  const [autoNameStatus, setAutoNameStatus] = useState<AutoNameStatus>({ kind: "idle" });
  const autoNameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);
  activeSessionIdRef.current = selectedSession?.id ?? null;
  const handleSessionStatsChange = useCallback((stats: SessionStatsInfo | null) => {
    setSessionStats(stats);
  }, []);
  const [copiedSessionField, setCopiedSessionField] = useState<SessionCopyField | null>(null);
  const sessionCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopySessionField = useCallback((field: SessionCopyField, value: string) => {
    void copyText(value).then(() => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      setCopiedSessionField(field);
      sessionCopyTimerRef.current = setTimeout(() => setCopiedSessionField(null), 1400);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    };
  }, []);


  // Single active panel — only one dropdown open at a time
  const [activeTopPanel, setActiveTopPanel] = useState<"branches" | "system" | null>(null);
  const [topPanelPos, setTopPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const toggleTopPanel = useCallback((panel: "branches" | "system") => {
    if (isMobile) setSidebarOpen(false);
    setActiveTopPanel((cur) => cur === panel ? null : panel);
  }, [isMobile]);

  const handleSystemPromptToggle = useCallback(() => {
    const opening = activeTopPanel !== "system";
    toggleTopPanel("system");
    if (!opening || systemPromptLoading || systemPrompt !== null) return;

    const load = systemPromptLoaderRef.current;
    if (!load) return;
    const loadId = ++systemPromptLoadIdRef.current;
    setSystemPromptLoading(true);
    void load().catch((error) => {
      console.error("Failed to load system prompt:", error);
    }).finally(() => {
      if (systemPromptLoadIdRef.current === loadId) setSystemPromptLoading(false);
    });
  }, [activeTopPanel, systemPrompt, systemPromptLoading, toggleTopPanel]);


  // The composer's SubagentHub row selection lands in the same right-panel
  // Agents surface as AgentsPanel's selection (detail view + workbench tab).
  const handleSubagentSelect = useCallback((subagent: SubagentInfo) => {
    setSelectedSubagent(subagent);
    setWorkbenchRequestedView({ view: "agents", nonce: Date.now() });
    setRightPanelOpen(true);
  }, []);

  const handleSidebarToggle = useCallback(() => {
    if (isMobile) setActiveTopPanel(null);
    setSidebarOpen((open) => !open);
  }, [isMobile]);

  const resetSidebarWidth = useCallback(() => {
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
  }, []);

  const changeSidebarWidth = useCallback((delta: number) => {
    setSidebarWidth((prev) => clampSidebarWidth(prev + delta));
  }, []);

  const handleSidebarResizeKey = useCallback((e: React.KeyboardEvent) => {
    // Swapped panels: the sidebar docks on the right, its inner edge is the
    // left one, so the arrows widen/narrow in opposite directions.
    const dir = panelsSwappedActive ? -1 : 1;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      changeSidebarWidth(-10 * dir);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      changeSidebarWidth(10 * dir);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      resetSidebarWidth();
    }
  }, [changeSidebarWidth, resetSidebarWidth, panelsSwappedActive]);

  const handleSidebarResizeStart = useCallback((e: React.MouseEvent) => {
    if (isMobile) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    setSidebarResizing(true);
    const onMove = (ev: MouseEvent) => {
      const next = clampSidebarWidth(startWidth + (panelsSwappedActive ? startX - ev.clientX : ev.clientX - startX));
      // Write the CSS variable straight to the DOM: the flex row follows the
      // pointer without re-rendering the whole AppShell on every mousemove.
      sidebarContainerRef.current?.style.setProperty("--sidebar-width", `${next}px`);
      pendingSidebarWidthRef.current = next;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      sidebarResizeHandlersRef.current = null;
      setSidebarResizing(false);
      // Commit the final width so state and the persisted value agree with
      // what the user actually dragged to.
      setSidebarWidth(pendingSidebarWidthRef.current);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    pendingSidebarWidthRef.current = startWidth;
    sidebarResizeHandlersRef.current = { onMove, onUp };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [isMobile, sidebarWidth, panelsSwappedActive]);
  // Right-panel rail resize: drag the handle on the panel's left edge. The
  // panel sits on the right, so a pointer moving LEFT widens it
  // (startWidth + (startX - clientX)).
  const rightPanelResizeHandlersRef = useRef<{ onMove: (ev: MouseEvent) => void; onUp: () => void } | null>(null);
  const pendingRightPanelWidthRef = useRef<number>(RIGHT_PANEL_DEFAULT_WIDTH);
  const [rightPanelResizing, setRightPanelResizing] = useState(false);

  const handleRightPanelResizeStart = useCallback((e: React.MouseEvent) => {
    if (isMobile) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = rightPanelWidth;
    setRightPanelResizing(true);
    const onMove = (ev: MouseEvent) => {
      const next = clampRightPanelWidth(startWidth + (panelsSwappedActive ? ev.clientX - startX : startX - ev.clientX));
      rightPanelRef.current?.style.setProperty("width", `${next}px`);
      pendingRightPanelWidthRef.current = next;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      rightPanelResizeHandlersRef.current = null;
      setRightPanelResizing(false);
      setRightPanelWidth(pendingRightPanelWidthRef.current);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    pendingRightPanelWidthRef.current = startWidth;
    rightPanelResizeHandlersRef.current = { onMove, onUp };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [isMobile, rightPanelWidth, panelsSwappedActive]);
  const resetRightPanelWidth = useCallback(() => {
    setRightPanelWidth(RIGHT_PANEL_DEFAULT_WIDTH);
  }, []);

  const handleRightPanelResizeKey = useCallback((e: React.KeyboardEvent) => {
    // Swapped panels: the workbench docks on the left, so the arrow
    // directions that widen/narrow it are inverted.
    const dir = panelsSwappedActive ? -1 : 1;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setRightPanelWidth((prev) => clampRightPanelWidth(prev + 10 * dir));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setRightPanelWidth((prev) => clampRightPanelWidth(prev - 10 * dir));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      resetRightPanelWidth();
    }
  }, [resetRightPanelWidth, panelsSwappedActive]);
  // Persist the committed rail width (skipped mid-drag, written when the drag
  // ends). First run is skipped so the mount-time default can't overwrite a
  // stored width before it is loaded.
  const rightPanelWidthMountedRef = useRef(false);
  useEffect(() => {
    if (!rightPanelWidthMountedRef.current) {
      rightPanelWidthMountedRef.current = true;
      return;
    }
    if (rightPanelResizing) return;
    try {
      window.localStorage.setItem("omp-right-panel-width", String(rightPanelWidth));
    } catch {
      // ignore storage quota / privacy-mode errors
    }
  }, [rightPanelWidth, rightPanelResizing]);

  // If the app unmounts mid-drag, remove the window listeners and restore the
  // body cursor; otherwise the handlers leak and body stays cursor:col-resize.
  useEffect(() => () => {
    const handlers = sidebarResizeHandlersRef.current;
    if (!handlers) return;
    window.removeEventListener("mousemove", handlers.onMove);
    window.removeEventListener("mouseup", handlers.onUp);
    sidebarResizeHandlersRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);
  // Same mid-drag cleanup for the right-panel handle.
  useEffect(() => () => {
    const handlers = rightPanelResizeHandlersRef.current;
    if (!handlers) return;
    window.removeEventListener("mousemove", handlers.onMove);
    window.removeEventListener("mouseup", handlers.onUp);
    rightPanelResizeHandlersRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  useEffect(() => {
    if (!activeTopPanel || !topBarRef.current) return;
    const update = () => {
      const rect = topBarRef.current!.getBoundingClientRect();
      setTopPanelPos({ top: rect.bottom, left: rect.left, width: rect.width });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(topBarRef.current);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [activeTopPanel]);

  // Dismiss the system/session dropdowns on outside click or Escape. The
  // Escape handler stops propagation so the global Esc (abort agent) does not
  // fire while a panel is open; clicks on the trigger buttons themselves are
  // ignored here — their onClick toggles the panel.
  useEffect(() => {
    // The branch panel manages its own outside-click and Escape dismissal.
    if (!activeTopPanel || activeTopPanel === "branches") return;
    const onPointerDown = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-top-panel]")) return;
      if (systemBtnRef.current?.contains(event.target as Node)) return;
      setActiveTopPanel(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setActiveTopPanel(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [activeTopPanel]);

  // Right workbench owns Files, Agents, Browser and Side chat. Terminal remains
  // a dedicated bottom bar/drawer so its resize and PTY lifecycle stay clear.
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [workbenchRequestedView, setWorkbenchRequestedView] = useState<{ view: WorkbenchView; nonce: number } | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalCwd, setTerminalCwd] = useState<string | null>(null);

  const toggleTerminalPanel = useCallback(() => {
    setTerminalCwd((current) => current ?? selectedSession?.cwd ?? null);
    setTerminalOpen((open) => !open);
  }, [selectedSession?.cwd]);

  // Keep the git-graph trigger on the chat side of the file viewer.  A
  // persisted width can be larger than the available viewport, so use the
  // same CSS clamp as the viewer instead of allowing the button to disappear
  // behind the preview panel.
  const rightPanelInset = rightPanelOpen && !isMobile
    ? `clamp(0px, ${rightPanelWidth}px, calc(100vw - 220px))`
    : "0px";

  // Same @mention format as the chat input's @ autocomplete, so the agent's
  // read tool resolves it the same way (it strips the @ prefix).
  const handleAtMention = useCallback((relativePath: string, isDir: boolean) => {
    chatInputRef.current?.insertText(buildAtMentionText(relativePath, isDir));
  }, []);

  const handleAtMentions = useCallback((relativePaths: string[]) => {
    const mentions = buildFileAtMentionsText(relativePaths);
    if (mentions) chatInputRef.current?.insertText(mentions);
  }, []);

  const handleFileLineMention = useCallback((relativePath: string, startLine: number, endLine: number) => {
    chatInputRef.current?.insertText(buildFileLineMentionText(relativePath, startLine, endLine));
  }, []);

  const initialSessionId = initialNavigation.sessionId;
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  // The boot gate stays closed until the sidebar has either restored a URL /
  // remembered session or conclusively found no session to restore.
  const [initialSessionRestored, setInitialSessionRestored] = useState(false);
  // The sidebar updates selectedCwd before invoking onSelectSession. Keep the
  // expected project as a token rather than a boolean: rapid clicks can emit
  // a stale cwd event first, and consuming a boolean there used to clear the
  // newly selected session and produce twitching/blank transcripts.
  const suppressCwdBumpRef = useRef<{ project: string; expiresAt: number } | null>(null);
  const armCwdSuppression = useCallback((project: string) => {
    suppressCwdBumpRef.current = { project: comparableProjectPath(project), expiresAt: Date.now() + 1500 };
  }, []);

  useEffect(() => {
    const requestedCwd = initialNavigation.requestedCwd;
    if (!requestedCwd) return;

    const controller = new AbortController();
    setInitialCwdStatus("validating");
    setInitialCwdError(null);

    void fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: requestedCwd }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { cwd?: string; error?: string; code?: string };
        if (!response.ok || !data.cwd) {
          throw new Error(data.error || data.code ? formatApiError(data) : `HTTP ${response.status}`);
        }

        // The sidebar will notify us when it adopts this cwd. Avoid remounting
        // the just-created empty chat during that initial synchronization.
        armCwdSuppression(data.cwd);
        setNewSessionCwd(data.cwd);
        setInitialCwdStatus("ready");
        setInitialSessionRestored(true);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setInitialCwdError(error instanceof Error ? error.message : String(error));
        setInitialCwdStatus("error");
        setInitialSessionRestored(true);
      });

    return () => controller.abort();
  }, [initialNavigation, armCwdSuppression]);

  const handleCwdChange = useCallback((cwd: string | null, projectRoot?: string | null) => {
    setActiveCwd(cwd);
    // Skip if cwd is null (initial mount) or during the initial URL restore.
    if (!cwd) return;
    const newProject = projectRoot ?? cwd;
    const pendingCwd = suppressCwdBumpRef.current;
    if (pendingCwd) {
      if (Date.now() > pendingCwd.expiresAt) {
        suppressCwdBumpRef.current = null;
      } else if (pendingCwd.project === comparableProjectPath(newProject)) {
        suppressCwdBumpRef.current = null;
        return;
      } else {
        // This is an out-of-order event from the previous project. Do not
        // tear down the session selected by the user; wait for its matching
        // cwd event (or the short expiry above).
        return;
      }
    }
    // Worktrees of one repo share a project root. Moving the effective cwd
    // within the same project (e.g. switching worktree, or clicking a session
    // that lives in another worktree) must not close the open session.
    // Compare case-folded: the same folder can be spelled with different
    // casing (Windows/NTFS) between the session's projectRoot and the
    // sidebar's resolved project root.
    const sessionProject = selectedSession ? (selectedSession.projectRoot ?? selectedSession.cwd) : null;
    if (sessionProject && comparableProjectPath(sessionProject) === comparableProjectPath(newProject)) {
      return;
    }
    // Close any session that belongs to a different project — it no longer
    // matches the selected project directory.
    setSelectedSession(null);
    setNewSessionCwd((prev) => {
      if (prev && prev !== cwd) return null;
      return prev;
    });
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setSystemPromptLoading(false);
    setActiveTopPanel(null);
    router.replace("/", { scroll: false });
  }, [router, selectedSession, armCwdSuppression]);

  // Client-built transient SessionInfo (new session / fork) lacks the
  // server-computed projectRoot, which the same-project check in
  // handleCwdChange relies on. Hydrate it from the session list so switching
  // worktrees right after creating a session doesn't close the chat.
  const hydrateSelectedSession = useCallback((sessionId: string) => {
    void fetch("/api/sessions")
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((d) => {
        const full = d?.sessions.find((s) => s.id === sessionId);
        if (!full) return;
        setSelectedSession((prev) => (prev && prev.id === sessionId && !prev.projectRoot ? full : prev));
      })
      .catch(() => {});
  }, []);

  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false) => {
    setNewSessionCwd(null);
    setSelectedSession(session);
    setSessionKey((k) => k + 1);
    setSystemPrompt(null);
    setSystemPromptLoading(false);
    setInitialSessionRestored(true);
    // On mobile, collapse the overlay drawer so the chat is revealed after pick.
    if (isMobile && !isRestore) {
      setSidebarOpen(false);
      requestAnimationFrame(() => chatInputRef.current?.focus());
    }
    // The sidebar sets selectedCwd BEFORE calling onSelectSession, and its
    // change effect fires after this callback. Without suppressing it, a
    // cross-project click first selects the session, then handleCwdChange
    // clears the selection again ("clicking a session does nothing").
    armCwdSuppression(session.projectRoot ?? session.cwd);
    // Transient sessions (new/fork) lack projectRoot, which the
    // same-project check in handleCwdChange relies on — hydrate it so the
    // comparison cannot misfire and close the chat we just opened.
    hydrateSelectedSession(session.id);
    // Skip router.replace when restoring from URL — the param is already correct
    // and calling replace in production Next.js triggers a Suspense remount loop
    if (!isRestore) {
      router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
    }
  }, [router, isMobile, hydrateSelectedSession, armCwdSuppression]);

  const [usageDashboardOpen, setUsageDashboardOpen] = useState(false);
  const [usageDashboardTab, setUsageDashboardTab] = useState<"limits" | "models" | "projects" | "logs">("limits");

  const handleOpenSessionFromFile = useCallback((sessionFilePath: string) => {
    const filename = sessionFilePath.split("/").pop() ?? "";
    const match = /_([0-9a-fA-F-]+)\.jsonl$/.exec(filename);
    const sessionId = match ? match[1] : null;
    if (sessionId) {
      void fetch(`/api/sessions/${sessionId}`)
        .then((res) => (res.ok ? (res.json() as Promise<SessionInfo>) : null))
        .then((info) => {
          if (info) {
            handleSelectSession(info, false);
            setUsageDashboardOpen(false);
          }
        })
        .catch(() => {});
    }
  }, [handleSelectSession]);

  useEffect(() => {
    const handler = (e: Event) => {
      const custom = e as CustomEvent<{ tab?: "limits" | "models" | "projects" | "logs" }>;
      if (custom.detail?.tab) setUsageDashboardTab(custom.detail.tab);
      setUsageDashboardOpen(true);
    };
    window.addEventListener("omp-open-usage-dashboard", handler);
    return () => window.removeEventListener("omp-open-usage-dashboard", handler);
  }, []);

  const handleNewSession = useCallback((_sessionId: string, cwd: string) => {
    setSelectedSession(null);
    setNewSessionCwd(cwd);
    setInitialSessionRestored(true);
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setSystemPromptLoading(false);
    setActiveTopPanel(null);
    if (isMobile) {
      setSidebarOpen(false);
      requestAnimationFrame(() => chatInputRef.current?.focus());
    }
    router.replace("/", { scroll: false });
  }, [router, isMobile]);

  // Global keyboard shortcuts (handles Esc, Ctrl+Alt+N etc.)
  useGlobalKeyboardShortcuts({
    onNewSession: (cwd: string) => handleNewSession(`kb-${Date.now()}`, cwd),
    activeCwd,
  });

  // Called by ChatWindow when a new session gets its real id from pi
  const handleSessionCreated = useCallback((session: SessionInfo) => {
    setNewSessionCwd(null);
    setSelectedSession(session);
    setRefreshKey((k) => k + 1);
    hydrateSelectedSession(session.id);
    router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
  }, [router, hydrateSelectedSession]);

  const handleAgentEnd = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);
    if (document.visibilityState !== "hidden" || !("Notification" in window)) return;

    const targetSession = selectedSession;
    const notify = () => {
      showCompletionNotification(
        targetSession?.name ?? t("appShell.sessionComplete"),
        t("appShell.taskFinished"),
        () => {
          window.focus();
          if (targetSession) handleSelectSession(targetSession);
        },
      );
    };
    if (Notification.permission === "granted") notify();
    else if (Notification.permission === "default") {
      void Notification.requestPermission().then((permission) => { if (permission === "granted") notify(); });
    }
  }, [handleSelectSession, selectedSession, t]);
  // Chat event actions of the "notification" type fire server-side (even with
  // no tab open); the running stream relays the frame here. Clicking the
  // notification selects the originating session (fetched by id, like the
  // file-mention handler above).
  const handleChatEventAction = useCallback(
    (frame: { sessionId: string; title: string; message: string }) => {
      if (!frame.sessionId || !("Notification" in window)) return;
      const notify = () => {
        showBrowserNotification(frame.title, frame.message, () => {
          window.focus();
          void fetch(`/api/sessions/${encodeURIComponent(frame.sessionId)}`)
            .then((res) => (res.ok ? (res.json() as Promise<SessionInfo>) : null))
            .then((info) => {
              if (info) handleSelectSession(info);
            })
            .catch(() => {});
        });
      };
      if (Notification.permission === "granted") notify();
      else if (Notification.permission === "default") {
        void Notification.requestPermission().then((permission) => { if (permission === "granted") notify(); });
      }
    },
    [handleSelectSession],
  );


  const handleAutoName = useCallback(async () => {
    const sessionId = selectedSession?.id;
    if (!sessionId || autoNameStatus.kind === "naming") return;
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setActiveTopPanel(null);
    setAutoNameStatus({ kind: "naming" });

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/auto-name`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as { title?: string; error?: string; code?: string };
      if (!response.ok || !body.title) {
        throw new Error(body.error || body.code ? formatApiError(body) : `HTTP ${response.status}`);
      }

      const title = body.title.trim();
      setRefreshKey((key) => key + 1);
      if (activeSessionIdRef.current !== sessionId) return;
      setSelectedSession((current) => current?.id === sessionId ? { ...current, name: title } : current);
      setSessionStats((current) => current?.sessionId === sessionId ? { ...current, sessionName: title } : current);
      setAutoNameStatus({ kind: "success" });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 1800);
    } catch (error) {
      if (activeSessionIdRef.current !== sessionId) return;
      const message = error instanceof Error ? error.message : String(error);
      setAutoNameStatus({ kind: "error", message });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 5000);
    }
  }, [autoNameStatus.kind, selectedSession?.id]);

  useEffect(() => {
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setAutoNameStatus({ kind: "idle" });
  }, [selectedSession?.id]);

  const handleExplorerRefresh = useCallback(() => {
    setExplorerRefreshing(true);
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  const handleExplorerRefreshDone = useCallback(() => {
    setExplorerRefreshing(false);
  }, []);

  const handleSessionForked = useCallback((newSessionId: string) => {
    setRefreshKey((k) => k + 1);
    setSessionKey((k) => k + 1);
    setNewSessionCwd(null);
    setSelectedSession((prev) => ({
      ...(prev ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
      id: newSessionId,
    }));
    hydrateSelectedSession(newSessionId);
    router.replace(`?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
  }, [router, hydrateSelectedSession]);

  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
  }, []);

  const handleSessionDeleted = useCallback((sessionId: string) => {
    setRefreshKey((k) => k + 1);
    if (selectedSession?.id === sessionId) {
      const cwd = selectedSession.cwd;
      setSelectedSession(null);
      setNewSessionCwd(cwd ?? null);
      setSessionKey((k) => k + 1);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setSystemPrompt(null);
      setActiveTopPanel(null);
      router.replace("/", { scroll: false });
    }
  }, [selectedSession, router]);
  const handleArchiveRestored = useCallback(async (sessionId: string) => {
    setArchiveBrowserOpen(false);
    publishSessionsChanged([sessionId]);
    setRefreshKey((k) => k + 1);

    const selectRestoredSession = async (attemptsLeft = 5): Promise<void> => {
      try {
        const res = await fetch("/api/sessions");
        if (res.ok) {
          const data = (await res.json()) as { sessions?: SessionInfo[] };
          const found = data.sessions?.find((s) => s.id === sessionId);
          if (found) {
            handleSelectSession(found, false);
            return;
          }
        }
      } catch {
        // network error / abort
      }

      if (attemptsLeft > 0) {
        setTimeout(() => void selectRestoredSession(attemptsLeft - 1), 300);
      } else {
        router.replace(`?session=${encodeURIComponent(sessionId)}`, { scroll: false });
      }
    };

    void selectRestoredSession();
  }, [handleSelectSession, router]);

  const handleOpenFile = useCallback((filePath: string, fileName: string, sourceSessionId?: string | null) => {
    const tabId = `file:${filePath}`;
    setFileTabs((prev) => {
      const existing = prev.find((t) => t.id === tabId);
      if (!existing) return [...prev, { id: tabId, label: fileName, filePath, sourceSessionId }];
      if (!sourceSessionId || existing.sourceSessionId === sourceSessionId) return prev;
      return prev.map((t) => t.id === tabId ? { ...t, sourceSessionId } : t);
    });
    setActiveFileTabId(tabId);
    setWorkbenchRequestedView({ view: "files", nonce: Date.now() });
    setRightPanelOpen(true);
    // On mobile the file panel is full-screen; close the drawer so it shows.
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);

  const handleOpenLinkedFile = useCallback((filePath: string) => {
    handleOpenFile(filePath, getFileName(filePath), selectedSession?.id ?? null);
  }, [handleOpenFile, selectedSession?.id]);

  const handleOpenGitTab = useCallback(() => {
    setWorkbenchRequestedView({ view: "git", nonce: Date.now() });
    setRightPanelOpen(true);
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);

  // Open the session's omp plan document as a normal file in the sidebar
  // viewer: fetch the plan artifact (which authorizes its local/ dir), then
  // open the .md through the standard file pipeline (FileViewer renders
  // markdown in preview mode automatically).
  const handleOpenPlan = useCallback(async (sessionId: string) => {
    let planFile: string | null = null;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/plan`);
      const data = await res.json().catch(() => ({})) as { planFile?: string | null; plan?: string | null };
      planFile = typeof data.planFile === "string" ? data.planFile : null;
    } catch {
      // Fall through to the pill-less state; the chat pill only shows when a
      // plan document is known to exist, so this is a best-effort fetch.
    }
    if (planFile) {
      handleOpenFile(planFile, getFileName(planFile), sessionId);
    } else {
      setWorkbenchRequestedView({ view: "files", nonce: Date.now() });
      setRightPanelOpen(true);
      toast.info(t("chatWindow.planGenerating") || "Plan file is generating, please wait...");
    }
  }, [handleOpenFile, t]);

  const handleCloseFileTab = useCallback((tabId: string) => {
    // Compute everything from the current list outside the updaters: no side
    // effect inside a state updater, and no stale-closure read (the callback
    // is recreated whenever fileTabs changes, but a batched double-close
    // would still have read the pre-close list from the closure).
    const next = fileTabs.filter((t) => t.id !== tabId);
    setFileTabs(next);
    setActiveFileTabId((cur) => {
      if (cur !== tabId) return cur;
      return next.length > 0 ? next[next.length - 1].id : null;
    });
  }, [fileTabs]);

  const handleViewFullHistory = useCallback(() => {
    if (!selectedSession) return;
    window.open(
      `/api/sessions/${encodeURIComponent(selectedSession.id)}/export?inline=1`,
      "_blank",
      "noopener,noreferrer",
    );
  }, [selectedSession]);

  // A project selection is not an intent to start a conversation. Only an
  // explicit user action (or a validated ?cwd= launch request) sets this.
  const effectiveNewSessionCwd = newSessionCwd;
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat;

  const sidebarHistory = useSidebarHistory({
    active: isMobile && (showChat || Boolean(initialSessionId)),
    ready: mobileSidebarReady,
    sidebarOpen,
    setSidebarOpen,
    url: searchParams.toString(),
  });
  useEffect(() => {
    if (sidebarHistory.exitNeedsNativeBack) {
      toast.info(t("appShell.exitNativeBackTitle"), t("appShell.exitNativeBackDescription"));
    }
  }, [sidebarHistory.exitNeedsNativeBack, t]);

  useEffect(() => {
    if (initialSessionRestored) removeBootSkeleton({ fade: true });
  }, [initialSessionRestored]);

  useEffect(() => {
    if (!initialSessionRestored) return;
    (window as { ompWebDesktop?: { startupStage?: (stage: string) => void } }).ompWebDesktop?.startupStage?.("session_interactive");
  }, [initialSessionRestored]);

  const activeCwdName = activeCwd ? getFileName(activeCwd) || activeCwd : null;
  const windowTitle = activeCwdName ? `${activeCwdName} - omp web` : "omp web";
  // Probe whether the active workspace is a git repository so the GitGraph
  // button can be disabled (with an explanatory tooltip) when it is not.
  // The probe runs whenever the resolved cwd changes; the latest result wins.
  const gitProbeCwd = activeCwd ?? selectedSession?.cwd ?? newSessionCwd;
  useEffect(() => {
    if (!gitProbeCwd) {
      setGitWorkspace(null);
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams({ cwd: gitProbeCwd });
    fetch(`/api/git/status?${params.toString()}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        setGitWorkspace(Boolean((data as { isGitRepository?: boolean }).isGitRepository));
      })
      .catch(() => {
        if (!cancelled) setGitWorkspace(false);
      });
    return () => {
      cancelled = true;
    };
  }, [gitProbeCwd]);

  useEffect(() => {
    const syncWindowTitle = () => {
      if (document.title !== windowTitle) document.title = windowTitle;
    };

    syncWindowTitle();
    const observer = new MutationObserver(syncWindowTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [windowTitle]);

  // The sidebar's SSE (SessionSidebar) reports a server restart under us via
  // onServerRestarted (boot-epoch mismatch). Memoized so its identity is stable
  // across renders: the sidebar lists it as an effect dependency, so a fresh
  // identity every render would tear down and reconnect /api/agent/running/events
  // on every AppShell re-render (the "close notice -> GET running/events ->
  // GET app-update -> notice re-pops" loop). lastNoticeBootRef latches the boot
  // we already surfaced for, so a same-boot reconnect does not re-pop a
  // dismissed notice; only a genuinely new boot (new epoch) re-arms it.
  const lastNoticeBootRef = useRef<number | null>(null);
  // True when the rebuild reaper's refresh frame (the authoritative "this boot
  // is a rebuild" signal) has arrived but the boot-epoch notice has not yet
  // resolved. The server_boot path reads wasUiUpdated() before the reaper's
  // refresh POST lands, so without this latch the notice would stay plain
  // ("OmpWeb started") even though a new bundle is deployed.
  const pendingUpdatedRef = useRef(false);
  const handleServerRestarted = useCallback(() => {
    if (!isUpdateNoticeEnabled()) return;
    void fetch("/api/app-update")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { startedAt?: number; updated?: boolean } | null) => {
        const startedAt = typeof data?.startedAt === "number" ? data.startedAt : 0;
        if (startedAt && lastNoticeBootRef.current !== startedAt) {
          lastNoticeBootRef.current = startedAt;
          // OR the fetched flag with the pending refresh frame so a refresh that
          // arrived before this fetch resolves still upgrades the notice.
          const isUpdate = Boolean(data?.updated) || pendingUpdatedRef.current;
          pendingUpdatedRef.current = false;
          setStartedNoticeIsUpdate(isUpdate);
          setStartedNoticeVisible(true);
          markSeenStartedAt(startedAt);
        }
      })
      .catch(() => {
        // Restart detected but the update endpoint was unreachable. Surface a
        // plain notice only if we have not already surfaced this boot.
        if (lastNoticeBootRef.current !== null) return;
        setStartedNoticeIsUpdate(pendingUpdatedRef.current);
        pendingUpdatedRef.current = false;
        setStartedNoticeVisible(true);
      });
  }, []);
  // Fired by the sidebar when the rebuild reaper verifies the fresh bundle and
  // broadcasts a UI refresh over SSE. This is the authoritative "rebuild" signal
  // and (unlike the boot-epoch fetch) it reaches the already-reconnected tab, so
  // it guarantees the notice carries the "Refresh page" button even when the
  // fetch resolved before the reaper's refresh POST landed.
  const handleUiUpdated = useCallback(() => {
    if (!isUpdateNoticeEnabled()) return;
    if (startedNoticeVisible) {
      setStartedNoticeIsUpdate(true);
    } else if (lastNoticeBootRef.current === null) {
      // Not yet surfaced for this boot (the restart fetch is still in flight or
      // has not fired) — remember it and let the notice carry "updated" when it
      // resolves. A dismissed notice (lastNoticeBootRef set) stays dismissed.
      pendingUpdatedRef.current = true;
    }
  }, [startedNoticeVisible]);

  const sidebarContent = (
    <>
      <CommandPalette
        onSelectSession={handleSelectSession}
        onNewSession={() => handleNewSession(`palette-${Date.now()}`, activeCwd ?? "")}
        currentModel={null}
      />
      <SessionSidebar
        selectedSessionId={selectedSession?.id ?? null}
        optimisticSession={selectedSession?.path === "" ? selectedSession : null}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        initialSessionId={initialSessionId}
        skipInitialProjectSelection={initialNavigation.requestedCwd !== null}
        onInitialRestoreDone={handleInitialRestoreDone}
        refreshKey={refreshKey}
        onSessionDeleted={handleSessionDeleted}
        selectedCwd={selectedSession?.cwd ?? newSessionCwd ?? null}
        onCwdChange={handleCwdChange}
        onWorkspaceOptionsChange={handleWorkspaceOptionsChange}
        addProjectOpen={addProjectOpen}
        setAddProjectOpen={setAddProjectOpen}
        onOpenFile={handleOpenFile}
        explorerRefreshKey={explorerRefreshKey}
        onExplorerRefresh={handleExplorerRefresh}
        explorerRefreshing={explorerRefreshing}
        onExplorerRefreshDone={handleExplorerRefreshDone}
        onAtMention={handleAtMention}
        onAtMentions={handleAtMentions}
        onServerRestarted={handleServerRestarted}
        onUiUpdated={handleUiUpdated}
        onChatEventAction={handleChatEventAction}
        onOpenSettings={() => setSettingsTab("general")}
        onOpenGitGraph={handleOpenGitGraph}
        onOpenRemote={() => setSettingsTab("remote")}
        onOpenArchive={() => setArchiveBrowserOpen(true)}
        updateAvailable={appUpdateAvailable || ompUpdateAvailable}
        settingsOpen={settingsTab !== null}
        showSessionGitStats={sessionGitStatsVisible}
      />
    </>
  );

  // Panel toggle helpers. When the panels are swapped, the file workbench
  // docks left (toggle at the top-left of the top bar) and the session
  // sidebar docks right (toggle at the top-right edge of the top bar).
  const toggleFilePanel = () => {
    setRightPanelOpen((v) => {
      const next = !v;
      if (next && fileTabs.length > 0) {
        setWorkbenchRequestedView({ view: "files", nonce: Date.now() });
      }
      return next;
    });
  };
  const fileToggleIcon = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1={panelsSwappedActive ? 9 : 15} y1="3" x2={panelsSwappedActive ? 9 : 15} y2="21" />
    </svg>
  );
  const sidebarToggleIcon = sidebarOpen
    ? (panelsSwappedActive
        ? <PanelRight size={16} strokeWidth={1.8} aria-hidden="true" />
        : <PanelLeft size={16} strokeWidth={1.8} aria-hidden="true" />)
    : <Menu size={16} strokeWidth={1.8} aria-hidden="true" />;

  return (
    <>
    <TooltipProvider delay={400} closeDelay={50}>
    <ToastProvider>
    <ConfirmDialog
      open={sidebarHistory.exitConfirmationOpen}
      onOpenChange={(open) => { if (!open) sidebarHistory.cancelExit(); }}
      title={t("appShell.exitTitle")}
      description={t("appShell.exitDescription")}
      confirmLabel={t("appShell.exitLeave")}
      cancelLabel={t("appShell.exitStay")}
      danger
      onConfirm={sidebarHistory.leave}
    />
    <style>{`
      @keyframes session-info-pop {
        0% {
          opacity: 0;
          transform: translateY(-24px);
        }
        100% {
          opacity: 1;
          transform: translateY(0);
        }
      }
      @keyframes session-info-light-wash {
        0% {
          opacity: 0;
          transform: translateX(-110%) skewX(-16deg);
        }
        24% {
          opacity: 0.42;
        }
        100% {
          opacity: 0;
          transform: translateX(115%) skewX(-16deg);
        }
      }
      .session-info-popover {
        position: relative;
        overflow: visible;
        transform-origin: top right;
        animation: session-info-pop var(--dur-slow) var(--ease-out-warm) both;
        will-change: transform, opacity;
      }
      .session-info-popover::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 44%;
        pointer-events: none;
        background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 24%, transparent), transparent);
        animation: session-info-light-wash var(--dur-slow) var(--ease-out-warm) both;
      }
      @media (prefers-reduced-motion: reduce) {
        .session-info-popover,
        .session-info-popover::after {
          animation: none;
        }
      }
      @media (max-width: 640px) {
        .sidebar-overlay-backdrop.sidebar-mobile-pending {
          opacity: 0 !important;
          pointer-events: none !important;
        }
        .sidebar-container.sidebar-mobile-pending.sidebar-open {
          transform: translateX(-100%);
          box-shadow: none;
        }
      }
    `}</style>
    <a href="#main-content" className="skip-link">{t("appShell.skipToContent")}</a>
    <div className={panelsSwappedActive ? "shell-panels-swapped" : undefined} style={{ display: "flex", height: "100dvh", overflow: "hidden", background: "var(--bg)" }}>
      {/* Mobile overlay backdrop */}
      <div
        className={`sidebar-overlay-backdrop${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
        onClick={() => setSidebarOpen(false)}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 199,
          background: "color-mix(in srgb, var(--text) 28%, transparent)",
          opacity: sidebarOpen ? 1 : 0,
          pointerEvents: sidebarOpen ? "auto" : "none",
          transition: "opacity var(--dur-slow) var(--ease-out-warm)",
        }}
      />

      {/* Left sidebar */}
      <nav
        aria-label={t("projects.heading")}
        ref={sidebarContainerRef}
        className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${mobileSidebarReady ? "" : " sidebar-mobile-pending"}${sidebarResizing ? " sidebar-resizing" : ""}`}
        aria-hidden={mobileSidebarReady && !sidebarOpen ? true : undefined}
        inert={mobileSidebarReady && !sidebarOpen ? true : undefined}
        style={{
          background: "var(--bg-panel)",
          borderRight: panelsSwappedActive ? "none" : "1px solid var(--border)",
          borderLeft: panelsSwappedActive ? "1px solid var(--border)" : "none",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          zIndex: 200,
          // Desktop-only: the width is user-adjustable via the resize handle.
          ...(!isMobile ? { "--sidebar-width": `${sidebarWidth}px` } : {}),
        }}
      >
        {sidebarContent}
      </nav>

      {/* Resize handle — desktop only, hidden while the sidebar is closed */}
      {!isMobile && sidebarOpen && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("appShell.resizeSidebar")}
          tabIndex={0}
          onMouseDown={handleSidebarResizeStart}
          onDoubleClick={resetSidebarWidth}
          onKeyDown={handleSidebarResizeKey}
          title={t("appShell.resizeSidebarTitle")}
          style={{
            width: 5,
            flexShrink: 0,
            marginLeft: panelsSwappedActive ? 0 : -5,
            marginRight: panelsSwappedActive ? -5 : 0,
            cursor: "col-resize",
            background: "transparent",
            zIndex: 205,
            outline: "none",
            transition: "background var(--dur-fast) var(--ease-out-warm)",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 35%, transparent)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          onFocus={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 35%, transparent)"; }}
          onBlur={(e) => { e.currentTarget.style.background = "transparent"; }}
        />
      )}

      {/* Center: chat */}
      <main id="main-content" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0, minHeight: 0 }}>
        {ompMissing && !ompMissingDismissed && (
          <div role="alert" style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 14px", background: "color-mix(in srgb, var(--status-warning) 12%, var(--bg-panel))", borderBottom: "1px solid color-mix(in srgb, var(--status-warning) 35%, var(--border))", fontSize: "calc(12px * var(--ui-font-scale-lg, 1))", color: "var(--text)", flexShrink: 0 }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              {t("appShell.ompMissing")}
            </span>
            <button type="button" className="shell-toolbar-btn ui-focus-ring" title={t("appShell.ompSetup")} aria-label={t("appShell.ompSetup")} onClick={() => setOmpSetupOpen(true)} style={{ height: 26, padding: "0 9px", borderRadius: 6, fontSize: "calc(11px * var(--ui-font-scale-sm, 1))", fontWeight: 650 }}>
              {t("appShell.ompSetup")}
            </button>
            <button type="button" className="shell-toolbar-btn ui-focus-ring" title={t("appShell.dismiss")} aria-label={t("appShell.dismiss")} onClick={() => setOmpMissingDismissed(true)} style={{ width: 24, height: 24, borderRadius: 6 }}>
              <X size={13} strokeWidth={2} />
            </button>
          </div>
        )}
        <OmpSetupWizard
          open={ompSetupOpen}
          onOpenChange={setOmpSetupOpen}
          onDetected={() => {
            setOmpMissing(false);
            setOmpSetupOpen(false);
          }}
        />
        {/* Top bar: compact icon-led control bar */}
        <div ref={topBarRef} className="shell-topbar" style={{ position: "relative", display: "flex", alignItems: "center", flexShrink: 0, borderBottom: "1px solid var(--border)", height: isMobile ? 44 : 36, background: "var(--bg-panel)" }}>
        {/* Utility group: sidebar, theme, language */}
        <div style={{ display: "flex", alignItems: "center", gap: 4, height: "100%", paddingLeft: isMobile ? 4 : 8 }}>
          {panelsSwappedActive && (
            <button
              type="button"
              onClick={toggleFilePanel}
              title={rightPanelOpen ? t("appShell.hideFilePanel") : t("appShell.showFilePanel")}
              aria-label={rightPanelOpen ? t("appShell.hideFilePanel") : t("appShell.showFilePanel")}
              className="shell-toolbar-btn ui-focus-ring"
            >
              {fileToggleIcon}
            </button>
          )}
          {!panelsSwappedActive && (
            <button
              onClick={handleSidebarToggle}
              title={sidebarOpen ? t("appShell.hideSidebar") : t("appShell.showSidebar")}
              aria-label={sidebarOpen ? t("appShell.hideSidebar") : t("appShell.showSidebar")}
              className="shell-toolbar-btn ui-focus-ring"
            >
              {sidebarToggleIcon}
            </button>
          )}
          {/* Touch entry for the command palette (mobile has no ⌘K/Ctrl+K) */}
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent("omp-open-palette"))}
            title={t("appShell.commandPalette")}
            aria-label={t("appShell.commandPalette")}
            className="shell-toolbar-btn ui-focus-ring"
          >
            <Search size={16} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <ThemePicker />
          <button
            type="button"
            onClick={toggleTerminalPanel}
            title={terminalOpen ? (t("appShell.hideTerminal") || "Hide Terminal") : (t("appShell.toggleTerminal") || "Open Terminal")}
            aria-label={t("appShell.toggleTerminal") || "Toggle Terminal"}
            aria-pressed={terminalOpen}
            className="shell-toolbar-btn ui-focus-ring"
            style={{
              color: terminalOpen ? "var(--accent)" : undefined,
              background: terminalOpen ? "var(--bg-selected)" : undefined,
            }}
          >
            <TerminalSquare size={16} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <LanguageSwitcher />
        </div>
        {showChat && (
          <>
            <div className="shell-toolbar-divider" aria-hidden="true" />
            {/* Session controls: history, generate title, branches, system */}
            <div style={{ display: "flex", alignItems: "center", gap: 4, height: "100%" }}>
              <button
                onClick={handleViewFullHistory}
                disabled={!selectedSession}
                title={selectedSession ? t("appShell.fullHistory") : t("appShell.fullHistoryUnavailable")}
                aria-label={t("appShell.fullHistory")}
                className="shell-toolbar-btn ui-focus-ring"
              >
                <History size={16} strokeWidth={1.8} aria-hidden="true" />
              </button>
              <Tooltip content={gitWorkspace === false ? t("appShell.githubStatusNotGit") : t("appShell.githubStatus")} side="bottom">
                <button
                  type="button"
                  // aria-disabled (not the native disabled attribute): a natively
                  // disabled button fires no mouse events, so the Tooltip could
                  // never open. This keeps the button hoverable while still
                  // rendering the disabled (grayed, default-cursor) treatment.
                  onClick={() => { if (gitWorkspace === true) handleOpenGitGraph(); }}
                  aria-disabled={gitWorkspace !== true}
                  aria-label={t("appShell.githubStatus")}
                  aria-haspopup="dialog"
                  className="shell-toolbar-btn ui-focus-ring"
                  data-git-graph-trigger
                >
                  <GitBranch size={16} strokeWidth={1.8} aria-hidden="true" />
                </button>
              </Tooltip>
              <BranchNavigator
                tree={branchTree}
                activeLeafId={branchActiveLeafId}
                onLeafChange={handleBranchLeafChange}
                inline
                containerRef={topBarRef}
                open={activeTopPanel === "branches"}
                onToggle={() => toggleTopPanel("branches")}
                hasSession
              />
              <button
                ref={systemBtnRef}
                onClick={handleSystemPromptToggle}
                title={t("appShell.system")}
                aria-label={t("appShell.system")}
                aria-pressed={activeTopPanel === "system"}
                className="shell-toolbar-btn ui-focus-ring"
              >
                <Terminal size={16} strokeWidth={1.8} aria-hidden="true" style={{ color: systemPrompt ? "var(--accent)" : undefined }} />
              </button>
            </div>
          </>
        )}
        {panelsSwappedActive && (
          <button
            onClick={handleSidebarToggle}
            title={sidebarOpen ? t("appShell.hideSidebar") : t("appShell.showSidebar")}
            aria-label={sidebarOpen ? t("appShell.hideSidebar") : t("appShell.showSidebar")}
            className="shell-toolbar-btn ui-focus-ring"
            style={{ marginLeft: "auto" }}
          >
            {sidebarToggleIcon}
          </button>
        )}

          {/* Center Zone: Workspace & Session Breadcrumb + Auto-name action */}
          {showChat && (() => {
            const effectiveProject = selectedSession?.projectRoot ?? selectedSession?.cwd ?? activeCwd ?? "";
            const sessionTitle = selectedSession?.name || selectedSession?.firstMessage || t("sessionSidebar.new");
            const hasMessages = Boolean(
              selectedSession
              && (sessionStats?.userMessages ?? selectedSession.messageCount) > 0,
            );
            const wandDisabled = !selectedSession || !hasMessages || autoNameStatus.kind === "naming";
            const wandIsSuccess = autoNameStatus.kind === "success";
            const wandIsError = autoNameStatus.kind === "error";
            const wandLabel = autoNameStatus.kind === "naming"
              ? t("appShell.generating")
              : wandIsSuccess
                ? t("appShell.titleUpdated")
                : wandIsError
                  ? t("appShell.generationFailed")
                  : t("appShell.generateTitle");
            const wandTooltip = !selectedSession
              ? t("appShell.titleGenUnavailable")
              : !hasMessages
                ? t("appShell.titleGenNeedsMessage")
                : wandIsError
                  ? autoNameStatus.message
                  : t("appShell.generateSessionTitle");

            return (
              <div
                className="shell-topbar-center"
                style={{
                  minWidth: 0,
                  containerType: "inline-size",
                  containerName: "breadcrumb",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <div
                  className="shell-topbar-breadcrumb"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    height: 26,
                    padding: "0 8px",
                    borderRadius: "var(--radius-control)",
                    background: "var(--bg-subtle)",
                    border: "1px solid var(--border)",
                    fontSize: "calc(11px * var(--ui-font-scale-sm, 1))",
                    color: "var(--text-muted)",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                    maxWidth: "min(400px, 30vw)",
                    flexShrink: 1,
                  }}
                >
                  {effectiveProject ? (
                    <>
                      <Folder size={12} strokeWidth={1.8} style={{ opacity: 0.6, flexShrink: 0 }} aria-hidden="true" />
                      <span
                        style={{
                          fontWeight: 600,
                          color: "var(--text)",
                          flexShrink: 0,
                          maxWidth: 120,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={effectiveProject}
                      >
                        {getFileName(effectiveProject)}
                      </span>
                      <span style={{ color: "var(--text-dim)", flexShrink: 0, opacity: 0.5 }}>/</span>
                    </>
                  ) : null}
                  <span
                    style={{
                      color: "var(--text)",
                      fontWeight: 500,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      minWidth: 0,
                    }}
                    title={sessionTitle}
                  >
                    {sessionTitle}
                  </span>
                  {selectedSession && (
                    <button
                      type="button"
                      onClick={() => void handleAutoName()}
                      disabled={wandDisabled}
                      title={wandTooltip}
                      aria-label={wandLabel}
                      className="ui-focus-ring"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 18,
                        height: 18,
                        padding: 0,
                        marginLeft: 2,
                        border: "none",
                        borderRadius: 4,
                        background: "transparent",
                        color: wandIsSuccess ? "var(--accent)" : wandIsError ? "var(--status-error)" : "var(--text-dim)",
                        cursor: wandDisabled ? "default" : "pointer",
                        flexShrink: 0,
                        opacity: autoNameStatus.kind === "naming" ? 1 : wandDisabled ? 0.35 : 0.75,
                        transition: "color var(--dur-fast), opacity var(--dur-fast), background var(--dur-fast)",
                      }}
                      onMouseEnter={(e) => {
                        if (wandDisabled) return;
                        e.currentTarget.style.background = "var(--bg-hover)";
                        e.currentTarget.style.opacity = "1";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "transparent";
                        e.currentTarget.style.opacity = String(autoNameStatus.kind === "naming" ? 1 : wandDisabled ? 0.35 : 0.75);
                      }}
                    >
                      {autoNameStatus.kind === "naming" ? (
                        <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                          <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                      ) : wandIsSuccess ? (
                        <Check size={12} strokeWidth={2} aria-hidden="true" />
                      ) : (
                        <Wand2 size={12} strokeWidth={1.8} aria-hidden="true" />
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })()}
          {/* Top panel dropdown — shared, only one active at a time. The
              branch panel renders inside BranchNavigator itself; never mount
              an empty fixed layer for it (it would sit over the top-bar
              region and swallow clicks). */}
          {activeTopPanel === "system" && topPanelPos && (
            <div
              data-top-panel
              className="dropdown-surface top-panel-animated"
              style={{
              position: "fixed",
              top: topPanelPos.top,
              // Right-aligned, width auto based on content — prevents cut-off and lets the window resize with its content
              // Keep this surface entirely in the chat column.  The file
              // preview is a flex sibling, so the right inset must match its
              // rendered (clamped) width or the popover will cover the
              // preview on narrow windows.
              right: panelsSwappedActive ? "auto" : `calc(${rightPanelInset} + 12px)`,
              left: panelsSwappedActive ? `calc(${rightPanelInset} + 12px)` : "auto",
              minWidth: isMobile ? 0 : 360,
              width: "auto",
              maxWidth: "min(680px, calc(100vw - 24px))",
              maxHeight: `min(70vh, calc(100dvh - ${topPanelPos.top}px - 12px))`,
              overflow: "hidden",
              overflowX: "hidden",
              zIndex: 500,
              }}
            >
              {activeTopPanel === "system" && (
                <div style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                }}>
                  {systemPrompt ? (
                    <div style={{
                      maxHeight: "min(600px, 75vh)",
                      overflowY: "auto",
                      padding: "12px 16px",
                      color: "var(--text-muted)",
                      fontSize: "calc(12px * var(--ui-font-scale-lg, 1))",
                      lineHeight: 1.6,
                      whiteSpace: "pre-wrap",
                      fontFamily: "var(--font-mono)",
                    }}>
                      {systemPrompt}
                    </div>
                  ) : systemPrompt === "" ? (
                    <div style={{ padding: "10px 16px", fontSize: "calc(12px * var(--ui-font-scale-lg, 1))", color: "var(--text-muted)", fontStyle: "italic" }}>
                      {t("appShell.systemPromptEmpty")}
                    </div>
                  ) : (
                    <div style={{ padding: "10px 16px", fontSize: "calc(12px * var(--ui-font-scale-lg, 1))", color: "var(--text-muted)", fontStyle: "italic" }}>
                      {systemPromptLoading ? t("appShell.systemPromptLoading") : t("appShell.systemPromptLoadHint")}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

        </div>

        {/* Backend health banner: appears only when the omp backend is
            abnormal, with refresh/restart actions + inline diagnostics. */}
        <BackendHealthBanner />
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          {showChat ? (
            <ChatWindow
              key={sessionKey}
              session={selectedSession}
              newSessionCwd={effectiveNewSessionCwd}
              newSessionWorkspace={effectiveNewSessionCwd && (
                <WorkspaceSelector
                  projects={workspaceOptions.projects}
                  selectedPath={effectiveNewSessionCwd}
                  onSelect={(cwd) => {
                    if (cwd === effectiveNewSessionCwd) return;
                    armCwdSuppression(cwd);
                    setActiveCwd(cwd);
                    handleNewSession("", cwd);
                  }}
                  onAdd={() => setAddProjectOpen(true)}
                />
              )}
              onAgentEnd={handleAgentEnd}
              onSessionCreated={handleSessionCreated}
              onSessionForked={handleSessionForked}
              modelsRefreshKey={modelsRefreshKey}
              chatInputRef={chatInputRef}
              onOpenFile={handleOpenLinkedFile}
              onBranchDataChange={handleBranchDataChange}
              onSystemPromptChange={handleSystemPromptChange}
              onSystemPromptLoaderChange={handleSystemPromptLoaderChange}
              onSessionStatsChange={handleSessionStatsChange}
              sessionInfoButtonVisible={sessionInfoButtonVisible}
              showJumpToBottomButton={showJumpToBottomButton}
              onOpenGitTab={handleOpenGitTab}
              onSubagentsChange={setSubagents}
              toolCallsDefaultCollapsed={toolCallsDefaultCollapsed}
              thinkingDisplayMode={thinkingDisplayMode}
              thinkingAutoFollow={thinkingAutoFollowEnabled}
              messageActionsVisible={messageActionsVisible}
              processDetailsAutoExpand={processDetailsAutoExpand}
              messageTimeFormat={messageTimeFormat}
              onOpenPlan={() => selectedSession && handleOpenPlan(selectedSession.id)}
              onSelectSubagent={handleSubagentSelect}
            />
          ) : initialCwdStatus === "validating" ? (
            <div
              role="status"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
              <div style={{ fontSize: "calc(14px * var(--ui-font-scale-lg, 1))", color: "var(--text)" }}>{t("appShell.openingWorkspace")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: "calc(12px * var(--ui-font-scale-lg, 1))" }}>
                {initialNavigation.requestedCwd}
              </div>
            </div>
          ) : initialCwdStatus === "error" ? (
            <div
              role="alert"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
              <div style={{ fontSize: "calc(14px * var(--ui-font-scale-lg, 1))", color: "var(--status-error)" }}>{t("appShell.unableToOpenWorkspace")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: "calc(12px * var(--ui-font-scale-lg, 1))" }}>
                {initialNavigation.requestedCwd}
              </div>
              <div style={{ maxWidth: 720, fontSize: "calc(12px * var(--ui-font-scale-lg, 1))" }}>{initialCwdError}</div>
            </div>
          ) : !showPlaceholder ? (
            <PanelLoadingFallback />
          ) : (
            activeCwd ? (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: "calc(16px * var(--ui-font-scale-lg, 1))" }}>
                <span className="display-serif">{t("appShell.selectSessionHint")}</span>
              </div>
            ) : (
              <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "flex-start", gap: 8, userSelect: "none", pointerEvents: "none" }}>
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0 }}>
                  <line x1="20" y1="12" x2="4" y2="12" /><polyline points="10 6 4 12 10 18" />
                </svg>
                <div>
                  <div className="display-serif" style={{ fontSize: "calc(20px * var(--ui-font-scale-lg, 1))", color: "var(--text)", marginBottom: 8 }}>{t("appShell.getStarted")}</div>
                  <div style={{ fontSize: "calc(12px * var(--ui-font-scale-lg, 1))", color: "var(--text-muted)", lineHeight: 1.8 }}>
                    <span style={{ color: "var(--text-dim)", marginRight: 6 }}>1.</span>{t("appShell.getStartedStep1")}<br />
                    <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>
                    {(() => {
                      // One translatable sentence; the {models} slot is rendered
                      // as the emphasized button name so word order stays free.
                      const [before, after] = t("appShell.getStartedStep2").split("{models}");
                      return (
                        <>
                          {before}
                          <strong style={{ color: "var(--text)" }}>{t("appShell.models")}</strong>
                          {after}
                        </>
                      );
                    })()}
                  </div>
                </div>
              </div>
            )
          )}
        </div>
        {/* Bottom terminal bar. It remains independent from the right
            workbench so the terminal always has a predictable home and its
            tab/PTY lifecycle is not tied to sidebar navigation. */}
        <div
          style={{
            display: terminalOpen ? "flex" : "none",
            flexDirection: "column",
            flexShrink: 0,
            borderTop: terminalOpen ? "1px solid var(--border)" : "none",
            background: "var(--bg)",
          }}
        >
          <TerminalTabs
            open={terminalOpen}
            onClose={() => setTerminalOpen(false)}
            cwd={terminalCwd ?? activeCwd ?? null}
          />
        </div>
      </main>

      {/* Native right workbench. It opens to a calm empty state and supports
          one explicit upper/lower split; terminal stays in the bottom bar. */}
        <div
          ref={rightPanelRef}
          className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}`}
          style={{
            display: "flex",
            flexDirection: "column",
            borderLeft: panelsSwappedActive ? "none" : (rightPanelOpen ? "1px solid var(--border)" : "none"),
            borderRight: panelsSwappedActive ? (rightPanelOpen ? "1px solid var(--border)" : "none") : "none",
            background: "var(--bg)",
            // Keep a readable chat column when the panel is resized.
            width: rightPanelOpen ? (isMobile ? "100%" : `${rightPanelWidth}px`) : 0,
            minWidth: rightPanelOpen ? (isMobile ? 0 : RIGHT_PANEL_MIN_WIDTH) : 0,
            maxWidth: rightPanelOpen && !isMobile ? "calc(100vw - 220px)" : undefined,
            position: "relative",
          }}
        >
          {rightPanelOpen && !isMobile && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t("rightPanel.resizeHandle") ?? "Resize workbench"}
              title={t("appShell.resizeSidebarTitle")}
              tabIndex={0}
              onMouseDown={handleRightPanelResizeStart}
              onDoubleClick={resetRightPanelWidth}
              onKeyDown={handleRightPanelResizeKey}
              style={{
                position: "absolute",
                left: panelsSwappedActive ? "auto" : 0,
                right: panelsSwappedActive ? 0 : "auto",
                top: 0,
                bottom: 0,
                width: 5,
                cursor: "col-resize",
                background: "transparent",
                zIndex: 205,
                outline: "none",
                transition: "background var(--dur-fast) var(--ease-out-warm)",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 35%, transparent)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              onFocus={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 35%, transparent)"; }}
              onBlur={(e) => { e.currentTarget.style.background = "transparent"; }}
            />
          )}
          <RightWorkbench
            requestedView={workbenchRequestedView}
            storageKey={selectedSession?.id ?? activeCwd ?? newSessionCwd ?? "new"}
            cwd={activeCwd ?? selectedSession?.cwd ?? newSessionCwd}
            files={(
              <PanelErrorBoundary title={t("rightPanel.files") ?? "Files"} unavailable={t("rightPanel.unavailable") ?? "is temporarily unavailable"} retryLabel={t("rightPanel.retry") ?? "Retry"}>
                <div style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                  <div style={{ display: "flex", alignItems: "center", flexShrink: 0, background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", height: 36 }}>
                    <div style={{ flex: 1, overflow: "hidden" }}>
                      <TabBar tabs={fileTabs} activeTabId={activeFileTabId ?? ""} onSelectTab={setActiveFileTabId} onCloseTab={handleCloseFileTab} />
                    </div>
                  </div>
                  <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
                    {/* The explorer stays mounted (toggled via display) so its
                        directory-browsing state survives opening/closing file
                        tabs — unmounting it on the last tab close reset
                        expandedPaths and collapsed every folder. */}
                    <div style={{ display: fileTabs.length > 0 ? "none" : "block", height: "100%", minHeight: 0 }}>
                      {activeCwd ? (
                        <FileExplorer cwd={activeCwd} refreshKey={explorerRefreshKey} onOpenFile={handleOpenFile} onAtMention={handleAtMention} onAtMentions={handleAtMentions} onRefreshDone={handleExplorerRefreshDone} />
                      ) : (
                        <div style={{ padding: 20, color: "var(--text-dim)", fontSize: "calc(12px * var(--ui-font-scale-lg, 1))", textAlign: "center" }}>{t("appShell.noActiveSession") ?? "Open a workspace to browse files."}</div>
                      )}
                    </div>
                    <div style={{ display: fileTabs.length > 0 ? "block" : "none", height: "100%", minHeight: 0 }}>
                      {fileTabs.map((tab) => (
                        <div key={tab.id} style={{ display: tab.id === activeFileTabId ? "block" : "none", height: "100%", minHeight: 0 }}>
                          <FileViewer filePath={tab.filePath} cwd={activeCwd ?? undefined} sourceSessionId={tab.sourceSessionId} gitRefreshKey={explorerRefreshKey} onMentionLines={tab.id === activeFileTabId && rightPanelOpen ? handleFileLineMention : undefined} onOpenFile={(filePath) => handleOpenFile(filePath, getFileName(filePath), tab.sourceSessionId)} active={tab.id === activeFileTabId && rightPanelOpen} />
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </PanelErrorBoundary>
            )}
            agents={(
              <PanelErrorBoundary title={t("rightPanel.agents") ?? "Agents"} unavailable={t("rightPanel.unavailable") ?? "is temporarily unavailable"} retryLabel={t("rightPanel.retry") ?? "Retry"}>
                {selectedSubagent ? <SubagentDetailPanel subagent={selectedSubagent} sessionId={selectedSession?.id ?? null} onBack={() => setSelectedSubagent(null)} /> : subagents ? <AgentsPanel subagents={subagents} onSelectSubagent={(subagent) => { setSelectedSubagent(subagent); setWorkbenchRequestedView({ view: "agents", nonce: Date.now() }); setRightPanelOpen(true); }} /> : <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: "calc(12px * var(--ui-font-scale-lg, 1))", textAlign: "center", padding: 24 }}>{t("appShell.noActiveSession") ?? "Open a session to see its agents."}</div>}
              </PanelErrorBoundary>
            )}
            onOpenFile={(filePath, fileName) => handleOpenFile(filePath, fileName, selectedSession?.id ?? null)}
          />
        </div>
      {/* File panel toggle — fixed at top-right; when the panels are swapped
          it moves inline to the top-left of the top bar instead. */}
      {!panelsSwappedActive && (
        <button
          onClick={toggleFilePanel}
          title={rightPanelOpen ? t("appShell.hideFilePanel") : t("appShell.showFilePanel")}
          aria-label={rightPanelOpen ? t("appShell.hideFilePanel") : t("appShell.showFilePanel")}
          style={{
            position: "fixed", top: 0, right: 0, zIndex: 300,
            display: "flex", alignItems: "center", justifyContent: "center",
            width: isMobile ? 44 : 36, height: isMobile ? 44 : 36, padding: 0,
            background: "var(--bg-panel)", border: "none", borderLeft: "1px solid var(--border)", borderBottom: "1px solid var(--border)",
            color: rightPanelOpen ? "var(--text)" : "var(--text-muted)",
            cursor: "pointer", transition: "color var(--dur-fast) var(--ease-out-warm)",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = rightPanelOpen ? "var(--text)" : "var(--text-muted)"; }}
        >
          {fileToggleIcon}
        </button>
      )}
    <GitGraphModal open={gitGraphOpen} onOpenChange={(open) => { if (!open) setGitGraphCwd(null); setGitGraphOpen(open); }} cwd={gitGraphCwd ?? activeCwd ?? selectedSession?.cwd ?? newSessionCwd} sizePercent={gitGraphModalSize} />
    {startedNoticeVisible && (
      <UpdateNoticeDialog ompVersion={ompVersion} isUpdate={startedNoticeIsUpdate} onClose={() => setStartedNoticeVisible(false)} />
    )}
    {settingsTab && <SettingsConfig activeTab={settingsTab} toolCallsDefaultCollapsed={toolCallsDefaultCollapsed} onToolCallsDefaultCollapsedChange={handleToolCallsDefaultCollapsedChange} thinkingDisplayMode={thinkingDisplayMode} onThinkingDisplayModeChange={handleThinkingDisplayModeChange} extendedThinkingBlock={extendedThinkingBlock} onExtendedThinkingBlockChange={handleExtendedThinkingBlockChange} extendedBlocks={extendedBlocks} onExtendedBlocksChange={handleExtendedBlocksChange} gitGraphModalSize={gitGraphModalSize} onGitGraphModalSizeChange={handleGitGraphModalSizeChange} sessionInfoButtonVisible={sessionInfoButtonVisible} onSessionInfoButtonChange={handleSessionInfoButtonChange} showJumpToBottomButton={showJumpToBottomButton} onShowJumpToBottomButtonChange={handleShowJumpToBottomButtonChange} toolOutputCapEnabled={toolOutputCapEnabled} onToolOutputCapChange={handleToolOutputCapChange} thinkingAutoFollowEnabled={thinkingAutoFollowEnabled} onThinkingAutoFollowChange={handleThinkingAutoFollowChange} messageActionsVisible={messageActionsVisible} onMessageActionsVisibleChange={handleMessageActionsVisibleChange} processDetailsAutoExpand={processDetailsAutoExpand} onProcessDetailsAutoExpandChange={handleProcessDetailsAutoExpandChange} messageTimeFormat={messageTimeFormat} onMessageTimeFormatChange={handleMessageTimeFormatChange} panelsSwapped={panelsSwapped} onPanelsSwappedChange={handlePanelsSwappedChange} sessionGitStatsVisible={sessionGitStatsVisible} onSessionGitStatsChange={handleSessionGitStatsChange} cwd={activeCwd ?? selectedSession?.cwd ?? newSessionCwd} sessionId={selectedSession?.id ?? null} onModelsSaved={() => setModelsRefreshKey((k) => k + 1)} onPluginsReloaded={() => setSessionKey((k) => k + 1)} onOmpUpdateAvailabilityChange={setOmpUpdateAvailable} onSelectTab={setSettingsTab} onClose={() => setSettingsTab(null)} />}
    <UsageDashboardModal
      open={usageDashboardOpen}
      onOpenChange={setUsageDashboardOpen}
      initialTab={usageDashboardTab}
      onOpenSessionFile={handleOpenSessionFromFile}
    />
    {archiveBrowserOpen && (
      <ArchiveBrowser
        open={archiveBrowserOpen}
        onClose={() => setArchiveBrowserOpen(false)}
        onRestored={handleArchiveRestored}
      />
    )}
    </div>
    </ToastProvider>
    </TooltipProvider>
    <DesktopUpdateBanner />
    </>
  );
}
