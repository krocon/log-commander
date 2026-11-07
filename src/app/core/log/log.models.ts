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
  /**
   * A filter expression took lines out of the end of the view since the last update (prompt 010): from this
   * position on the view may hold other lines, even if the count did not change.
   */
  retractedFrom?: number | null;
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
  /** Per source of a merge (empty for a single file); `fileSize` is their sum. */
  sources: SourceUpdate[];
}

/** Live state of one source of a merge. */
export interface SourceUpdate {
  status: Status;
  fileSize: number;
  /** Lines in the merge from this source. */
  lines: number;
  /** Lines that came after later ones were shown, appended at the end. */
  lateLines: number;
}

/** One file of a merge, fixed for the session. */
export interface SourceInfo {
  index: number;
  path: string;
  fileName: string;
  profileId: string;
  encoding: string;
}

/** What the merge dialog shows of a file before merging it. */
export interface MergeCandidate {
  path: string;
  fileName: string;
  suggestedProfileId: string;
  encoding: string;
  /** Microseconds since the epoch (UTC) of the first and last timestamp found. */
  firstTime: number | null;
  lastTime: number | null;
  fileSize: number;
}

/** A file to merge; without a profile the suggestion applies. */
export interface MergeSourceSpec {
  path: string;
  profileId?: string | null;
}

export interface SessionInfo {
  sessionId: number;
  path: string;
  fileName: string;
  suggestedProfileId: string;
  update: SessionUpdate;
  /** The files of a merge in source order; empty for a single file. */
  sources: SourceInfo[];
}

export interface LogLine {
  line: number;
  level: Level;
  /** Index into `SessionInfo.sources` (0 for a single file). */
  source: number;
  text: string;
  isContinuation: boolean;
  truncated: boolean;
  matches: [number, number][];
  /** One span `[start, end)` in UTF-16 code units per column of `getColumns`, `[0, 0]` if empty. */
  fields: [number, number][];
}

/** `percent`, `duration` and `size` are extracted values (prompt 011), numbers with a unit. */
export type ColumnKind =
  'timestamp' | 'level' | 'text' | 'number' | 'percent' | 'duration' | 'size';

export interface Column {
  id: string;
  label: string;
  kind: ColumnKind;
  /** Unit of an extracted value written without one (prompt 011). */
  unit?: string;
  /** The extraction rule of the column, if it is one (prompt 011). */
  rule?: string;
}

/** What an extracted value is; numbers compare in a base unit (seconds, bytes). Mirrors `extract.rs`. */
export type ValueKind = 'text' | 'number' | 'percent' | 'duration' | 'size';

/** A field taken out of a column's text by a regex with exactly one group (prompt 011). */
export interface ExtractRule {
  id: string;
  /** Also the column id; must not be a column of the format. */
  name: string;
  /** The column the regex runs over (default `message`). */
  column: string;
  pattern: string;
  kind: ValueKind;
  /** Unit of a value written without one (`took (\d+)ms` → `ms`). */
  unit: string | null;
}

/** A rule `suggest_fields` found in a sample of the file, with examples and its share of the entries. */
export interface FieldSuggestion {
  rule: ExtractRule;
  examples: string[];
  share: number;
  distinct: number;
}

/** A rule tried on some lines: span of the value (UTF-16) and its number per line. */
export interface RulePreview {
  spans: ([number, number] | null)[];
  values: (number | null)[];
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

/** What the overview ruler draws (prompt 007), for the view of `viewGeneration` in `epoch`. */
export interface Overview {
  viewGeneration: number;
  epoch: number;
  /** Positions in the view; buckets and marks belong to this count. */
  count: number;
  /** Level bits (`1 << LEVELS.indexOf(level)`) per pixel bucket, top to bottom. */
  buckets: number[];
  marks: OverviewMark[];
}

/** Where a line (selection, bookmark) is in the view. */
export interface OverviewMark {
  line: number;
  /** Its position, or that of the next visible line when the filter hides it. */
  position: number;
  visible: boolean;
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
  /** Source of the entry (merge) and the byte offset of its head in that file. */
  source: number;
  byteOffset: number;
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

// ------------------------------------------------------------------ filter expressions (prompt 010)

/** A text pattern of a condition (same shape as the search). */
export type TextPattern = SearchQuery;

export type FieldOp = 'eq' | 'contains' | 'regex' | 'gt' | 'lt' | 'between';

/** A condition; mirrors `Cond` in src-tauri/src/filter_expr.rs. */
export type FilterCond =
  | ({ type: 'text' } & SearchQuery)
  | { type: 'level'; levels: Level[] }
  | {
      type: 'field';
      column: string;
      op: FieldOp;
      value: string;
      value2?: string | null;
      caseSensitive?: boolean;
    }
  | { type: 'time'; from?: string | null; to?: string | null }
  | { type: 'range'; start: TextPattern; end?: TextPattern | null; inclusive: boolean }
  | { type: 'lines'; first?: number | null; last?: number | null };

export type FilterCondType = FilterCond['type'];

/** What `set_filter` takes as `expr`; mirrors `FilterExpr` in src-tauri/src/filter_expr.rs. */
export type FilterExpr =
  | { kind: 'group'; id: string; op: 'and' | 'or'; negate: boolean; children: FilterExpr[] }
  | { kind: 'cond'; id: string; negate: boolean; cond: FilterCond };
