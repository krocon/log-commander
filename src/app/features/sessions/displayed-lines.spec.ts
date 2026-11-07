import { describe, expect, it } from 'vitest';
import { LoadedLines, nextDisplayedLines } from './displayed-lines';

/** Pages as [start, end) ranges. */
const pages = (...ranges: [number, number][]): LoadedLines => ({
  has: (p) => ranges.some(([start, end]) => p >= start && p < end),
  pageEnds: () => ranges.map(([, end]) => end),
});

const base = { displayed: 100, target: 150, follow: true, top: 70, rows: 30 };

describe('nextDisplayedLines', () => {
  describe('following', () => {
    it('stays until the new lines are here', () => {
      expect(nextDisplayedLines({ ...base, loaded: pages([0, 100]) })).toBe(100);
    });

    it('moves to the end in one step when they arrive', () => {
      expect(nextDisplayedLines({ ...base, loaded: pages([0, 200]) })).toBe(150);
    });

    it('moves as far as a load that a newer update overtook reached', () => {
      expect(nextDisplayedLines({ ...base, loaded: pages([0, 130]) })).toBe(130);
    });

    it('jumps over lines it does not need, a burst must not load all of them', () => {
      const loaded = pages([0, 100], [10_000, 10_200]);
      expect(nextDisplayedLines({ ...base, target: 10_150, loaded })).toBe(10_150);
    });

    it('waits for the page before when the end alone does not fill the view', () => {
      const input = { ...base, displayed: 190, target: 205 };
      expect(nextDisplayedLines({ ...input, loaded: pages([200, 205]) })).toBe(190);
      expect(nextDisplayedLines({ ...input, loaded: pages([0, 200], [200, 205]) })).toBe(205);
    });

    it('handles a view with fewer lines than rows', () => {
      const input = { ...base, displayed: 0, target: 5 };
      expect(nextDisplayedLines({ ...input, loaded: pages() })).toBe(0);
      expect(nextDisplayedLines({ ...input, loaded: pages([0, 5]) })).toBe(5);
    });
  });

  describe('reading', () => {
    const reading = { ...base, follow: false };

    it('takes the new count at once when they are out of view', () => {
      expect(nextDisplayedLines({ ...reading, top: 10, loaded: pages() })).toBe(150);
    });

    it('waits when new lines would come into view', () => {
      expect(nextDisplayedLines({ ...reading, top: 90, loaded: pages([0, 100]) })).toBe(100);
    });

    it('moves up to what is here', () => {
      expect(nextDisplayedLines({ ...reading, top: 90, loaded: pages([0, 110]) })).toBe(110);
    });

    it('takes all once the view is covered', () => {
      expect(nextDisplayedLines({ ...reading, top: 90, loaded: pages([0, 120]) })).toBe(150);
    });
  });

  it('follows a shrinking view without waiting', () => {
    expect(nextDisplayedLines({ ...base, target: 99, loaded: pages() })).toBe(99);
    expect(nextDisplayedLines({ ...base, follow: false, target: 0, loaded: pages() })).toBe(0);
  });
});
