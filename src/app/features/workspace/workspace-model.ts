import { Anchor, LEVELS, Level, SearchMode, SearchQuery } from '../../core/log/log.models';
import { ColumnLayout, ColumnMode, mergeColumnLayouts } from '../../core/settings/settings.models';
import { ALL_SOURCES } from '../merge/merge-logic';
import { FilterGroupNode, emptyTree, sanitizeTree } from '../sessions/filter-tree';
import {
  dirName,
  isAbsolutePath,
  isNetworkPath,
  normalizePath,
  relativePath,
  resolveRelative,
} from './workspace-paths';

/**
 * A saved workspace (prompt 015), a `.lcw` file: the open files and merges, per tab its filter (levels, search,
 * sources, filter tree), dashboard mode, following and position, per file bookmarks and notes as anchors, the
 * layout around the log (column mode, detail panel, sidebar, timeline, ruler) and the column layouts of the
 * formats in use. Dashboards stay in `dashboards.json` per format and are only referenced by the tab's mode
 * (a workspace from someone else brings no SQL along).
 *
 * A workspace may come from someone else: `parseWorkspace` checks every field and its size, drops what does not
 * fit and never executes anything; regexes of the filter tree are compiled by the backend (linear time).
 */

export const WORKSPACE_FORMAT = 'log-commander-workspace';
/** 1: draft of the format (files with levels, search and bookmarks as line numbers); 2: this one. */
export const WORKSPACE_VERSION = 2;
export const WORKSPACE_EXTENSION = 'lcw';

export const MAX_WS_FILES = 32;
export const MAX_WS_SOURCES = 16;
/** Tabs per file, as the backend allows views (prompt 013). */
export const MAX_WS_TABS = 8;
/** Bookmarks and notes per file. */
export const MAX_WS_MARKS = 10_000;
export const MAX_NOTE_LENGTH = 2000;
const MAX_PATH_LENGTH = 4096;
const MAX_QUERY_LENGTH = 4096;
const MAX_PROFILE_ID = 128;
const MAX_LINE = 2 ** 32 - 1;
const MAX_LEN = 64 * 1024 * 1024;

export interface WsSource {
  /** Absolute path when saved. */
  path: string;
  /** The same relative to the folder of the `.lcw`, with `/`; null on another drive. */
  relPath: string | null;
  /** The profile chosen for a source of a merge; null: the suggestion. */
  profileId: string | null;
}

/** A bookmark (`text` null) or a note. */
export interface WsMark {
  anchor: Anchor;
  text: string | null;
}

export interface WsFilter {
  levels: Level[];
  query: SearchQuery;
  mode: SearchMode;
  sourceMask: number;
  tree: FilterGroupNode;
}

export interface WsTab {
  /** Index of the tab this one filters further (prompt 013), lower than its own; null for the file's tab. */
  parent: number | null;
  filter: WsFilter;
  mode: 'log' | 'dashboard';
  follow: boolean;
  /** The line on top of the view when not following. */
  top: Anchor | null;
  /** The selected entry (its first line). */
  selection: Anchor | null;
}

export interface WsFile {
  kind: 'file' | 'merge';
  sources: WsSource[];
  /** The profile of a single file; null: the suggestion. */
  profileId: string | null;
  /** `tabs[0]` is the tab of the file. */
  tabs: WsTab[];
  bookmarks: WsMark[];
  notes: WsMark[];
}

export interface WsUi {
  columnMode: ColumnMode;
  detailVisible: boolean;
  detailHeight: number;
  detailWrap: boolean;
  sidebarVisible: boolean;
  sidebarWidth: number;
  showTimeline: boolean;
  showOverviewRuler: boolean;
}

export interface WorkspaceDoc {
  format: typeof WORKSPACE_FORMAT;
  version: typeof WORKSPACE_VERSION;
  savedAt: string;
  files: WsFile[];
  /** The tab in front. */
  active: { file: number; tab: number } | null;
  ui: WsUi;
  /** Column layouts (prompt 009) of the formats in use, per profile id. */
  columnLayouts: Record<string, ColumnLayout>;
}

export type ParseResult =
  | { ok: true; doc: WorkspaceDoc; dropped: number; migratedFrom: number | null }
  | { ok: false; error: string };

export function isWorkspacePath(path: string): boolean {
  return path.toLowerCase().endsWith(`.${WORKSPACE_EXTENSION}`);
}

/** Fills in the relative paths for where the workspace is written. */
export function withRelativePaths(doc: WorkspaceDoc, workspacePath: string): WorkspaceDoc {
  const dir = dirName(workspacePath);
  return {
    ...doc,
    files: doc.files.map((f) => ({
      ...f,
      sources: f.sources.map((s) => ({ ...s, relPath: relativePath(dir, s.path) })),
    })),
  };
}

/**
 * Where a source is now: its absolute path if it exists, else its relative path next to the workspace if that
 * exists, else null (missing). `exists` answers for absolute paths.
 */
export function locateSource(
  source: WsSource,
  workspacePath: string,
  exists: (path: string) => boolean,
): string | null {
  if (exists(source.path)) return source.path;
  if (source.relPath) {
    const near = resolveRelative(dirName(workspacePath), source.relPath);
    if (near && exists(near)) return near;
  }
  return null;
}

/** Candidates to probe for a source: the absolute path and the one next to the workspace, never network paths. */
export function sourceCandidates(source: WsSource, workspacePath: string): string[] {
  const near = source.relPath ? resolveRelative(dirName(workspacePath), source.relPath) : null;
  const all = near && near !== source.path ? [source.path, near] : [source.path];
  return all.filter((p) => !isNetworkPath(p));
}

/** A file of the workspace reaches out to the network (its saved path): it is not opened. */
export function isNetworkFile(file: WsFile): boolean {
  return file.sources.some((s) => isNetworkPath(s.path));
}

export function serializeWorkspace(doc: WorkspaceDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

// ---------------------------------------------------------------------------------------------- parsing

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.length <= max && !v.includes('\0') ? v : null;

/** Counts what had to be dropped, so the user can be told. */
class Dropper {
  count = 0;
  drop<T>(value: T | null): T | null {
    if (value === null) this.count++;
    return value;
  }
}

/** Reads a workspace file; anything that is not a workspace, or from a newer version, is refused. */
export function parseWorkspace(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Die Datei ist kein JSON' };
  }
  if (!isObj(raw) || raw['format'] !== WORKSPACE_FORMAT) {
    return { ok: false, error: 'Die Datei ist kein Arbeitsstand von Log Commander' };
  }
  const version = raw['version'];
  if (!isInt(version, 1, Number.MAX_SAFE_INTEGER)) {
    return { ok: false, error: 'Die Versionsangabe fehlt oder ist ungültig' };
  }
  if (version > WORKSPACE_VERSION) {
    return {
      ok: false,
      error: `Der Arbeitsstand stammt aus einer neueren Version (${version}), bitte Log Commander aktualisieren`,
    };
  }
  const migratedFrom = version < WORKSPACE_VERSION ? version : null;
  const current = version === 1 ? migrateV1(raw) : raw;
  const dropper = new Dropper();
  const files = (Array.isArray(current['files']) ? current['files'] : [])
    .slice(0, MAX_WS_FILES)
    .map((f) => dropper.drop(parseFile(f, dropper)))
    .filter((f): f is WsFile => f !== null);
  if (Array.isArray(current['files']) && current['files'].length > MAX_WS_FILES) {
    dropper.count += current['files'].length - MAX_WS_FILES;
  }
  const activeRaw = current['active'];
  const active =
    isObj(activeRaw) &&
    isInt(activeRaw['file'], 0, files.length - 1) &&
    isInt(activeRaw['tab'], 0, (files[activeRaw['file'] as number]?.tabs.length ?? 0) - 1)
      ? { file: activeRaw['file'] as number, tab: activeRaw['tab'] as number }
      : null;
  const savedAt = str(current['savedAt'], 64) ?? '';
  return {
    ok: true,
    doc: {
      format: WORKSPACE_FORMAT,
      version: WORKSPACE_VERSION,
      savedAt,
      files,
      active,
      ui: parseUi(current['ui']),
      columnLayouts: mergeColumnLayouts(
        isObj(current['columnLayouts'])
          ? Object.fromEntries(
              Object.entries(current['columnLayouts'])
                .filter(([id]) => id.length <= MAX_PROFILE_ID)
                .slice(0, 64),
            )
          : {},
      ),
    },
    dropped: dropper.count,
    migratedFrom,
  };
}

/**
 * Version 1 (draft): `files: [{ path, profileId?, levels?, search?, bookmarks?: number[] }]`, `active?: number`.
 * Bookmarks were bare line numbers: they become anchors without hash, taken by number when opened.
 */
function migrateV1(raw: Obj): Obj {
  const files = Array.isArray(raw['files']) ? raw['files'] : [];
  const active = raw['active'];
  return {
    savedAt: raw['savedAt'],
    files: files.map((f) => {
      if (!isObj(f)) return null;
      const lines = Array.isArray(f['bookmarks']) ? f['bookmarks'] : [];
      return {
        kind: 'file',
        sources: [{ path: f['path'], relPath: null, profileId: null }],
        profileId: f['profileId'] ?? null,
        tabs: [
          {
            parent: null,
            filter: {
              levels: f['levels'] ?? [...LEVELS],
              query: { text: f['search'] ?? '', isRegex: false, caseSensitive: false },
              mode: 'filter',
              sourceMask: ALL_SOURCES,
              tree: emptyTree(),
            },
            mode: 'log',
            follow: true,
            top: null,
            selection: null,
          },
        ],
        bookmarks: lines.map((line) => ({
          anchor: { line, source: 0, offset: 0, len: 0, hash: '' },
          text: null,
        })),
        notes: [],
      };
    }),
    active: isInt(active, 0, MAX_WS_FILES) ? { file: active, tab: 0 } : null,
    ui: raw['ui'],
    columnLayouts: raw['columnLayouts'],
  };
}

function parsePath(v: unknown): string | null {
  const path = str(v, MAX_PATH_LENGTH);
  if (!path || !isAbsolutePath(path)) return null;
  // A network path stays as written so it is recognised (normalising would make `//host/x` local `/host/x`).
  return isNetworkPath(path) ? path : normalizePath(path);
}

function parseRelPath(v: unknown): string | null {
  const rel = str(v, MAX_PATH_LENGTH);
  return rel && !isAbsolutePath(rel) ? rel : null;
}

function parseProfileId(v: unknown): string | null {
  const id = str(v, MAX_PROFILE_ID);
  return id && /^[\w.:-]+$/.test(id) ? id : null;
}

function parseSource(v: unknown): WsSource | null {
  if (!isObj(v)) return null;
  const path = parsePath(v['path']);
  if (!path) return null;
  return { path, relPath: parseRelPath(v['relPath']), profileId: parseProfileId(v['profileId']) };
}

export function parseAnchor(v: unknown): Anchor | null {
  if (!isObj(v)) return null;
  const hash = v['hash'];
  if (typeof hash !== 'string' || !(hash === '' || /^[0-9a-f]{16}$/.test(hash))) return null;
  if (
    !isInt(v['line'], 0, MAX_LINE) ||
    !isInt(v['source'] ?? 0, 0, MAX_WS_SOURCES - 1) ||
    !isInt(v['offset'], 0, Number.MAX_SAFE_INTEGER) ||
    !isInt(v['len'], 0, MAX_LEN)
  ) {
    return null;
  }
  return {
    line: v['line'] as number,
    source: (v['source'] ?? 0) as number,
    offset: v['offset'] as number,
    len: v['len'] as number,
    hash,
  };
}

function parseMarks(v: unknown, notes: boolean, dropper: Dropper): WsMark[] {
  if (!Array.isArray(v)) return [];
  const out: WsMark[] = [];
  for (const m of v.slice(0, MAX_WS_MARKS)) {
    const anchor = isObj(m) ? parseAnchor(m['anchor']) : null;
    const text = isObj(m) && notes ? str(m['text'], MAX_NOTE_LENGTH) : null;
    if (!anchor || (notes && !text?.trim())) {
      dropper.count++;
      continue;
    }
    out.push({ anchor, text: notes ? (text as string) : null });
  }
  dropper.count += Math.max(0, v.length - MAX_WS_MARKS);
  return out;
}

function parseFilter(v: unknown): WsFilter {
  const f = isObj(v) ? v : {};
  const levels = Array.isArray(f['levels'])
    ? LEVELS.filter((l) => (f['levels'] as unknown[]).includes(l))
    : [...LEVELS];
  const q = isObj(f['query']) ? f['query'] : {};
  return {
    levels,
    query: {
      text: str(q['text'], MAX_QUERY_LENGTH) ?? '',
      isRegex: q['isRegex'] === true,
      caseSensitive: q['caseSensitive'] === true,
    },
    mode: f['mode'] === 'highlight' ? 'highlight' : 'filter',
    sourceMask: isInt(f['sourceMask'], 0, ALL_SOURCES) ? f['sourceMask'] : ALL_SOURCES,
    tree: sanitizeTree(f['tree']),
  };
}

function parseTab(v: unknown, index: number): WsTab | null {
  if (!isObj(v)) return null;
  const parent = index === 0 ? null : isInt(v['parent'], 0, index - 1) ? v['parent'] : 0;
  return {
    parent,
    filter: parseFilter(v['filter']),
    mode: v['mode'] === 'dashboard' ? 'dashboard' : 'log',
    follow: v['follow'] !== false,
    top: parseAnchor(v['top']),
    selection: parseAnchor(v['selection']),
  };
}

function parseFile(v: unknown, dropper: Dropper): WsFile | null {
  if (!isObj(v)) return null;
  const kind = v['kind'] === 'merge' ? 'merge' : 'file';
  const rawSources = Array.isArray(v['sources']) ? v['sources'] : [];
  if (rawSources.length > MAX_WS_SOURCES) return null;
  const sources = rawSources.map(parseSource);
  if (sources.some((s) => s === null)) return null;
  const count = sources.length;
  if (kind === 'file' ? count !== 1 : count < 2) return null;
  const rawTabs = Array.isArray(v['tabs']) ? v['tabs'].slice(0, MAX_WS_TABS) : [];
  const tabs: WsTab[] = [];
  for (const t of rawTabs) {
    const tab = parseTab(t, tabs.length);
    if (tab) tabs.push(tab);
    else dropper.count++;
  }
  if (!tabs.length) tabs.push(parseTab({}, 0) as WsTab);
  return {
    kind,
    sources: sources as WsSource[],
    profileId: parseProfileId(v['profileId']),
    tabs,
    bookmarks: parseMarks(v['bookmarks'], false, dropper),
    notes: parseMarks(v['notes'], true, dropper),
  };
}

const UI_DEFAULTS: WsUi = {
  columnMode: 'columns',
  detailVisible: false,
  detailHeight: 240,
  detailWrap: true,
  sidebarVisible: true,
  sidebarWidth: 240,
  showTimeline: true,
  showOverviewRuler: true,
};

function parseUi(v: unknown): WsUi {
  const u = isObj(v) ? v : {};
  const bool = (key: keyof WsUi) =>
    typeof u[key] === 'boolean' ? (u[key] as boolean) : (UI_DEFAULTS[key] as boolean);
  return {
    columnMode: u['columnMode'] === 'raw' ? 'raw' : 'columns',
    detailVisible: bool('detailVisible'),
    detailHeight: isInt(u['detailHeight'], 80, 4000) ? u['detailHeight'] : UI_DEFAULTS.detailHeight,
    detailWrap: bool('detailWrap'),
    sidebarVisible: bool('sidebarVisible'),
    sidebarWidth: isInt(u['sidebarWidth'], 180, 2000)
      ? u['sidebarWidth']
      : UI_DEFAULTS.sidebarWidth,
    showTimeline: bool('showTimeline'),
    showOverviewRuler: bool('showOverviewRuler'),
  };
}
