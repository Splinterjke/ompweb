"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

export type FontPreset = "sans" | "serif" | "mono";

export interface FontPresetOption {
  id: FontPreset;
  name: string;
  nameKey: string;
  fontFamily: string;
  description: string;
}

export const FONT_PRESETS: FontPresetOption[] = [
  {
    id: "sans",
    name: "Modern Sans",
    nameKey: "typography.sans",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif",
    description: "Modern and crisp, clear structure, high on-screen readability",
  },
  {
    id: "serif",
    name: "Humanist Serif",
    nameKey: "typography.serif",
    fontFamily: "var(--font-serif), 'Songti SC', 'Source Serif 4', 'Noto Serif SC', Georgia, serif",
    description: "Elegant and warm, with a literary, notebook-like texture",
  },
  {
    id: "mono",
    name: "Geek Mono",
    nameKey: "typography.mono",
    fontFamily: "var(--font-mono), 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
    description: "Classic terminal and code style, monospaced and regular",
  },
];

export interface TypographyConfig {
  fontPreset: FontPreset;
  chatFontSize: number; // in px
  /** Scale for large UI text (font sizes >= 12px). 1 = default. */
  uiFontScaleLg: number;
  /** Scale for small UI text (< 12px) and icons. 1 = default. Multiplies
   *  the app's UI font sizes (NOT the chat content, which is driven by
   *  --chat-font-size). */
  uiFontScaleSm: number;
}

const STORAGE_KEY = "omp-typography-config";
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const DEFAULT_CONFIG: TypographyConfig = {
  fontPreset: "sans",
  chatFontSize: 14,
  uiFontScaleLg: 1,
  uiFontScaleSm: 1,
};

/** Migrate a single legacy `uiFontScale` value (pre-split) to a per-scale
 * default. Absent/invalid -> 1. */
function parseLegacyScale(value: unknown): number {
  return typeof value === "number" && value > 0 ? value : 1;
}

let cachedConfig: TypographyConfig = DEFAULT_CONFIG;
let hasInitialized = false;

function getClientSnapshot(): TypographyConfig {
  if (typeof window === "undefined") return DEFAULT_CONFIG;
  if (!hasInitialized) {
    hasInitialized = true;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        cachedConfig = {
          fontPreset: parsed.fontPreset || "sans",
          chatFontSize: Number(parsed.chatFontSize) || 14,
          uiFontScaleLg:
            typeof parsed.uiFontScaleLg === "number" && parsed.uiFontScaleLg > 0
              ? parsed.uiFontScaleLg
              : parseLegacyScale(parsed.uiFontScale),
          uiFontScaleSm:
            typeof parsed.uiFontScaleSm === "number" && parsed.uiFontScaleSm > 0
              ? parsed.uiFontScaleSm
              : parseLegacyScale(parsed.uiFontScale),
        };
      }
    } catch {}
  }
  return cachedConfig;
}

function getServerSnapshot(): TypographyConfig {
  return DEFAULT_CONFIG;
}

function applyTypographyToDom(config: TypographyConfig) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const preset = FONT_PRESETS.find((p) => p.id === config.fontPreset) ?? FONT_PRESETS[0];

  root.style.setProperty("--app-font-family", preset.fontFamily);
  root.style.setProperty("--chat-font-size", `${config.chatFontSize}px`);
  root.style.setProperty("--chat-line-height", `${Math.round(config.chatFontSize * 1.65)}px`);
  root.style.setProperty("--ui-font-scale-lg", String(config.uiFontScaleLg));
  root.style.setProperty("--ui-font-scale-sm", String(config.uiFontScaleSm));
  root.setAttribute("data-font-preset", config.fontPreset);
}

export function useTypography() {
  const config = useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);

  useEffect(() => {
    applyTypographyToDom(config);
  }, [config]);

  const updateTypography = useCallback((updated: Partial<TypographyConfig>) => {
    cachedConfig = { ...cachedConfig, ...updated };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedConfig));
    } catch {}
    applyTypographyToDom(cachedConfig);
    listeners.forEach((cb) => cb());
  }, []);

  const setFontPreset = useCallback((preset: FontPreset) => {
    updateTypography({ fontPreset: preset });
  }, [updateTypography]);

  const setChatFontSize = useCallback((size: number) => {
    updateTypography({ chatFontSize: size });
  }, [updateTypography]);

  const setUiFontScaleLg = useCallback((scale: number) => {
    updateTypography({ uiFontScaleLg: scale });
  }, [updateTypography]);

  const setUiFontScaleSm = useCallback((scale: number) => {
    updateTypography({ uiFontScaleSm: scale });
  }, [updateTypography]);

  return {
    config,
    fontPreset: config.fontPreset,
    chatFontSize: config.chatFontSize,
    uiFontScaleLg: config.uiFontScaleLg,
    uiFontScaleSm: config.uiFontScaleSm,
    setFontPreset,
    setChatFontSize,
    setUiFontScaleLg,
    setUiFontScaleSm,
    updateTypography,
  };
}
