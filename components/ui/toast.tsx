"use client";
import { Tooltip } from "../ui/primitives";

/**
 * Warm-paper toast system on @base-ui/react Toast.
 *
 * Usage anywhere (React or not):
 *   import { toast } from "./ui/toast";
 *   toast.success("已保存"); toast.error("保存失败", "请重试");
 *   toast.info("..."); toast.success("任务完成");
 *
 * Mount <ToastProvider> once near the app root (AppShell).
 */
import { Toast } from "@base-ui/react/toast";
import { AlertCircle, Check, Info, X } from "lucide-react";
import { useRef, useState, useSyncExternalStore } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import type React from "react";

type ToastKind = "success" | "error" | "info";

interface ToastData {
  kind?: ToastKind;
  variant?: "update";
  /** Clamp the description to 2 lines; click the description to expand it. */
  clamp?: boolean;
  /** Whole-card action target (see Toaster): runs on card click, then closes. */
  onClick?: () => void;
}

interface ToastOptions {
  /** Adds the update-specific arrival/exit treatment. */
  variant?: "update";
  /** Clamp the description to 2 lines; click the description to expand it. */
  clamp?: boolean;
  /** Stable id for deduplication — same id will replace existing toast instead of stacking. */
  id?: string;
  /**
   * Wall-clock lifetime before the toast auto-dismisses. Defaults per kind:
   * success/info 2000ms, error 3500ms. Update banners (variant: "update")
   * stay until dismissed. Unlike the base-ui hover/focus timer, this uses a
   * plain setTimeout so an unfocused window or hover never leaves a toast
   * stuck on screen.
   */
  durationMs?: number;
  /**
   * Runs when the card itself is clicked (anywhere but its buttons, links and
   * expandable text), then closes the toast.
   */
  onClick?: () => void;
}

const manager = Toast.createToastManager<ToastData>();

// Default wall-clock lifetimes (ms). 6.5s keeps every notification readable:
// these are confirmations the user needs to actually register, so a 2s flash
// was too easy to miss. Errors share the same duration (no per-kind split).
const DEFAULT_DURATION_MS: Record<ToastKind, number> = {
  success: 6500,
  info: 6500,
  error: 6500,
};
// Backstop for the base-ui timer: it pauses on hover/window-blur, so without
// this the toast could linger indefinitely. 30s is far beyond any default.
const BASE_UI_BACKSTOP_MS = 30_000;
/** Auto-dismiss delay: an explicit `durationMs` (0 = sticky until dismissed)
 * wins over the per-kind default; update banners stay until dismissed. */
export function resolveToastTimeout(kind: ToastKind, options?: Pick<ToastOptions, "durationMs" | "variant">): number {
  if (options?.variant === "update") return 0;
  return options?.durationMs ?? DEFAULT_DURATION_MS[kind];
}

export const TOAST_HISTORY_LIMIT = 100;

export interface ToastHistoryEntry {
  id: string;
  kind: ToastKind;
  title: React.ReactNode;
  description?: React.ReactNode;
  clamp?: boolean;
  at: number;
  read: boolean;
}

let history: ToastHistoryEntry[] = [];
const historyListeners = new Set<() => void>();
function setHistory(next: ToastHistoryEntry[]) {
  history = next;
  for (const listener of historyListeners) listener();
}

let recordedCount = 0;

/** Recent toasts and OS notifications, newest first, kept in memory for the notification center. */
export const toastHistory = {
  subscribe(listener: () => void) {
    historyListeners.add(listener);
    return () => { historyListeners.delete(listener); };
  },
  get: () => history,
  /** Add an entry without showing a toast, e.g. for a notification already delivered by the OS. */
  record(kind: ToastKind, title: React.ReactNode, description?: React.ReactNode, options?: { id?: string; clamp?: boolean }) {
    const id = options?.id ?? `recorded-${++recordedCount}`;
    // A reused id replaces its toast on screen, so it replaces its history entry
    // too. It keeps its read state: re-announcing the same notice (e.g. an
    // update toast on every tab focus) must not re-badge it.
    const read = history.some((e) => e.id === id && e.read);
    const entry: ToastHistoryEntry = { id, kind, title, description, clamp: options?.clamp, at: Date.now(), read };
    setHistory([entry, ...history.filter((e) => e.id !== id)].slice(0, TOAST_HISTORY_LIMIT));
  },
  markAllRead: () => {
    if (history.some((e) => !e.read)) setHistory(history.map((e) => e.read ? e : { ...e, read: true }));
  },
  remove: (id: string) => setHistory(history.filter((entry) => entry.id !== id)),
  clear: () => setHistory([]),
};

export function useToastHistory(): ToastHistoryEntry[] {
  return useSyncExternalStore(toastHistory.subscribe, toastHistory.get, toastHistory.get);
}

const unreadCount = () => history.reduce((count, entry) => count + (entry.read ? 0 : 1), 0);
/** Unread entry count. A primitive snapshot, so callers re-render only when the count changes. */
export function useUnreadToastCount(): number {
  return useSyncExternalStore(toastHistory.subscribe, unreadCount, unreadCount);
}

function add(kind: ToastKind, title: React.ReactNode, description?: React.ReactNode, options?: ToastOptions) {
  const timeout = resolveToastTimeout(kind, options);
  const isUpdateBanner = options?.variant === "update";
  const id = manager.add({
    id: options?.id,
    title,
    description,
    type: kind,
    // update banners are interactive announcements: keep them until the user
    // dismisses (no base-ui auto timer). Everything else auto-dismisses on a
    // wall clock that hover/blur cannot pause.
    timeout,
    data: { kind, clamp: options?.clamp, variant: options?.variant, onClick: options?.onClick },
  });
  if (!isUpdateBanner) {
    // Force-close on a real timer: base-ui pauses its own countdown while the
    // toast is hovered or the window is blurred, which made toasts appear to
    // need a manual dismiss. This guarantees the configured lifetime.
    window.setTimeout(() => {
      manager.close(id);
    }, Math.min(timeout, BASE_UI_BACKSTOP_MS));
  }
  toastHistory.record(kind, title, description, { id, clamp: options?.clamp });
  return id;
}

export const toast = {
  success: (title: React.ReactNode, description?: React.ReactNode, options?: ToastOptions) =>
    add("success", title, description, options),
  error: (title: React.ReactNode, description?: React.ReactNode, options?: ToastOptions) =>
    add("error", title, description, options),
  info: (title: React.ReactNode, description?: React.ReactNode, options?: ToastOptions) =>
    add("info", title, description, options),
  close: (id?: string) => manager.close(id),
};

export function KindIcon({ kind }: { kind?: ToastKind }) {
  const common = { size: 13, strokeWidth: 2, style: { flexShrink: 0, marginTop: 2 } } as const;
  if (kind === "success") return <Check {...common} style={{ ...common.style, color: "var(--accent)" }} aria-hidden />;
  if (kind === "error") return <AlertCircle {...common} style={{ ...common.style, color: "var(--accent-strong)" }} aria-hidden />;
  return <Info {...common} style={{ ...common.style, color: "var(--text-muted)" }} aria-hidden />;
}

export const descriptionBaseStyle = {
  fontSize: "calc(12px * var(--ui-font-scale-lg, 1))",
  color: "var(--text-muted)",
  lineHeight: 1.5,
  marginTop: 2,
} as const;

/** Inline styles for a clamped description: 2-line ellipsis when collapsed, full content when expanded. */
export function clampDescriptionStyle(expanded: boolean): React.CSSProperties {
  return {
    ...descriptionBaseStyle,
    cursor: expanded ? "default" : "pointer",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    ...(expanded
      ? {}
      : {
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }),
  };
}

/**
 * Clamped text block: 2 lines with an ellipsis until clicked, then the full
 * content. Rendered inside a Toast.Description for long notices (e.g. the MCP
 * tool inventory) via toast.info(..., { clamp: true }).
 */
export function ClampedDescription({ children }: { children: React.ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  return (
        <Tooltip content={expanded ? undefined : "Click to expand"}>
      <span
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={expanded ? undefined : "Click to expand"}
        style={clampDescriptionStyle(expanded)}
      >
        {children}
      </span>
    </Tooltip>
  );
}

export const dismissButtonStyle = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 20,
  height: 20,
  padding: 0,
  border: 0,
  borderRadius: "var(--radius-control)",
  background: "transparent",
  color: "var(--text-dim)",
  cursor: "pointer",
  flexShrink: 0,
} as const;

/** Pointer travel beyond this is a drag, not a click (about the tap slop of mobile browsers). */
export const DRAG_SLOP_PX = 10;

/**
 * Swallows the click that ends a drag. A swipe, or a mouse drag that selects
 * text, must not also expand a clamped description or activate the card. It
 * judges the whole travel, so a swipe pulled back to where it started still
 * counts as a drag.
 */
export function useDragClickGuard() {
  const press = useRef<{ x: number; y: number; travel: number } | null>(null);
  const travelTo = (x: number, y: number) => {
    const from = press.current;
    if (from) from.travel = Math.max(from.travel, Math.hypot(x - from.x, y - from.y));
  };
  return {
    onPointerDown: (event: React.PointerEvent) => {
      press.current = { x: event.clientX, y: event.clientY, travel: 0 };
    },
    onPointerMove: (event: React.PointerEvent) => travelTo(event.clientX, event.clientY),
    onClickCapture: (event: React.MouseEvent) => {
      const from = press.current;
      press.current = null;
      // detail 0: a keyboard-activated click, which has no pointer travel.
      if (!from || event.detail === 0) return;
      if (Math.max(from.travel, Math.hypot(event.clientX - from.x, event.clientY - from.y)) > DRAG_SLOP_PX) {
        event.stopPropagation();
        event.preventDefault();
      }
    },
  };
}

/** Heading back toward the start by this much cancels a swipe, as on Android. */
const SWIPE_RETURN_PX = 16;

export interface SwipeTracker {
  /** Records a move; returns the sideways travel from the start. */
  track: (x: number) => number;
  /** True when the release at `x` comes after the finger turned back toward the start. */
  pulledBack: (x: number) => boolean;
}

/** Follows one swipe's sideways travel. */
export function createSwipeTracker(startX: number): SwipeTracker {
  let peak = 0;
  const track = (x: number) => {
    const dx = x - startX;
    if (Math.sign(dx) !== Math.sign(peak) || Math.abs(dx) > Math.abs(peak)) peak = dx;
    return dx;
  };
  return { track, pulledBack: (x: number) => Math.abs(peak) - Math.abs(track(x)) >= SWIPE_RETURN_PX };
}

/**
 * Render a diagnostic detail string for a toast description. Long text wraps
 * (word-break), and any embedded JSON is pulled out into a monospace <pre> so
 * it stays legible instead of overflowing the toast card. Used by the
 * chat-event-action Test button whose detail is e.g. `HTTP 200 — {"ok":…}`.
 */
export function detailNode(detail: string): React.ReactNode {
  const idx = detail.search(/[{[]/);
  const jsonPart = idx >= 0 ? detail.slice(idx) : null;
  const prefix = idx >= 0 ? detail.slice(0, idx).trim() : "";
  let parsed: unknown = undefined;
  if (jsonPart) {
    try {
      parsed = JSON.parse(jsonPart);
    } catch {
      parsed = undefined;
    }
  }
  if (!jsonPart || parsed === undefined) {
    return <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{detail}</span>;
  }
  const pretty = JSON.stringify(parsed, null, 2);
  return (
    <>
      {prefix ? (
        <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{prefix} </span>
      ) : null}
      <pre
        style={{
          margin: prefix ? "4px 0 0" : 0,
          padding: "6px 8px",
          background: "var(--bg-subtle)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-control)",
          fontFamily: "var(--font-mono)",
          fontSize: "calc(11px * var(--ui-font-scale-sm, 1))",
          lineHeight: 1.4,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          overflowWrap: "anywhere",
          color: "var(--text)",
        }}
      >
        {pretty}
      </pre>
    </>
  );
}

function Toaster() {
  const { toasts } = Toast.useToastManager<ToastData>();
  const clickGuard = useDragClickGuard();
  const swipe = useRef<{ id: number; tracker: SwipeTracker } | null>(null);
  // Press origin for the whole-card onClick action below: base-ui captures the
  // pointer for its swipe, which retargets the click to the card, so the
  // action judges the element that was pressed and how far the pointer
  // travelled, not the click target.
  const press = useRef<{ x: number; y: number; target: EventTarget | null; travel: number } | null>(null);
  // All toasts live bottom-right, clear of the chat input bar / status area.
  // Bottom offset 24px on desktop, slightly higher on mobile so the on-screen
  // keyboard / input bar never covers the newest toast.
  const bottomOffset = 24;
  return (
    <Toast.Portal>
      <Toast.Viewport
        style={{
          position: "fixed",
          bottom: bottomOffset,
          right: 16,
          zIndex: 2100,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          width: "min(84vw, 280px)",
          pointerEvents: "none",
        }}
      >
        {toasts.map((t) => (
          <Toast.Root
            key={t.id}
            toast={t}
            className={`toast-card${t.data?.variant === "update" ? " toast-update" : ""}`}
            // Swipe sideways to dismiss, like Android notifications.
            swipeDirection={["left", "right"]}
            data-swipe-dismiss=""
            onPointerDown={(event) => {
              clickGuard.onPointerDown(event);
              // A mouse drag selects text (e.g. to copy an error), as on any page.
              if (event.pointerType === "mouse") event.preventBaseUIHandler();
              else swipe.current = { id: event.pointerId, tracker: createSwipeTracker(event.clientX) };
              press.current = { x: event.clientX, y: event.clientY, target: event.target, travel: 0 };
            }}
            onPointerMove={(event) => {
              clickGuard.onPointerMove(event);
              if (swipe.current?.id === event.pointerId) swipe.current.tracker.track(event.clientX);
              const from = press.current;
              if (from) from.travel = Math.max(from.travel, Math.hypot(event.clientX - from.x, event.clientY - from.y));
            }}
            onPointerUp={(event) => {
              const current = swipe.current;
              swipe.current = null;
              if (current?.id !== event.pointerId || !current.tracker.pulledBack(event.clientX)) return;
              // base-ui dismisses on distance alone. Turn this release into the
              // pointercancel it treats as "put the toast back", and keep the
              // original from reaching its document-level listener.
              event.preventBaseUIHandler();
              event.stopPropagation();
              event.currentTarget.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: event.pointerId, pointerType: event.pointerType }));
            }}
            onClickCapture={clickGuard.onClickCapture}
            onClick={t.data?.onClick ? (event) => {
              const onClick = t.data?.onClick;
              const from = press.current;
              press.current = null;
              // Judge the element that was pressed (not the click target) so
              // clicks retargeted by the toast root still exclude real controls.
              const pointerClick = from && event.detail !== 0;
              const target = pointerClick ? from.target : event.target;
              if (!onClick || (target instanceof Element && target.closest("button, a, input, textarea, select, [aria-expanded]"))) return;
              // A drag that merely fell short of a text selection, even one
              // brought back to where it started, is not a click (detail 0: keyboard).
              if (pointerClick && from && Math.max(from.travel, Math.hypot(event.clientX - from.x, event.clientY - from.y)) > 10) return;
              // Releasing a text selection is not a request to open anything.
              if (window.getSelection()?.isCollapsed === false) return;
              manager.close(t.id);
              onClick();
            } : undefined}
            // The card is focusable (base-ui gives it tabIndex 0): Enter on it
            // runs the action, which has no separate button.
            onKeyDown={t.data?.onClick ? (event) => {
              if (event.key !== "Enter" || event.target !== event.currentTarget) return;
              event.preventDefault();
              manager.close(t.id);
              t.data?.onClick?.();
            } : undefined}
            style={{
              pointerEvents: "auto",
              cursor: t.data?.onClick ? "pointer" : undefined,
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              background: "var(--bg)",
              color: "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-card)",
              boxShadow: "var(--shadow-pop)",
              padding: "8px 10px",
            }}
          >
            <KindIcon kind={t.type as ToastKind | undefined} />
            <Toast.Content style={{ flex: 1, minWidth: 0 }}>
              <Toast.Title style={{ fontSize: "calc(12.5px * var(--ui-font-scale-lg, 1))", lineHeight: 1.35, fontWeight: 600 }} />
              {t.data?.clamp ? (
                <Toast.Description render={<div />} style={descriptionBaseStyle}>
                  <ClampedDescription>{t.description}</ClampedDescription>
                </Toast.Description>
              ) : (
                // Rendered as a div (not base-ui's default <p>): descriptions can
                // carry block-level JSX (e.g. the update toasts' flex rows), and a
                // <div> inside <p> would throw a hydration error.
                <Toast.Description render={<div />} style={descriptionBaseStyle} />
              )}
            </Toast.Content>
            <Toast.Close
              className="toast-close-button"
              aria-label="Dismiss"
              style={dismissButtonStyle}
            >
              <X size={12} strokeWidth={2} aria-hidden />
            </Toast.Close>
          </Toast.Root>
        ))}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  return (
    <Toast.Provider toastManager={manager} timeout={30_000} limit={4}>
      {children}
      <Toaster />
    </Toast.Provider>
  );
}
