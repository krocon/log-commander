import { Column, ColumnKind, ColumnSet, LogLine } from '../../core/log/log.models';
import { ColumnLayout, ColumnMode } from '../../core/settings/settings.models';
import { TextSegment } from './highlight';

/** The column that holds a line that is not split (continuation, no match); it cannot be hidden. */
export const MESSAGE_ID = 'message';
export const MIN_COLUMN_WIDTH = 32;
export const MAX_COLUMN_WIDTH = 4000;
/** One step of „schmaler/breiter“ in the column menu. */
export const WIDTH_STEP = 24;
/** Padding of a cell left and right (1ch each side plus the level mark), roughly. */
export const CELL_PADDING = 24;

/** A column of the column view: from the `ColumnSet`, ordered, sized and shown as the layout says. */
export interface ViewColumn {
  id: string;
  label: string;
  kind: ColumnKind;
  /** Index into `LogLine.fields`. */
  field: number;
  width: number;
  hidden: boolean;
}

/** Columns only when the format splits lines into more than the message; one column is no header. */
export function columnsAvailable(set: ColumnSet | null | undefined): boolean {
  return !!set && set.columns.length > 1;
}

export function columnsActive(mode: ColumnMode, set: ColumnSet | null | undefined): boolean {
  return mode === 'columns' && columnsAvailable(set);
}

export function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return MIN_COLUMN_WIDTH;
  return Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width)));
}

/** Typical widths of common fields, in characters. */
const KNOWN_CHARS: Readonly<Record<string, number>> = {
  [MESSAGE_ID]: 60,
  thread: 16,
  logger: 28,
  pid: 7,
  tid: 7,
  host: 16,
  method: 7,
  status: 6,
};

/** A first width that fits typical values of the kind, in characters of the monospaced font. */
export function defaultWidth(column: Column, charWidth: number): number {
  let chars: number;
  switch (column.kind) {
    case 'timestamp':
      chars = 29;
      break;
    case 'level':
      chars = 6;
      break;
    case 'number':
      chars = 7;
      break;
    case 'percent':
    case 'duration':
    case 'size':
      // Extracted values keep their unit: `340ms`, `1.2GB`.
      chars = 9;
      break;
    default:
      chars = KNOWN_CHARS[column.id] ?? 24;
  }
  return clampWidth(Math.ceil(chars * charWidth + CELL_PADDING));
}

/**
 * The columns of a `ColumnSet` with the saved layout: the saved order for known columns, new columns at the
 * end, columns that are gone ignored. Widths are clamped, `message` is never hidden.
 */
export function resolveColumns(
  columns: readonly Column[],
  layout: ColumnLayout | undefined,
  charWidth: number,
): ViewColumn[] {
  const byId = new Map(columns.map((c, field) => [c.id, { column: c, field }]));
  const order: string[] = [];
  for (const id of layout?.order ?? []) {
    if (byId.has(id) && !order.includes(id)) order.push(id);
  }
  for (const c of columns) if (!order.includes(c.id)) order.push(c.id);
  const hidden = new Set(layout?.hidden ?? []);
  return order.map((id) => {
    const { column, field } = byId.get(id)!;
    const saved = layout?.widths?.[id];
    return {
      id,
      label: column.label,
      kind: column.kind,
      field,
      width: typeof saved === 'number' ? clampWidth(saved) : defaultWidth(column, charWidth),
      hidden: id !== MESSAGE_ID && hidden.has(id),
    };
  });
}

/** What goes into the settings. */
export function layoutOf(columns: readonly ViewColumn[]): ColumnLayout {
  return {
    order: columns.map((c) => c.id),
    widths: Object.fromEntries(columns.map((c) => [c.id, c.width])),
    hidden: columns.filter((c) => c.hidden).map((c) => c.id),
  };
}

export function setHidden(
  columns: readonly ViewColumn[],
  id: string,
  hidden: boolean,
): ViewColumn[] {
  if (id === MESSAGE_ID) return [...columns];
  return columns.map((c) => (c.id === id ? { ...c, hidden } : c));
}

export function setWidth(columns: readonly ViewColumn[], id: string, width: number): ViewColumn[] {
  return columns.map((c) => (c.id === id ? { ...c, width: clampWidth(width) } : c));
}

/** Moves a column past its next shown neighbour to the left (-1) or right (+1); hidden ones are skipped. */
export function moveColumn(
  columns: readonly ViewColumn[],
  id: string,
  direction: -1 | 1,
): ViewColumn[] {
  const result = [...columns];
  const from = result.findIndex((c) => c.id === id);
  if (from < 0) return result;
  let to = from + direction;
  while (to >= 0 && to < result.length && result[to].hidden) to += direction;
  if (to < 0 || to >= result.length) return result;
  const [moved] = result.splice(from, 1);
  result.splice(to, 0, moved);
  return result;
}

/** Whether a column can move that way (a shown neighbour exists). */
export function canMove(columns: readonly ViewColumn[], id: string, direction: -1 | 1): boolean {
  return moveColumn(columns, id, direction).some((c, i) => c.id !== columns[i].id);
}

/**
 * The layout after the user dragged or resized columns in the table: its order and widths. The last shown
 * column fills the rest of the view, its width is not the user's: it keeps the saved one.
 */
export function layoutFromTable(
  before: readonly ViewColumn[],
  order: readonly string[],
  widths: Readonly<Record<string, number>>,
): ViewColumn[] {
  const byId = new Map(before.map((c) => [c.id, c]));
  const ordered = order.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
  for (const c of before) if (!ordered.includes(c)) ordered.push(c);
  const last = lastShown(ordered);
  return ordered.map((c) =>
    c.id === last?.id || widths[c.id] === undefined ? c : { ...c, width: clampWidth(widths[c.id]) },
  );
}

export function lastShown(columns: readonly ViewColumn[]): ViewColumn | undefined {
  for (let i = columns.length - 1; i >= 0; i--) if (!columns[i].hidden) return columns[i];
  return undefined;
}

/** Width of the last shown column: at least its content, otherwise the rest of the view. */
export function fillWidth(neededContent: number, freeWidth: number, othersWidth: number): number {
  return Math.ceil(Math.max(MIN_COLUMN_WIDTH, neededContent, freeWidth - othersWidth));
}

/**
 * A line that is not split runs over all columns from the first one: a continuation (stack trace) or a
 * line the layout does not match, which the backend puts into `message` as a whole.
 */
export function spansRow(line: LogLine, messageField: number): boolean {
  if (line.isContinuation) return true;
  const fields = line.fields;
  if (!fields?.length || messageField < 0) return true;
  for (let i = 0; i < fields.length; i++) {
    if (i !== messageField && fields[i][1] > fields[i][0]) return false;
  }
  const message = fields[messageField];
  return !!message && message[0] === 0 && message[1] >= line.text.length;
}

/**
 * The column a spanning row starts in: the first one that is still (partly) visible at `scrollLeft`, so the
 * table renders it; `widths` are the data columns in table order (0 = hidden). Returns the index into `widths`
 * and the x of that column, by which its text moves left to start at the first column.
 */
export function spanStart(
  widths: readonly number[],
  scrollLeft: number,
): { index: number; offset: number } {
  let x = 0;
  let lastShownIndex = -1;
  let lastShownX = 0;
  for (let i = 0; i < widths.length; i++) {
    const w = widths[i];
    if (w <= 0) continue;
    if (x + w > scrollLeft) return { index: i, offset: x };
    lastShownIndex = i;
    lastShownX = x;
    x += w;
  }
  return lastShownIndex < 0
    ? { index: 0, offset: 0 }
    : { index: lastShownIndex, offset: lastShownX };
}

/**
 * Cuts the segments of a line (tokens, matches) at `[start, end)` in UTF-16 code units; a segment that crosses
 * a boundary is split, its class stays.
 */
export function sliceSegments(
  segments: readonly TextSegment[],
  start: number,
  end: number,
): TextSegment[] {
  const out: TextSegment[] = [];
  if (end <= start) return out;
  let pos = 0;
  for (const seg of segments) {
    const segEnd = pos + seg.text.length;
    if (segEnd > start && pos < end) {
      const from = Math.max(start, pos) - pos;
      const to = Math.min(end, segEnd) - pos;
      out.push({ text: seg.text.slice(from, to), cls: seg.cls });
    }
    if (segEnd >= end) break;
    pos = segEnd;
  }
  return out;
}
