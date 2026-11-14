import { UpdateSettings } from '../../core/settings/settings.models';

/** Mirrors `UpdateInfo` in src-tauri/src/update.rs. */
export interface UpdateInfo {
  /** This build, e.g. `1.0.0`. */
  current: string;
  /** The latest release, without the `v`. */
  latest: string;
  newer: boolean;
}

/** The check at start asks at most this often. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Whether the start of the app should ask: only when switched on, and not again within a day. */
export function dueAtStart(settings: UpdateSettings, now: number): boolean {
  if (!settings.checkAtStart) return false;
  // A time in the future (clock set back) must not silence the check for good.
  return settings.lastCheck > now || now - settings.lastCheck >= CHECK_INTERVAL_MS;
}

/**
 * The version the status bar points to, if any. A check at start stays quiet about a version the user
 * dismissed; a check by hand shows it again.
 */
export function hintVersion(info: UpdateInfo, dismissed: string, manual: boolean): string | null {
  if (!info.newer) return null;
  return manual || info.latest !== dismissed ? info.latest : null;
}

/** What a check by hand says. */
export function resultText(info: UpdateInfo): string {
  return info.newer
    ? `Version ${info.latest} ist verfügbar (installiert: ${info.current})`
    : `Log Commander ${info.current} ist aktuell`;
}
