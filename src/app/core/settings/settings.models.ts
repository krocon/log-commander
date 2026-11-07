import { Level, Profile } from '../log/log.models';

export type ThemeChoice = 'system' | 'dark' | 'light';

export interface Settings {
  theme: ThemeChoice;
  fontSize: number;
  wrapLines: boolean;
  showLineNumbers: boolean;
  /** After a rotation: keep the old file's lines above the new ones, or start over. */
  keepOnRotate: boolean;
  /** CSS colour per token name without the `--` (e.g. `lv-error-fg`). */
  colorOverrides: Record<string, string>;
  customProfiles: Profile[];
  recentFiles: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  fontSize: 13,
  wrapLines: false,
  showLineNumbers: true,
  keepOnRotate: true,
  colorOverrides: {},
  customProfiles: [],
  recentFiles: [],
};

export const MIN_FONT_SIZE = 9;
export const MAX_FONT_SIZE = 24;
export const MAX_RECENT_FILES = 15;

/** The tokens the colour settings offer. */
export const COLOR_TOKENS: readonly { token: string; level: Level | null; label: string }[] = [
  { token: 'lv-trace-fg', level: 'TRACE', label: 'TRACE Text' },
  { token: 'lv-debug-fg', level: 'DEBUG', label: 'DEBUG Text' },
  { token: 'lv-info-fg', level: 'INFO', label: 'INFO Text' },
  { token: 'lv-info-badge', level: 'INFO', label: 'INFO Badge' },
  { token: 'lv-warn-fg', level: 'WARN', label: 'WARN Text' },
  { token: 'lv-warn-bg', level: 'WARN', label: 'WARN Hintergrund' },
  { token: 'lv-error-fg', level: 'ERROR', label: 'ERROR Text' },
  { token: 'lv-error-bg', level: 'ERROR', label: 'ERROR Hintergrund' },
  { token: 'lv-error-edge', level: 'ERROR', label: 'ERROR Rand' },
  { token: 'lv-fatal-fg', level: 'FATAL', label: 'FATAL Text' },
  { token: 'lv-fatal-bg', level: 'FATAL', label: 'FATAL Hintergrund' },
];

/** Forgiving merge: unknown or broken values in the store fall back to the defaults. */
export function mergeSettings(saved: Partial<Settings> | null | undefined): Settings {
  const merged: Settings = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
  if (!['system', 'dark', 'light'].includes(merged.theme)) merged.theme = DEFAULT_SETTINGS.theme;
  const size = Number(merged.fontSize);
  merged.fontSize = Number.isFinite(size)
    ? Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size))
    : DEFAULT_SETTINGS.fontSize;
  if (!Array.isArray(merged.recentFiles)) merged.recentFiles = [];
  if (!Array.isArray(merged.customProfiles)) merged.customProfiles = [];
  if (typeof merged.colorOverrides !== 'object' || merged.colorOverrides === null) {
    merged.colorOverrides = {};
  }
  return merged;
}

export function addRecent(recent: readonly string[], path: string): string[] {
  return [path, ...recent.filter((p) => p !== path)].slice(0, MAX_RECENT_FILES);
}
