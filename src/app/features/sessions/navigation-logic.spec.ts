import { describe, expect, it } from 'vitest';
import { Level } from '../../core/log/log.models';
import { ALL_SOURCES } from '../merge/merge-logic';
import { ALL_LEVELS } from './filter-logic';
import {
  KeptFilter,
  filterActive,
  fullLogOf,
  jumpScroll,
  nextBookmark,
  toggleBookmark,
} from './navigation-logic';

const query = (text: string) => ({ text, isRegex: false, caseSensitive: false });
const filter = (change: Partial<KeptFilter> = {}): KeptFilter => ({
  levels: ALL_LEVELS,
  query: query(''),
  mode: 'filter',
  sourceMask: ALL_SOURCES,
  ...change,
});

describe('navigation-logic', () => {
  it('jumps with a few rows of context above', () => {
    expect(jumpScroll(100)).toEqual({ top: 95, subPx: 0 });
    expect(jumpScroll(2)).toEqual({ top: 0, subPx: 0 });
  });

  it('toggles bookmarks without changing the old set', () => {
    const before = new Set([3]);
    const after = toggleBookmark(before, 5);
    expect([...after].sort()).toEqual([3, 5]);
    expect([...toggleBookmark(after, 3)]).toEqual([5]);
    expect([...before]).toEqual([3]);
  });

  it('finds the next and previous bookmark and wraps around', () => {
    const marks = new Set([40, 10, 25]);
    expect(nextBookmark(marks, 10, true)).toEqual({ line: 25, wrapped: false });
    expect(nextBookmark(marks, 10, true, true)).toEqual({ line: 10, wrapped: false });
    expect(nextBookmark(marks, 40, true)).toEqual({ line: 10, wrapped: true });
    expect(nextBookmark(marks, 25, false)).toEqual({ line: 10, wrapped: false });
    expect(nextBookmark(marks, 10, false)).toEqual({ line: 40, wrapped: true });
    expect(nextBookmark(marks, null, false)).toEqual({ line: 40, wrapped: false });
    expect(nextBookmark(new Set(), 3, true)).toBeNull();
  });

  it('knows when a filter hides lines', () => {
    expect(filterActive(filter(), 0)).toBe(false);
    expect(filterActive(filter({ levels: new Set<Level>(['ERROR']) }), 0)).toBe(true);
    expect(filterActive(filter({ query: query('x') }), 0)).toBe(true);
    expect(filterActive(filter({ query: query('x'), mode: 'highlight' }), 0)).toBe(false);
    expect(filterActive(filter({ sourceMask: 0b01 }), 2)).toBe(true);
    expect(filterActive(filter({ sourceMask: 0b11 }), 2)).toBe(false);
  });

  it('opens the full log with the search as highlighting', () => {
    const kept = filter({ levels: new Set<Level>(['ERROR']), query: query('x'), sourceMask: 1 });
    const full = fullLogOf(kept);
    expect(full.levels).toBe(ALL_LEVELS);
    expect(full.mode).toBe('highlight');
    expect(full.query.text).toBe('x');
    expect(full.sourceMask).toBe(ALL_SOURCES);
    expect(fullLogOf(filter({ levels: new Set<Level>(['WARN']) })).mode).toBe('filter');
    expect(filterActive(full, 2)).toBe(false);
  });
});
