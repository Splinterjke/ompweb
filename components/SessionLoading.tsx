"use client";

import { useId } from "react";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

// The wordmark glyph from public/favicon.svg (64x64 viewBox): a top bar with
// three stems. `pathLength={1}` normalizes the outline so all dash math below
// works in 0..1 regardless of the real path length.
const LETTER_PATH = "M14 16h36v8H40v32h-8V24h-6v22h-8V24h-4z";

// Fast letter build: the outline traces itself in ~0.55s, the gradient fill
// fades in as the trace finishes, then a blurred white dash keeps running
// around the outline as a glowing trail. Under reduced motion only the static
// filled letter renders.
const SESSION_LOADING_CSS = `
@keyframes slp-draw { to { stroke-dashoffset: 0; } }
@keyframes slp-fill-in { to { opacity: 1; } }
@keyframes slp-trail {
  0% { stroke-dashoffset: 0; opacity: 1; }
  100% { stroke-dashoffset: 1; opacity: 1; }
}
.slp-letter-fill { opacity: 0; animation: slp-fill-in 0.35s ease-out 0.45s forwards; }
.slp-letter-draw { stroke-dasharray: 1; stroke-dashoffset: 1; animation: slp-draw 0.55s cubic-bezier(0.3, 0, 0.2, 1) forwards; }
.slp-letter-trail { stroke-dasharray: 0.14 0.86; stroke-dashoffset: 0; opacity: 0; animation: slp-trail 1.5s linear 0.7s infinite; }
`;

export function SessionLoading({ label, size = 120 }: { label: string; size?: number }) {
  const reducedMotion = usePrefersReducedMotion();
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const gradientId = `slp-gradient-${uid}`;
  const glowId = `slp-glow-${uid}`;

  return (
    <div
      role="status"
      aria-label={label}
      style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}
    >
      <style>{SESSION_LOADING_CSS}</style>
      <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ed4abf" />
            <stop offset="0.5" stopColor="#9b4dff" />
            <stop offset="1" stopColor="#5ad8e6" />
          </linearGradient>
          <filter id={glowId} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="2.2" />
          </filter>
        </defs>
        {reducedMotion ? (
          <path d={LETTER_PATH} fill={`url(#${gradientId})`} />
        ) : (
          <>
            <path d={LETTER_PATH} fill={`url(#${gradientId})`} className="slp-letter-fill" />
            <path d={LETTER_PATH} fill="none" stroke={`url(#${gradientId})`} strokeWidth="1.5" strokeLinejoin="round" pathLength={1} className="slp-letter-draw" />
            <path d={LETTER_PATH} fill="none" stroke="#ffffff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" pathLength={1} filter={`url(#${glowId})`} className="slp-letter-trail" />
          </>
        )}
      </svg>
      <div style={{ fontSize: "calc(12.5px * var(--ui-font-scale-lg, 1))", color: "var(--text-muted)" }}>{label}</div>
    </div>
  );
}
