/**
 * Startup-notice state: honors the "show start notice" preference and latches
 * which server boot (by boot epoch) has already been acknowledged in this
 * browser. Pure helpers over storage so they are testable and SSR-safe.
 */

const ENABLED_KEY = "omp-web:update-notice-enabled";
const STARTED_AT_KEY = "omp-web:started-at";

export function isUpdateNoticeEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(ENABLED_KEY) !== "false";
  } catch {
    return true;
  }
}

export function setUpdateNoticeEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ENABLED_KEY, String(enabled));
  } catch {
    // best effort
  }
}

/** The server boot (epoch ms) this browser has already acknowledged, or null
 *  when no startup notice has been seen. A changed boot epoch means the
 *  process restarted, so the "OmpWeb started" notice should show once more. */
export function getSeenStartedAt(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STARTED_AT_KEY);
    const value = raw ? Number(raw) : NaN;
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** Record that this server boot has been acknowledged. */
export function markSeenStartedAt(startedAt: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STARTED_AT_KEY, String(startedAt));
  } catch {
    // storage unavailable — the notice still shows this session
  }
}
