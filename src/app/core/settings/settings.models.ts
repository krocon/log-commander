import { LEVELS, Level, Profile, SearchMode, SearchQuery } from '../log/log.models';
import { FilterGroupNode, sanitizeTree } from '../../features/sessions/filter-tree';

export type ThemeChoice = 'system' | 'dark' | 'light';
/** Column view (prompt 009) or the raw line. */
export type ColumnMode = 'columns' | 'raw';

/** Order, widths and hidden columns of one format, stored per profile id. */
export interface ColumnLayout {
  order: string[];
  widths: Record<string, number>;
  hidden: string[];
}

/** A filter kept by name (sidebar, prompt 005). Levels as an array: a `Set` does not serialise. */
export interface SavedFilter {
  id: string;
  name: string;
  levels: Level[];
  query: SearchQuery;
  mode: SearchMode;
  /** Format of the entry: 1 = prompt 005 (no tree), 2 = with `tree` (prompt 010). */
  version: number;
  /** The filter tree (prompt 010); an entry of prompt 005 gets an empty one when loaded. */
  tree: FilterGroupNode;
}

/** Current format of a saved filter. */
export const SAVED_FILTER_VERSION = 2;

export interface Settings {
  theme: ThemeChoice;
  fontSize: number;
  showLineNumbers: boolean;
  /** Overview ruler right of the log (prompt 007). */
  showOverviewRuler: boolean;
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
  /** Sidebar left of the log (prompt 005): shown, width in px, share of the tree in its height. */
  sidebarVisible: boolean;
  sidebarWidth: number;
  sidebarTreeShare: number;
  savedFilters: SavedFilter[];
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  fontSize: 13,
  showLineNumbers: true,
  showOverviewRuler: true,
  keepOnRotate: true,
  colorOverrides: {},
  customProfiles: [],
  recentFiles: [],
  columnMode: 'columns',
  columnLayouts: {},
  detailVisible: false,
  detailHeight: 240,
  detailWrap: true,
  sidebarVisible: true,
  sidebarWidth: 240,
  sidebarTreeShare: 0.55,
  savedFilters: [],
};

export const MIN_FONT_SIZE = 9;
export const MAX_FONT_SIZE = 24;
export const MAX_RECENT_FILES = 15;
/** Bounds of a stored detail height; the layout limits it further to the window. */
export const MIN_DETAIL_HEIGHT = 80;
export const MAX_DETAIL_HEIGHT = 4000;
/** Bounds of a stored sidebar width and tree share; the layout limits them further to the window. */
export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH = 2000;
export const MIN_TREE_SHARE = 0.1;
export const MAX_TREE_SHARE = 0.9;
export const MAX_SAVED_FILTERS = 100;

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
  if (typeof merged.showOverviewRuler !== 'boolean') {
    merged.showOverviewRuler = DEFAULT_SETTINGS.showOverviewRuler;
  }
  if (typeof merged.detailVisible !== 'boolean')
    merged.detailVisible = DEFAULT_SETTINGS.detailVisible;
  if (typeof merged.detailWrap !== 'boolean') merged.detailWrap = DEFAULT_SETTINGS.detailWrap;
  const height = Number(merged.detailHeight);
  merged.detailHeight = Number.isFinite(height)
    ? Math.round(Math.min(MAX_DETAIL_HEIGHT, Math.max(MIN_DETAIL_HEIGHT, height)))
    : DEFAULT_SETTINGS.detailHeight;
  if (typeof merged.sidebarVisible !== 'boolean') {
    merged.sidebarVisible = DEFAULT_SETTINGS.sidebarVisible;
  }
  const width = Number(merged.sidebarWidth);
  merged.sidebarWidth = Number.isFinite(width)
    ? Math.round(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width)))
    : DEFAULT_SETTINGS.sidebarWidth;
  const share = Number(merged.sidebarTreeShare);
  merged.sidebarTreeShare = Number.isFinite(share)
    ? Math.min(MAX_TREE_SHARE, Math.max(MIN_TREE_SHARE, share))
    : DEFAULT_SETTINGS.sidebarTreeShare;
  merged.savedFilters = mergeSavedFilters(merged.savedFilters);
  return merged;
}

const SEARCH_MODES: readonly SearchMode[] = ['filter', 'highlight'];

/** Entries without id or name are dropped; unknown levels and broken queries fall back. */
export function mergeSavedFilters(saved: unknown): SavedFilter[] {
  if (!Array.isArray(saved)) return [];
  const result: SavedFilter[] = [];
  const ids = new Set<string>();
  for (const value of saved as unknown[]) {
    if (typeof value !== 'object' || value === null) continue;
    const entry = value as Partial<Record<keyof SavedFilter, unknown>>;
    if (typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)) continue;
    if (typeof entry.name !== 'string' || !entry.name.trim()) continue;
    const levels = Array.isArray(entry.levels)
      ? LEVELS.filter((level) => (entry.levels as unknown[]).includes(level))
      : [...LEVELS];
    const query = (
      typeof entry.query === 'object' && entry.query !== null ? entry.query : {}
    ) as Partial<Record<keyof SearchQuery, unknown>>;
    ids.add(entry.id);
    result.push({
      id: entry.id,
      name: entry.name.trim(),
      levels,
      query: {
        text: typeof query.text === 'string' ? query.text : '',
        isRegex: query.isRegex === true,
        caseSensitive: query.caseSensitive === true,
      },
      mode: SEARCH_MODES.includes(entry.mode as SearchMode) ? (entry.mode as SearchMode) : 'filter',
      // Entries of prompt 005 have no tree: levels and search stay, the tree is empty. Nothing is lost.
      version: SAVED_FILTER_VERSION,
      tree: sanitizeTree(entry.tree),
    });
    if (result.length >= MAX_SAVED_FILTERS) break;
  }
  return result;
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
