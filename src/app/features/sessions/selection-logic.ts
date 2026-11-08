import { LineSelection } from './session-state';

/** First and last line of an entry (head + continuations), as `getEntryRange` answers. */
export interface LineRange {
  first: number;
  last: number;
}

/** -1: towards the start of the log, 1: towards its end. */
export type Direction = -1 | 1;

/**
 * The selection spanning from the anchor's entry to the target's entry, in either direction. The anchor stays,
 * so a further extension (Shift+click, Shift+arrow) keeps the entry it started from completely.
 */
export function extendSelection(
  anchor: number,
  anchorEntry: LineRange,
  target: LineRange,
): LineSelection {
  return {
    anchor,
    first: Math.min(anchorEntry.first, target.first),
    last: Math.max(anchorEntry.last, target.last),
  };
}

/**
 * The line whose entry moves with Shift+arrow: the end of the selection away from the anchor. A selection that
 * grew upwards moves at its top, otherwise at its bottom (also when it is only the anchor's entry).
 */
export function headLine(selection: LineSelection): number {
  return selection.first < selection.anchor ? selection.first : selection.last;
}

/**
 * Which line to ask the view position of, and the row offset from it, to find the row next to `from` in the
 * view. `getPosition` answers the row of a line or of the next visible line after it, so a hidden boundary line
 * still lands on the right neighbour: below is the first visible line after `from.last`, above is the row before
 * the first visible line of `from`.
 */
export function neighbourQuery(
  from: LineRange,
  direction: Direction,
): { line: number; offset: number } {
  return direction > 0 ? { line: from.last + 1, offset: 0 } : { line: from.first, offset: -1 };
}

/** The row of the neighbour, or null beyond the ends of the view (`count` rows). */
export function neighbourRow(position: number, offset: number, count: number): number | null {
  const row = position + offset;
  return row >= 0 && row < count ? row : null;
}

/** The selection after an arrow step onto `target` (its entry). */
export function steppedSelection(
  selection: LineSelection,
  target: LineRange,
  extend: boolean,
  anchorEntry: LineRange | null,
): LineSelection {
  if (extend && anchorEntry) return extendSelection(selection.anchor, anchorEntry, target);
  return { anchor: target.first, first: target.first, last: target.last };
}
