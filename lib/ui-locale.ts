import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { getAgentDir } from "./omp/paths";
import { isRecord } from "./type-guards";
import en from "./i18n/locales/en.json";
import ja from "./i18n/locales/ja.json";
import zhCN from "./i18n/locales/zh-CN.json";
import type { ChatEventType } from "./chat-event-action-types";

// Server-side mirror of the client i18n locale (lib/i18n/index.tsx is a
// "use client" module, so server code keeps its own copy of the dictionaries).
// The client syncs the user's choice from the LanguageSwitcher to the server;
// server-side features that need the UI language (e.g. the $event_name chat
// action variable) read it back from here.

export const UI_LOCALES = ["en", "zh-CN", "ja"] as const;
export type UiLocale = (typeof UI_LOCALES)[number];

const DICTS: Record<UiLocale, Record<string, string>> = {
  en: en as unknown as Record<string, string>,
  "zh-CN": zhCN as unknown as Record<string, string>,
  ja: ja as unknown as Record<string, string>,
};

declare global {
  // Shared across module instances (route bundles, instrumentation, hot
  // reload) so every server code path sees one locale.
  var __ompUiLocale: UiLocale | undefined;
}

export function isUiLocale(value: unknown): value is UiLocale {
  return typeof value === "string" && (UI_LOCALES as readonly string[]).includes(value);
}

/** The locale the user picked via "Switch language to" (default: English).
 *  On first access in a process, falls back to the persisted choice so the
 *  selection survives server restarts (the in-memory mirror resets on restart). */
export function getUiLocale(): UiLocale {
  if (globalThis.__ompUiLocale) return globalThis.__ompUiLocale;
  try {
    const path = resolve(getAgentDir(), "ui-locale.json");
    if (existsSync(path)) {
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      const locale = isRecord(raw) ? raw.locale : undefined;
      if (isUiLocale(locale)) {
        globalThis.__ompUiLocale = locale;
        return locale;
      }
    }
  } catch {
    // Unreadable or missing file → fall through to default.
  }
  return "en";
}

export function setUiLocale(locale: UiLocale): void {
  globalThis.__ompUiLocale = locale;
}

/** Persist the chosen locale to disk (atomic write) so it survives restart. */
export function persistUiLocale(locale: UiLocale): void {
  try {
    const dir = getAgentDir();
    mkdirSync(dir, { recursive: true });
    const path = resolve(dir, "ui-locale.json");
    const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(temp, `${JSON.stringify({ version: 1, locale }, null, 2)}\n`, "utf8");
      renameSync(temp, path);
    } finally {
      try {
        if (existsSync(temp)) rmSync(temp);
      } catch {
        // ignore cleanup failures
      }
    }
  } catch {
    // Best-effort: a failure here only means the locale resets to "en" on
    // the next restart; the in-memory value still applies for this process.
  }
}

/** Localized display name of a chat event type (the $event_name variable). */
export function translateEventName(type: ChatEventType, locale: UiLocale = getUiLocale()): string {
  const key = `chatActions.event.${type}`;
  return DICTS[locale][key] ?? DICTS.en[key] ?? type;
}
