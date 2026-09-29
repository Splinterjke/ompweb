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

/** The locale the user picked via "Switch language to" (default: English). */
export function getUiLocale(): UiLocale {
  return globalThis.__ompUiLocale ?? "en";
}

export function setUiLocale(locale: UiLocale): void {
  globalThis.__ompUiLocale = locale;
}

/** Localized display name of a chat event type (the $event_name variable). */
export function translateEventName(type: ChatEventType, locale: UiLocale = getUiLocale()): string {
  const key = `chatActions.event.${type}`;
  return DICTS[locale][key] ?? DICTS.en[key] ?? type;
}
