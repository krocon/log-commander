import { Level, SearchMode, SearchQuery } from '../../core/log/log.models';
import { ALL_SOURCES, allVisible } from '../merge/merge-logic';
import { ALL_LEVELS, sameLevels } from './filter-logic';
import { ScrollPos } from './session-state';

/** Rows above a jump target, so it is not glued to the top edge (as `find` does). */
export const JUMP_CONTEXT = 5;

/** Scroll position that shows `position` with a few rows above it. */
export function jumpScroll(position: number): ScrollPos {
  return { top: Math.max(0, position - JUMP_CONTEXT), subPx: 0 };
}

/** Bookmarks (line numbers) after toggling `line`. */
export function toggleBookmark(bookmarks: ReadonlySet<number>, line: number): ReadonlySet<number> {
  const next = new Set(bookmarks);
  if (!next.delete(line)) next.add(line);
  return next;
}

/**
 * The next bookmark after `from` (or before it), wrapping around once. `inclusive` counts `from` itself (a
 * reader at the top of the view, no previous jump). Null `from`: from the start or the end.
 */
export function nextBookmark(
  bookmarks: ReadonlySet<number>,
  from: number | null,
  forward: boolean,
  inclusive = false,
): { line: number; wrapped: boolean } | null {
  const sorted = [...bookmarks].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (from === null)
    return { line: forward ? sorted[0] : sorted[sorted.length - 1], wrapped: false };
  if (forward) {
    const hit = sorted.find((line) => (inclusive ? line >= from : line > from));
    return hit === undefined ? { line: sorted[0], wrapped: true } : { line: hit, wrapped: false };
  }
  const hit = [...sorted].reverse().find((line) => (inclusive ? line <= from : line < from));
  return hit === undefined
    ? { line: sorted[sorted.length - 1], wrapped: true }
    : { line: hit, wrapped: false };
}

/** The filter of a tab, as `revealInFullLog` keeps it for the way back. */
export interface KeptFilter {
  levels: ReadonlySet<Level>;
  query: SearchQuery;
  mode: SearchMode;
  sourceMask: number;
}

/** The view hides lines: levels, a filtering search or sources of a merge. */
export function filterActive(filter: KeptFilter, sourceCount: number): boolean {
  return (
    !sameLevels(filter.levels, ALL_LEVELS) ||
    (filter.mode === 'filter' && filter.query.text !== '') ||
    (sourceCount > 0 && !allVisible(filter.sourceMask, sourceCount))
  );
}

/**
 * The full log for a filter: all levels and sources. A filtering search turns into highlighting, so the
 * hits stay marked where they are; the text stays and the way back filters with it again.
 */
export function fullLogOf(filter: KeptFilter): KeptFilter {
  return {
    levels: ALL_LEVELS,
    query: filter.query,
    mode: filter.query.text ? 'highlight' : filter.mode,
    sourceMask: ALL_SOURCES,
  };
}
