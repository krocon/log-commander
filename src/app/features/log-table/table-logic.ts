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
