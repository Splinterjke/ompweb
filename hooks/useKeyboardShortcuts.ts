"use client";

import { useEffect } from "react";
import { isMacPlatform, navigateShortcutDirection } from "@/lib/navigation-history";

// ---------------------------------------------------------------------------
// Module-level registry — ChatWindow registers the abort handler here so that
// the global Esc listener in AppShell can call it without prop-drilling.
// ---------------------------------------------------------------------------
let globalAbortHandler: (() => void) | null = null;

/**
 * Register (or clear) the abort handler for the global Esc shortcut.
 * Call this from ChatWindow whenever agentRunning or handleAbort changes.
 */
export function registerAbortHandler(handler: (() => void) | null): void {
  globalAbortHandler = handler;
}

// ---------------------------------------------------------------------------
// Hook: global keyboard shortcuts
// ---------------------------------------------------------------------------

interface UseGlobalKeyboardShortcutsOptions {
  /** Called when Ctrl+Alt+N is pressed. Receives current cwd. */
  onNewSession?: (cwd: string) => void;
  /**
   * Navigate back/forward through visited chat views. The keystroke is always
   * preventDefault-ed when a handler is registered — an exhausted history
   * stack stops there instead of falling through to the browser's own
   * back/forward, so the app is never backed out of by accident.
   */
  onNavigateBack?: () => void;
  onNavigateForward?: () => void;
  /** The currently selected project directory (sidebar cwd). */
  activeCwd?: string | null;
}

/**
 * Register global keyboard shortcuts for the application.
 *
 * Shortcuts handled here:
 *   Esc          – stop the running agent (via module-level abort handler)
 *   Ctrl+Alt+N   – create a new session in the active project directory
 *   ⌘[/⌘] (Alt+←/→ on Windows/Linux, plus the mouse back/forward buttons)
 *                – in-app navigate back/forward (see lib/navigation-history.ts)
 *
 * Note: Esc inside <textarea> or <input> is deliberately NOT handled here.
 * ChatInput manages its own Esc logic (closing slash / @ file menus, stopping
 * the agent when no menu is open) because it needs intimate knowledge of menu
 * state that is local to that component.
 */
export function useGlobalKeyboardShortcuts(
  options: UseGlobalKeyboardShortcutsOptions,
): void {
  const { onNewSession, onNavigateBack, onNavigateForward, activeCwd } = options;

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      // ---- Esc: stop agent ----
      if (e.key === "Escape") {
        if (!globalAbortHandler) return;

        const tag = (e.target as HTMLElement)?.tagName;
        // Let textarea/input handle Esc internally (ChatInput menus / stop).
        if (tag === "TEXTAREA" || tag === "INPUT") return;

        // If any modal dialog or popup is active, let it handle Esc to close itself;
        // do not accidentally abort a background-running Agent task.
        const hasOpenModal = typeof document !== "undefined" && !!document.querySelector('[role="dialog"], [aria-modal="true"], [data-state="open"]');
        if (hasOpenModal) return;

        e.preventDefault();
        globalAbortHandler();
        return;
      }

      // ---- ⌘[/⌘] or Alt+←/→: in-app navigate back/forward ----
      if (onNavigateBack || onNavigateForward) {
        // Not while a modal is open: the palette/config dialogs own the
        // keyboard then, and navigating the chat behind them hides the
        // effect of the keystroke.
        const inDialog = e.target instanceof Element && !!e.target.closest("[role='dialog']");
        const direction = inDialog ? 0 : navigateShortcutDirection(e, isMacPlatform());
        if (direction !== 0) {
          // Always swallowed, including an empty stack: the browser's own
          // back/forward must not fire from inside the app.
          e.preventDefault();
          if (direction === -1) onNavigateBack?.();
          else onNavigateForward?.();
          return;
        }
      }

      // ---- Ctrl+Alt+N: new session ----
      if (e.key === "n" && e.ctrlKey && e.altKey) {
        if (!activeCwd || !onNewSession) return;
        e.preventDefault();
        onNewSession(activeCwd);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeCwd, onNewSession, onNavigateBack, onNavigateForward]);
}
