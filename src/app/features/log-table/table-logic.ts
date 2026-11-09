import { LogLine } from '../../core/log/log.models';
import { LineSelection, ScrollPos } from '../sessions/session-state';

/** Classes of one row of the table, set on both cells (gutter and text). */
export function rowClasses(
  line: LogLine | null,
  selection: LineSelection | null,
  hitLine: number | null,
): string[] {
  if (!line) return ['lt-row', 'loading'];
  const classes = ['lt-row', `lv-${line.level}`];
  if (line.isContinuation) classes.push('cont');
  if (selection && line.line >= selection.first && line.line <= selection.last) {
    classes.push('selected');
  }
  if (line.line === hitLine) classes.push('current-hit');
  return classes;
}

/** The content pixel of a line position: what the table's `scrollToPixel` takes. */
export function contentTop(pos: ScrollPos, rowH: number): number {
  return pos.top * rowH + pos.subPx;
}

/** Back from a content pixel to line + offset. */
export function posFromContentTop(px: number, rowH: number): ScrollPos {
  const clamped = Math.max(0, px);
  const top = Math.floor(clamped / rowH);
  return { top, subPx: Math.round(clamped - top * rowH) };
}

/**
 * Content pixel the table shows for a scroll bar position: the bar maps linearly onto the content
 * (capped at 8 million px, see the table's `EleScope.maxScrollHeightInPx`).
 */
export function contentTopFromScrollbar(
  scrollTop: number,
  scrollerRange: number,
  contentHeight: number,
  bodyHeight: number,
): number {
  const contentRange = Math.max(0, contentHeight - bodyHeight);
  if (scrollerRange <= 0 || contentRange <= 0) return 0;
  return Math.min(1, Math.max(0, scrollTop / scrollerRange)) * contentRange;
}

/**
 * Every repaint of the table rebuilds the rows' DOM, which ends a mouse selection of text. While the user drags
 * out a selection in the table (or keeps the one he dragged) and does not follow, the view waits; the scroll bar
 * is stale until then. Any other selection (left from a double click, made by a script, lying elsewhere) must
 * never freeze the view.
 */
export function holdForSelection(
  follow: boolean,
  selectionInTable: boolean,
  userDrag: boolean,
): boolean {
  return !follow && selectionInTable && userDrag;
}

/** From this distance (px) on, a press of the mouse is a drag (marks text), below it a click. */
export const DRAG_THRESHOLD_PX = 4;

/**
 * Whether the table's `draggingX`/`draggingY` of a press make it a drag. A drag marks text instead of selecting
 * the entry (filter on marked text, copy); a hand that shakes a little still clicks.
 */
export function isDrag(draggingX: number, draggingY: number): boolean {
  return Math.hypot(draggingX, draggingY) >= DRAG_THRESHOLD_PX;
}

/** Width the text column needs: the widest text seen so far, at least the free width. */
export function textColumnWidth(widestText: number, freeWidth: number): number {
  return Math.ceil(Math.max(widestText + 24, freeWidth));
}

/** Everything one draw of the table shows. */
export interface DrawState {
  count: number;
  rowH: number;
  pos: { top: number; subPx: number };
  left: number;
  revision: number;
  /** Lines in the file (the gutter width follows its digits). */
  total: number;
  marks: string;
  follow: boolean;
  /**
   * The lines on screen as the cache holds them (`null` = still loading). The cache's `revision` rises with every
   * page that arrives, also the new end far below a reader; equal objects here mean the cells on screen stay.
   */
  rows?: readonly (LogLine | null)[];
}

/** Same rows on screen: the same line objects (a reloaded page brings new ones, a cleared cache `null`). */
export function sameRows(
  a: readonly (LogLine | null)[] | undefined,
  b: readonly (LogLine | null)[] | undefined,
): boolean {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Identity of a picture: everything a draw shows. Two equal keys draw the same cells, so the second draw is
 * skipped (it would only rebuild the cells, and a rebuild during a click loses that click).
 */
export function drawKey(state: DrawState, forced: readonly number[]): string {
  const { count, rowH, pos, left, revision, total, marks, follow } = state;
  return [
    count,
    rowH,
    pos.top,
    pos.subPx,
    left,
    revision,
    total,
    follow ? 1 : 0,
    ...forced,
    marks,
  ].join('|');
}

/**
 * True if the only change is lines arriving behind the view while the reader is not following: the cells on
 * screen stay (same line objects, whatever else the cache loaded), only the scroll bar grows. Such draws go through the table's `rowsAppended` (no render).
 */
export function growsOnlyBehindView(
  prev: DrawState | null,
  next: DrawState,
  prevForced: string,
  nextForced: string,
  visibleRows: number,
): boolean {
  if (!prev || prev.follow || next.follow || next.count <= prev.count) return false;
  if (prevForced !== nextForced || prev.rowH !== next.rowH || prev.left !== next.left) return false;
  if (prev.pos.top !== next.pos.top || prev.pos.subPx !== next.pos.subPx) return false;
  if (prev.marks !== next.marks || !sameRows(prev.rows, next.rows)) return false;
  if (String(prev.total).length !== String(next.total).length) return false;
  return prev.pos.top + visibleRows + 1 < prev.count;
}
