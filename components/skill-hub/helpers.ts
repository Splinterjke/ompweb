/**
 * Shared panel helpers.
 */
import { en, t, zh, type HubKey, type TranslateValues } from './locales';

export function dictionary(): Record<string, string> {
  const lang = typeof document !== 'undefined' ? document.documentElement.lang : 'zh';
  return lang.toLowerCase().startsWith('en') ? { ...en } : { ...zh };
}

export function tt(key: HubKey, values?: TranslateValues): string {
  return t(dictionary(), key, values);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Stable React key for a skill row. Skill names can repeat across workspaces
 * (the catalog now shows every occurrence), so the name alone is not unique.
 */
export function skillKey(skill: { name: string; source?: string; workspace?: string }): string {
  return skill.name + '::' + (skill.source ?? '') + '::' + (skill.workspace ?? '')
}

export function isDisplayNameDistinct(name: string, displayName: string | undefined): displayName is string {
  if (displayName === undefined) return false;
  const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
  return normalize(displayName) !== normalize(name);
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
