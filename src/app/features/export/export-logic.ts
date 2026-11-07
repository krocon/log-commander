import { Column, ExportFormat, ExportProgress, ExportRange } from '../../core/log/log.models';
import { formatBytes, formatCount } from '../../shared/format';

/** What the export dialog offers (prompt 015). */
export type ExportScope = 'selection' | 'view' | 'all';

export const EXPORT_FORMATS: readonly { id: ExportFormat; label: string; ext: string }[] = [
  { id: 'txt', label: 'Text (TXT)', ext: 'txt' },
  { id: 'csv', label: 'CSV', ext: 'csv' },
  { id: 'jsonl', label: 'JSON Lines', ext: 'jsonl' },
];

/** File name extensions the backend accepts per format. */
const ACCEPTED: Record<ExportFormat, readonly string[]> = {
  txt: ['txt', 'log'],
  csv: ['csv'],
  jsonl: ['jsonl', 'ndjson', 'json'],
};

export function extensionOf(format: ExportFormat): string {
  return ACCEPTED[format][0];
}

/** A path ends in an extension of the format, or gets the format's one appended. */
export function withExtension(path: string, format: ExportFormat): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(path);
  const ext = match?.[1].toLowerCase();
  return ext && ACCEPTED[format].includes(ext) ? path : `${path}.${extensionOf(format)}`;
}

const SCOPE_SUFFIX: Record<ExportScope, string> = {
  selection: 'auswahl',
  view: 'ansicht',
  all: 'alles',
};

/** Suggested file name: the log's name without extension, the scope, the extension of the format. */
export function exportFileName(logName: string, scope: ExportScope, format: ExportFormat): string {
  const base = logName.replace(/\.[^.\\/]*$/, '') || 'log';
  // Characters a file name must not have on any platform.
  const safe = [...base]
    .map((c) => (c.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(c) ? '_' : c))
    .join('')
    .slice(0, 120);
  return `${safe}-${SCOPE_SUFFIX[scope]}.${extensionOf(format)}`;
}

/** The range the backend gets; null if the scope is not possible (no selection). */
export function exportRange(
  scope: ExportScope,
  selection: { first: number; last: number } | null,
): ExportRange | null {
  if (scope === 'selection') {
    return selection ? { kind: 'selection', first: selection.first, last: selection.last } : null;
  }
  return { kind: scope };
}

/** Columns a CSV or JSON Lines export can carry: those of the format, in the order of the view. */
export function exportColumns(
  columns: readonly Column[] | null,
  layoutOrder: readonly string[] = [],
): { id: string; label: string }[] {
  if (!columns || columns.length < 2) return [];
  const rank = (id: string) => {
    const i = layoutOrder.indexOf(id);
    return i < 0 ? layoutOrder.length + columns.findIndex((c) => c.id === id) : i;
  };
  return [...columns]
    .sort((a, b) => rank(a.id) - rank(b.id))
    .map((c) => ({ id: c.id, label: c.label }));
}

/** „Export 42 % · 1,2 Mio. Zeilen“ while it runs. */
export function progressText(p: ExportProgress): string {
  const share = p.total > 0 ? Math.min(100, Math.floor((p.lines / p.total) * 100)) : 0;
  return `Export ${share} % · ${formatCount(p.lines)} Zeilen · ${formatBytes(p.bytes)}`;
}
