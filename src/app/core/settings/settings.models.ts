import { Level, Profile } from '../log/log.models';

export type ThemeChoice = 'system' | 'dark' | 'light';
/** Column view (prompt 009) or the raw line. */
export type ColumnMode = 'columns' | 'raw';

/** Order, widths and hidden columns of one format, stored per profile id. */
export interface ColumnLayout {
  order: string[];
  widths: Record<string, number>;
  hidden: string[];
}

export interface Settings {
  theme: ThemeChoice;
  fontSize: number;
  showLineNumbers: boolean;
  /** After a rotation: keep the old file's lines above the new ones, or start over. */
  keepOnRotate: boolean;
  /** CSS colour per token name without the `--` (e.g. `lv-error-fg`). */
  colorOverrides: Record<string, string>;
  customProfiles: Profile[];
  recentFiles: string[];
  columnMode: ColumnMode;
  /** Per `ColumnSet.profileId`: two logs of the same format look the same. */
  columnLayouts: Record<string, ColumnLayout>;
  /** Detail panel below the log (prompt 004): shown, its height in px, wrapping long lines. */
  detailVisible: boolean;
  detailHeight: number;
  detailWrap: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  fontSize: 13,
  showLineNumbers: true,
  keepOnRotate: true,
  colorOverrides: {},
  customProfiles: [],
  recentFiles: [],
  columnMode: 'columns',
  columnLayouts: {},
  detailVisible: false,
  detailHeight: 240,
  detailWrap: true,
};

export const MIN_FONT_SIZE = 9;
export const MAX_FONT_SIZE = 24;
export const MAX_RECENT_FILES = 15;
/** Bounds of a stored detail height; the layout limits it further to the window. */
export const MIN_DETAIL_HEIGHT = 80;
export const MAX_DETAIL_HEIGHT = 4000;

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

const LEGACY_KEYS = ['wrapLines', 'tableView'] as const;

/** Forgiving merge: unknown or broken values in the store fall back to the defaults. */
export function mergeSettings(saved: Partial<Settings> | null | undefined): Settings {
  const merged: Settings = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
  // Gone with the own viewport (prompt 003): no wrapping, the table is the only view.
  for (const key of LEGACY_KEYS) delete (merged as unknown as Record<string, unknown>)[key];
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
  if (merged.columnMode !== 'columns' && merged.columnMode !== 'raw') {
    merged.columnMode = DEFAULT_SETTINGS.columnMode;
  }
  merged.columnLayouts = mergeColumnLayouts(merged.columnLayouts);
  if (typeof merged.detailVisible !== 'boolean')
    merged.detailVisible = DEFAULT_SETTINGS.detailVisible;
  if (typeof merged.detailWrap !== 'boolean') merged.detailWrap = DEFAULT_SETTINGS.detailWrap;
  const height = Number(merged.detailHeight);
  merged.detailHeight = Number.isFinite(height)
    ? Math.round(Math.min(MAX_DETAIL_HEIGHT, Math.max(MIN_DETAIL_HEIGHT, height)))
    : DEFAULT_SETTINGS.detailHeight;
  return merged;
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Broken entries are dropped, broken parts of an entry fall back to empty. */
function mergeColumnLayouts(saved: unknown): Record<string, ColumnLayout> {
  if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) return {};
  const result: Record<string, ColumnLayout> = {};
  for (const [profileId, value] of Object.entries(saved as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const layout = value as Partial<Record<keyof ColumnLayout, unknown>>;
    const widths: Record<string, number> = {};
    if (typeof layout.widths === 'object' && layout.widths !== null) {
      for (const [id, w] of Object.entries(layout.widths as Record<string, unknown>)) {
        if (typeof w === 'number' && Number.isFinite(w) && w > 0) widths[id] = Math.round(w);
      }
    }
    result[profileId] = {
      order: isStringArray(layout.order) ? layout.order : [],
      widths,
      hidden: isStringArray(layout.hidden) ? layout.hidden : [],
    };
  }
  return result;
}

export function addRecent(recent: readonly string[], path: string): string[] {
  return [path, ...recent.filter((p) => p !== path)].slice(0, MAX_RECENT_FILES);
}
