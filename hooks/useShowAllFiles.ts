"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Shared "show ignored files" preference for every file-explorer surface
 * (the sidebar section and the right workbench's Files tab). Persisted in
 * localStorage and mirrored through a window event, so the toggle buttons
 * and every mounted FileExplorer stay in sync without prop drilling.
 *
 * The filter it lifts is the server-side ignore list behind
 * `GET /api/files/...?type=list` (node_modules, .git, dist, target, …) —
 * the `all=1` listing mode.
 */

export const SHOW_ALL_FILES_STORAGE_KEY = "omp-web:explorer-show-all-files";
const SHOW_ALL_FILES_EVENT = "omp-web:explorer-show-all-files-changed";

export function useShowAllFiles(): {
  showAllFiles: boolean;
  toggleShowAllFiles: () => void;
} {
  // Off during SSR/hydration; the true value lands in the mount effect, so
  // the first tree fetch runs filtered and re-fetches when the pref is on.
  const [showAllFiles, setShowAllFiles] = useState(false);

  useEffect(() => {
    try {
      setShowAllFiles(window.localStorage.getItem(SHOW_ALL_FILES_STORAGE_KEY) === "1");
    } catch {
      /* storage unavailable — stay filtered */
    }
    const onChanged = (event: Event) => {
      setShowAllFiles((event as CustomEvent<unknown>).detail === true);
    };
    window.addEventListener(SHOW_ALL_FILES_EVENT, onChanged);
    return () => window.removeEventListener(SHOW_ALL_FILES_EVENT, onChanged);
  }, []);

  const toggleShowAllFiles = useCallback(() => {
    // The stored value is the single source of truth, so a toggle in one
    // surface flips every other one from the same state.
    let prev = false;
    try {
      prev = window.localStorage.getItem(SHOW_ALL_FILES_STORAGE_KEY) === "1";
      window.localStorage.setItem(SHOW_ALL_FILES_STORAGE_KEY, prev ? "0" : "1");
    } catch {
      /* storage unavailable — the in-page event still syncs */
    }
    window.dispatchEvent(new CustomEvent(SHOW_ALL_FILES_EVENT, { detail: !prev }));
  }, []);

  return { showAllFiles, toggleShowAllFiles };
}
