"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Height bounds for the draggable sidebar sections (Explorer / Schedulers /
 * Usage).
 *
 * The resize model is a **transfer between adjacent sections**: dragging a
 * section's top divider grows that section while the open section *above* it
 * (or the flex Workspaces list when none above is open) shrinks by the same
 * amount. The total column height is conserved, so the bottom sections
 * (Usage / Settings) are never pushed off-screen and every header stays
 * visible without scrolling. A section can never be shrunk below its header
 * height + `SECTION_MIN_CONTENT`, so dragging up stops exactly when it touches
 * the section above.
 */
export const SECTION_MIN_HEIGHT = 80;
export const SECTION_MAX_HEIGHT = 1200;
export const SECTION_DEFAULT_HEIGHT = 200;
export const SECTION_STEP = 24;
/** Extra usable content a section keeps above its header at the minimum. */
export const SECTION_MIN_CONTENT = 32;

/** Read a persisted section height, clamped to the static range (SSR-safe). */
export function readStoredSectionHeight(key: string, fallback: number = SECTION_DEFAULT_HEIGHT): number {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = Number(window.localStorage.getItem(key));
    if (!Number.isFinite(raw) || raw <= 0) return fallback;
    return Math.min(Math.max(raw, SECTION_MIN_HEIGHT), SECTION_MAX_HEIGHT);
  } catch {
    return fallback;
  }
}

type ElRef = { current: HTMLElement | null };

/**
 * The transfer partner for a section: the open section above it, or the flex
 * Workspaces list. The list is a no-op target (it absorbs changes via flex),
 * so only its current rendered height is read.
 */
export interface TransferPartner {
  /** Current rendered height of the partner (the list's live height for the list). */
  getHeight: () => number;
  /** Minimum height the partner may shrink to. */
  getMin: () => number;
  /** Apply the partner's new height (a no-op when the partner is the flex list). */
  set: (height: number) => void;
}

/**
 * Drag-resize a fixed-height sidebar section from its top divider by
 * transferring height with its partner (the open section above it, or the
 * flex list). The hook owns the drag (document-level mousemove/mouseup), the
 * clamping, keyboard resize, and the `dragging` flag consumers use to suspend
 * CSS transitions.
 *
 * `height`/`setSelf` are this section's height state (persisted by the caller).
 * `storageKey` is where this section's height is persisted. `ownHeaderRef`
 * points at the section's header element (its minimum is header height +
 * `SECTION_MIN_CONTENT`). `partner` describes the transfer partner.
 */
export function useAdjacentSectionResize(
  height: number,
  setSelf: (updater: number | ((prev: number) => number)) => void,
  storageKey: string,
  ownHeaderRef: ElRef,
  partner: TransferPartner,
) {
  const [dragging, setDragging] = useState(false);
  const heightRef = useRef(height);
  heightRef.current = height;
  const partnerRef = useRef(partner);
  partnerRef.current = partner;
  const handlersRef = useRef<{ onMove: (e: MouseEvent) => void; onUp: () => void } | null>(null);
  const storageKeyRef = useRef(storageKey);
  storageKeyRef.current = storageKey;

  const minOfSelf = useCallback(() => {
    const h = ownHeaderRef.current?.getBoundingClientRect().height;
    return h ? Math.ceil(h) + SECTION_MIN_CONTENT : SECTION_MIN_HEIGHT;
  }, [ownHeaderRef]);

  const persist = (value: number) => {
    try {
      window.localStorage.setItem(storageKeyRef.current, String(value));
    } catch {
      /* storage unavailable (private mode etc.) */
    }
  };

  const start = useCallback(
    (e: { clientY: number; preventDefault: () => void }) => {
      e.preventDefault();
      const p = partnerRef.current;
      const startY = e.clientY;
      const startSelf = heightRef.current;
      const startPartner = p.getHeight();
      const selfMin = minOfSelf();
      const partnerMin = p.getMin();
      setDragging(true);
      // Track the latest values in the closure — the refs only refresh on the
      // next render, so they can be stale when the final move and mouseup land
      // in the same tick (which would persist the wrong heights).
      let self = startSelf;
      let partnerNew = startPartner;
      const onMove = (ev: MouseEvent) => {
        // The divider is above the content: dragging UP grows this section and
        // shrinks its partner by the same amount (and the reverse).
        let delta = startY - ev.clientY;
        // Bound the transfer so neither side leaves its minimum.
        delta = Math.min(delta, startPartner - partnerMin); // can't shrink the partner below its min
        delta = Math.max(delta, selfMin - startSelf); // can't shrink this section below its min
        self = startSelf + delta;
        partnerNew = startPartner - delta;
        setSelf(Math.round(self));
        p.set(Math.round(partnerNew));
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        handlersRef.current = null;
        setDragging(false);
        persist(self);
      };
      handlersRef.current = { onMove, onUp };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [setSelf, minOfSelf],
  );

  // If the component unmounts mid-drag, remove the listeners; otherwise they
  // leak and keep firing on the document.
  useEffect(
    () => () => {
      const handlers = handlersRef.current;
      if (!handlers) return;
      document.removeEventListener("mousemove", handlers.onMove);
      document.removeEventListener("mouseup", handlers.onUp);
    },
    [],
  );

  const reset = useCallback(() => {
    setSelf(SECTION_DEFAULT_HEIGHT);
    persist(SECTION_DEFAULT_HEIGHT);
  }, [setSelf]);

  const handleKeyDown = useCallback(
    (e: { key: string; preventDefault: () => void }) => {
      const p = partnerRef.current;
      const self = heightRef.current;
      const partnerH = p.getHeight();
      const selfMin = minOfSelf();
      const partnerMin = p.getMin();
      if (e.key === "ArrowUp") {
        // Grow by a step, transferring from the partner above.
        e.preventDefault();
        const next = Math.min(self + SECTION_STEP, self + (partnerH - partnerMin));
        setSelf(next);
        p.set(partnerH - (next - self));
      } else if (e.key === "ArrowDown") {
        // Shrink by a step, transferring into the partner above.
        e.preventDefault();
        const next = Math.max(self - SECTION_STEP, selfMin);
        setSelf(next);
        p.set(partnerH - (next - self));
      } else if (e.key === "Enter" || e.key === " ") {
        // Reset this section to default; the partner/list absorbs the rest.
        e.preventDefault();
        reset();
      }
    },
    [setSelf, minOfSelf, reset],
  );

  return { dragging, start, handleKeyDown, reset };
}
