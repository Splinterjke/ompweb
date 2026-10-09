/**
 * Title cards (omp >= 18.8.1): generated and `/rename`d session titles may
 * carry a card — `<icon> <CODE>: <title>` (e.g. `🧪 FLAKY: Fix flaky park
 * tests`). The card is part of the title STRING stored in the session's
 * title slot (upstream `packages/coding-agent/src/utils/title-card.ts`), so
 * every title reader (sidebar, header, session lists) receives it unchanged
 * — this lib only splits it back apart for display. Parsing mirrors upstream
 * exactly: the icon is 1-8 non-ASCII code points (emoji or a Nerd Fonts
 * glyph), the code is 1-6 ASCII capitals/digits, and the title text after
 * `": "` is non-empty. Anything else is a plain title.
 */

/** The pieces of a card-form title. */
export interface TitleCardParts {
  /** Emoji or Nerd Fonts glyph, rendered as the leading badge icon. */
  icon: string;
  /** 1-6 ASCII capitals/digits naming the subject (`FLAKY`, `Z3`). */
  code: string;
  /** The title without its card. */
  title: string;
}

/** Upstream CARD_LINE: `^(\S+) ([A-Z0-9]{1,6}): (\S.*)$` with the icon
 * additionally validated as non-ASCII-only (upstream `isCardIcon`), so an
 * all-ASCII first token never splits a plain title apart. */
const CARD_LINE = /^(\S+) ([A-Z0-9]{1,6}): (\S.*)$/u;
const MAX_ICON_CODEPOINTS = 8;

function isCardIcon(icon: string): boolean {
  let codepoints = 0;
  for (const char of icon) {
    if (char.charCodeAt(0) < 0x80 || ++codepoints > MAX_ICON_CODEPOINTS) return false;
  }
  return codepoints > 0;
}

/** Split a card-form title; `null` for any plain title. */
export function parseTitleCard(raw: string | undefined | null): TitleCardParts | null {
  if (!raw) return null;
  const match = CARD_LINE.exec(raw);
  if (!match) return null;
  const [, icon, code, title] = match;
  if (!isCardIcon(icon)) return null;
  return { icon, code, title };
}

/** Rebuild the card-form string from parsed parts (rename round-trips). */
export function formatTitleCard(card: TitleCardParts): string {
  return `${card.icon} ${card.code}: ${card.title}`;
}
