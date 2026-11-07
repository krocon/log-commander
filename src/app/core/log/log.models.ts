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
  status: Status;
  fileSize: number;
  epoch: number;
  viewGeneration: number;
  filterPending: boolean;
  filterProgress: number;
  profileId: string;
  encoding: string;
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
}

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

export interface Profile {
  id: string;
  name: string;
  builtin?: boolean;
  patterns: string[];
  mapping?: Partial<Record<string, Level>>;
  json?: boolean;
  syslogPri?: boolean;
  head?: string | null;
}
