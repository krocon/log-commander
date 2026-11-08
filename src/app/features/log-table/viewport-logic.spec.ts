import { describe, expect, it } from 'vitest';
import {
  revealBelow,
  revealRows,
  MAX_SCROLL_RANGE,
  bottomAnchor,
  maxTop,
  scrollBy,
  scrollRange,
  scrollTopToTop,
  topToScrollTop,
  visibleRowCount,
} from './viewport-logic';

const metrics = { count: 1000, viewportH: 200, rowH: 20 };

describe('viewport logic', () => {
  it('bottom anchor shows the last lines', () => {
    expect(bottomAnchor(metrics)).toEqual({ top: 990, subPx: 0 });
    expect(bottomAnchor({ ...metrics, viewportH: 210 })).toEqual({ top: 989, subPx: 10 });
  });

  it('few lines stay at the top', () => {
    expect(bottomAnchor({ ...metrics, count: 3 })).toEqual({ top: 0, subPx: 0 });
    expect(scrollBy({ top: 0, subPx: 0 }, 100, { ...metrics, count: 3 }).atBottom).toBe(true);
  });

  it('scrolls by pixels across rows', () => {
    const down = scrollBy({ top: 10, subPx: 5 }, 40, metrics);
    expect(down).toEqual({ pos: { top: 12, subPx: 5 }, atBottom: false });
    const up = scrollBy({ top: 10, subPx: 5 }, -10, metrics);
    expect(up.pos).toEqual({ top: 9, subPx: 15 });
  });

  it('stops at the start and reports the end', () => {
    expect(scrollBy({ top: 0, subPx: 0 }, -100, metrics).pos).toEqual({ top: 0, subPx: 0 });
    const end = scrollBy({ top: 985, subPx: 0 }, 500, metrics);
    expect(end).toEqual({ pos: { top: 990, subPx: 0 }, atBottom: true });
  });

  it('uses measured heights for wrapped lines', () => {
    const wrapped = { ...metrics, heightOf: (p: number) => (p === 10 ? 60 : 20) };
    expect(scrollBy({ top: 10, subPx: 0 }, 50, wrapped).pos).toEqual({ top: 10, subPx: 50 });
    expect(scrollBy({ top: 11, subPx: 0 }, -10, wrapped).pos).toEqual({ top: 10, subPx: 50 });
    expect(
      bottomAnchor({ count: 11, viewportH: 80, rowH: 20, heightOf: wrapped.heightOf }),
    ).toEqual({ top: 9, subPx: 0 });
  });

  it('caps the scroll range but still reaches every line', () => {
    const huge = 50_000_000;
    expect(scrollRange(huge, 600, 20)).toBe(MAX_SCROLL_RANGE);
    const last = maxTop(huge, 600, 20);
    expect(scrollTopToTop(MAX_SCROLL_RANGE, huge, 600, 20)).toBe(last);
    expect(scrollTopToTop(0, huge, 600, 20)).toBe(0);
    expect(topToScrollTop(last, huge, 600, 20)).toBe(MAX_SCROLL_RANGE);
    const middle = topToScrollTop(last / 2, huge, 600, 20);
    expect(middle).toBeCloseTo(MAX_SCROLL_RANGE / 2);
  });

  it('small views map one to one', () => {
    expect(scrollRange(1000, 200, 20)).toBe(990 * 20);
    expect(topToScrollTop(5, 1000, 200, 20)).toBeCloseTo(100);
    expect(scrollTopToTop(100, 1000, 200, 20)).toBe(5);
    expect(scrollRange(5, 200, 20)).toBe(0);
    expect(scrollTopToTop(10, 5, 200, 20)).toBe(0);
  });

  it('renders enough rows to cover partial ones', () => {
    expect(visibleRowCount(200, 20)).toBe(12);
  });

  it('brings a row hidden below the viewport back to the bottom edge', () => {
    const m = { count: 1000, viewportH: 200, rowH: 20 };
    // Rows 100..109 are visible from top 100.
    expect(revealBelow({ top: 100, subPx: 0 }, 105, m)).toBeNull();
    expect(revealBelow({ top: 100, subPx: 0 }, 109, m)).toBeNull();
    expect(revealBelow({ top: 100, subPx: 0 }, 99, m)).toBeNull();
    expect(revealBelow({ top: 100, subPx: 0 }, 110, m)).toEqual({ top: 101, subPx: 0 });
    expect(revealBelow({ top: 100, subPx: 0 }, 130, { ...m, viewportH: 190 })).toEqual({
      top: 121,
      subPx: 10,
    });
  });
});

describe('revealRows', () => {
  // 10 rows of 20 px in view.
  const m = { count: 1000, viewportH: 200, rowH: 20 };
  const at = { top: 100, subPx: 0 };

  it('leaves visible rows alone', () => {
    expect(revealRows(at, 100, 100, m)).toBeNull();
    expect(revealRows(at, 105, 109, m)).toBeNull();
  });

  it('scrolls up just to the first row', () => {
    expect(revealRows(at, 99, 99, m)).toEqual({ top: 99, subPx: 0 });
    expect(revealRows({ top: 100, subPx: 7 }, 100, 100, m)).toEqual({ top: 100, subPx: 0 });
  });

  it('scrolls down just so the last row is at the bottom edge', () => {
    expect(revealRows(at, 110, 110, m)).toEqual({ top: 101, subPx: 0 });
    expect(revealRows(at, 110, 112, m)).toEqual({ top: 103, subPx: 0 });
  });

  it('shows the start of an entry taller than the view', () => {
    expect(revealRows(at, 108, 130, m)).toEqual({ top: 108, subPx: 0 });
  });

  it('respects a partly visible last row', () => {
    expect(revealRows({ top: 100, subPx: 5 }, 110, 110, m)).toEqual({ top: 101, subPx: 0 });
    expect(revealRows({ top: 100, subPx: 0 }, 0, 0, { ...m, viewportH: 190 })).toEqual({
      top: 0,
      subPx: 0,
    });
  });
});
