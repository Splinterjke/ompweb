"use client";

import { useSyncExternalStore } from "react";
import { useMotionPrefs } from "./useMotionPrefs";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onStoreChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY);
  mediaQuery.addEventListener("change", onStoreChange);
  return () => mediaQuery.removeEventListener("change", onStoreChange);
}

function getSnapshot(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** Tracks the OS "reduce motion" preference or app-level animation disabled;
 *  used to disable SMIL animations that CSS `prefers-reduced-motion` rules cannot stop.
 *  The OS preference is read through useSyncExternalStore so a change never
 *  triggers an effect-driven second render. */
export function usePrefersReducedMotion(): boolean {
  const osReduced = useSyncExternalStore(subscribe, getSnapshot, () => false);
  const { motionPrefs } = useMotionPrefs();
  return osReduced || !motionPrefs.enabled;
}
