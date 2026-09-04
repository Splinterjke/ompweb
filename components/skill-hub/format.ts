/**
 * Formatting helpers for timestamps, dot styles, and hashes.
 */

import type { CSSProperties } from 'react';
import { formatRelativeTime } from './grouping';
import { tt } from './helpers';

export const DEFAULT_DOT_MODEL_COLOR = '#2f81f7';
export const DEFAULT_DOT_USER_COLOR = '#3fb950';

export function dotStyle(color: string | undefined): CSSProperties | undefined {
  if (color === undefined) return undefined;
  return { background: color, borderColor: color };
}

export function relativeTimeText(ms: number): string {
  const rt = formatRelativeTime(ms);
  return tt(rt.key, rt.value !== undefined ? { value: rt.value } : undefined);
}

export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}
