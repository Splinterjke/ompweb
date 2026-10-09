import type { TitleCardParts } from "@/lib/title-card";

/**
 * Presentational badge for an omp title card (`🧪 FLAKY: …`): the card icon
 * glyph plus the short subject code as a monospace chip. The plain title is
 * rendered by the caller next to it — the component owns only the two badge
 * pieces so the sidebar rows and the chat header stay visually identical.
 * Colors come from the shared design tokens; the glyph renders in the
 * inherited text color so emoji and Nerd Fonts glyphs both work.
 */
export function TitleCardBadge({ card, scale = 1 }: { card: TitleCardParts; scale?: number }) {
  return (
    <>
      <span
        aria-hidden="true"
        style={{ flexShrink: 0, fontSize: `calc(12.5px * var(--ui-font-scale-lg, 1) * ${scale})`, lineHeight: 1.35 }}
      >
        {card.icon}
      </span>
      <span
        aria-hidden="true"
        style={{
          flexShrink: 0,
          fontFamily: "var(--font-mono)",
          fontSize: `calc(9px * var(--ui-font-scale-sm, 1) * ${scale})`,
          fontWeight: 700,
          letterSpacing: "0.02em",
          lineHeight: "14px",
          height: 14,
          padding: "0 4px",
          borderRadius: 3,
          color: "var(--text-muted)",
          background: "var(--bg-subtle)",
          border: "1px solid var(--border)",
        }}
      >
        {card.code}
      </span>
    </>
  );
}
