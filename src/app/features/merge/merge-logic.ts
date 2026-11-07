import { SourceInfo, SourceUpdate, Status } from '../../core/log/log.models';

/** Sources of one merge: the source filter of the backend is a 16-bit mask. */
export const MAX_SOURCES = 16;
export const MIN_SOURCES = 2;
/** Source colours `--src-1` … `--src-8`; from the ninth source on they repeat, the name tells them apart. */
export const SOURCE_COLORS = 8;
/** Every source visible. */
export const ALL_SOURCES = 0xffff;
/** Characters of a file name in the gutter. */
const LABEL_CHARS = 12;

/** Key of a merge for “already open”: the same files in any order. */
export function mergeKey(paths: readonly string[]): string {
  return [...paths].sort().join('\n');
}

/** CSS class of a source's colour, 1 to 8. */
export function sourceColor(index: number): number {
  return (index % SOURCE_COLORS) + 1;
}

/** The tab label of a merge. */
export function mergeTitle(count: number): string {
  return `Merge (${count} Dateien)`;
}

/**
 * Short names for the gutter: the file name, cut to 12 characters. Names that end up the same get the
 * number of the source, so a line is never told apart by its colour alone.
 */
export function sourceLabels(names: readonly string[]): string[] {
  const cut = names.map((name) =>
    name.length > LABEL_CHARS ? `${name.slice(0, LABEL_CHARS - 1)}…` : name,
  );
  return cut.map((label, i) =>
    cut.indexOf(label) !== cut.lastIndexOf(label)
      ? `${label.slice(0, LABEL_CHARS - 3)}#${i + 1}`
      : label,
  );
}

/** Width of the source column in characters. */
export function labelWidth(labels: readonly string[]): number {
  return labels.reduce((w, l) => Math.max(w, l.length), 0);
}

/** The text of the gutter of a merge: source name, then the line number if shown. */
export function gutterText(label: string, width: number, line: number | null): string {
  const name = label.padEnd(width);
  return line === null ? name : `${name} ${line + 1}`;
}

export function isVisible(mask: number, source: number): boolean {
  return (mask & (1 << source)) !== 0;
}

/** All sources of a merge of `count` files visible. */
export function allVisible(mask: number, count: number): boolean {
  const all = (1 << count) - 1;
  return (mask & all) === all;
}

/** Click on a source chip: switch it, but never hide the last visible one. */
export function toggleSource(mask: number, source: number, count: number): number {
  const all = (1 << count) - 1;
  const next = (mask & all) ^ (1 << source);
  return next === 0 ? mask & all : allVisible(next, count) ? ALL_SOURCES : next;
}

/** Alt-click: only this source (again: all of them). */
export function onlySource(mask: number, source: number, count: number): number {
  const only = 1 << source;
  return (mask & ((1 << count) - 1)) === only ? ALL_SOURCES : only;
}

/** What the backend gets: `null` when nothing is hidden. */
export function maskForBackend(mask: number, count: number): number | null {
  return count === 0 || allVisible(mask, count) ? null : mask & ((1 << count) - 1);
}

export function lateLines(sources: readonly SourceUpdate[]): number {
  return sources.reduce((sum, s) => sum + s.lateLines, 0);
}

/** A source's state in a few words, for the status bar and the tree; null when it is simply live. */
export function sourceStatusText(status: Status): string | null {
  switch (status.kind) {
    case 'file_missing':
      return 'fehlt';
    case 'error':
      return 'Fehler';
    case 'rotated':
      return 'rotiert';
    case 'truncated':
      return 'geleert';
    case 'loading':
      return 'lädt';
    default:
      return null;
  }
}

/** Sources whose state is worth a word in the status bar, e.g. „b.log fehlt“. */
export function sourceProblems(
  infos: readonly SourceInfo[],
  updates: readonly SourceUpdate[],
): string[] {
  const out: string[] = [];
  updates.forEach((update, i) => {
    const text = update.status.kind === 'loading' ? null : sourceStatusText(update.status);
    if (text && infos[i]) out.push(`${infos[i].fileName} ${text}`);
  });
  return out;
}

/** One file in the merge dialog. */
export interface MergeEntry {
  path: string;
  fileName: string;
  profileId: string;
  firstTime: number | null;
  lastTime: number | null;
  error: string | null;
}

/** Why the dialog cannot merge yet, or null. */
export function mergeProblem(entries: readonly MergeEntry[]): string | null {
  if (entries.length < MIN_SOURCES) return 'Mindestens zwei Dateien wählen';
  if (entries.length > MAX_SOURCES) return `Höchstens ${MAX_SOURCES} Dateien`;
  if (entries.some((e) => e.error)) return 'Dateien mit Fehler entfernen';
  return null;
}

/** Adds paths that are not in the list yet; returns the new list and the paths refused as duplicates. */
export function addPaths(
  entries: readonly MergeEntry[],
  paths: readonly string[],
): { entries: MergeEntry[]; duplicates: string[] } {
  const next = [...entries];
  const duplicates: string[] = [];
  for (const path of paths) {
    if (next.some((e) => e.path === path)) {
      duplicates.push(path);
      continue;
    }
    next.push({
      path,
      fileName: baseNameOf(path),
      profileId: '',
      firstTime: null,
      lastTime: null,
      error: null,
    });
  }
  return { entries: next, duplicates };
}

function baseNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Microseconds since the epoch as local date and time, `2024-01-15 10:00:00`. */
export function formatTime(micros: number | null): string {
  if (micros === null) return '–';
  const d = new Date(Math.floor(micros / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
