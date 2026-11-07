/** DTOs, mirror src-tauri/src/model.rs. */

export const LEVELS = ['UNKNOWN', 'TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const;
export type Level = (typeof LEVELS)[number];
export type LevelCounts = Record<Level, number>;

export type SearchMode = 'filter' | 'highlight';
export type LogViewKind = 'all' | 'filtered';

export type Status =
  | { kind: 'loading'; progress: number }
  | { kind: 'live' }
  | { kind: 'truncated' }
  | { kind: 'rotated' }
  | { kind: 'file_missing' }
  | { kind: 'error'; message: string };

export interface SessionUpdate {
  totalLines: number;
  filteredLines: number;
  counts: LevelCounts;
  /** Lines per level in the view (after the filter); while `filterPending` still the old filter's. */
  viewCounts: LevelCounts;
  status: Status;
  fileSize: number;
  epoch: number;
  viewGeneration: number;
  /** Changes with the columns (format change); `viewGeneration` changes with it. */
  columnsRevision: number;
  filterPending: boolean;
  filterProgress: number;
  profileId: string;
  encoding: string;
  /** Reading is on hold: lines, counts and sizes stay as they are until it resumes. */
  frozen: boolean;
  /** Bytes written since the last read, while frozen. */
  pendingBytes: number;
  /** The file shrank while frozen: the text of the frozen lines may be gone or different. */
  frozenStale: boolean;
}

export interface SessionInfo {
  sessionId: number;
  path: string;
  fileName: string;
  suggestedProfileId: string;
  update: SessionUpdate;
}

export interface LogLine {
  line: number;
  level: Level;
  text: string;
  isContinuation: boolean;
  truncated: boolean;
  matches: [number, number][];
  /** One span `[start, end)` in UTF-16 code units per column of `getColumns`, `[0, 0]` if empty. */
  fields: [number, number][];
}

export type ColumnKind = 'timestamp' | 'level' | 'text' | 'number';

export interface Column {
  id: string;
  label: string;
  kind: ColumnKind;
}

/** The columns lines split into, fixed per session until the format changes. */
export interface ColumnSet {
  revision: number;
  /** Share of the entry heads of the sample that fit the format, 0 to 1. */
  confidence: number;
  /** The profile whose layout splits the lines (`generic` for an inferred layout). */
  profileId: string;
  /** The regex the inference built, to take over into a custom profile. */
  inferredLayout: string | null;
  columns: Column[];
}

/** A layout tried on one line. */
export interface FieldPreview {
  columns: Column[];
  fields: [number, number][];
  matched: boolean;
}

export type ProfileStructure = 'regex' | 'json' | 'logfmt' | 'fix' | 'w3c';

export interface FilterInfo {
  viewGeneration: number;
  pending: boolean;
  filteredLines: number;
}

export interface SearchQuery {
  text: string;
  isRegex: boolean;
  caseSensitive: boolean;
}

export interface FindHit {
  line: number;
  position: number;
  wrapped: boolean;
}

export interface EntryRange {
  first: number;
  last: number;
}

/** The whole entry of a line (detail panel): head and continuations, without filter. */
export interface EntryDetail {
  first: number;
  last: number;
  level: Level;
  lineCount: number;
  /** Bytes of the lines in the file, without line ends. */
  totalBytes: number;
  /** The lines joined by `\n`, at most 1 MiB. */
  text: string;
  /** The text stops early; copying returns everything. */
  truncated: boolean;
}

export interface Profile {
  id: string;
  name: string;
  builtin?: boolean;
  patterns: string[];
  mapping?: Partial<Record<string, Level>>;
  json?: boolean;
  syslogPri?: boolean;
  head?: string | null;
  /** Regexes over the whole line, named groups become columns. */
  layouts?: string[];
  structure?: ProfileStructure;
}
