import { describe, expect, it } from 'vitest';
import { LogLine } from '../../core/log/log.models';
import {
  contentTop,
  contentTopFromScrollbar,
  holdForSelection,
  isDrag,
  posFromContentTop,
  rowClasses,
  textColumnWidth,
} from './table-logic';

const line = (n: number, extra: Partial<LogLine> = {}): LogLine =>
  ({
    line: n,
    level: 'ERROR',
    isContinuation: false,
    text: 'x',
    matches: [],
    fields: [],
    truncated: false,
    ...extra,
  }) as LogLine;

describe('rowClasses', () => {
  it('marks a missing line as loading', () => {
    expect(rowClasses(null, null, null)).toEqual(['lt-row', 'loading']);
  });

  it('carries level, continuation, selection and current hit', () => {
    const classes = rowClasses(
      line(5, { isContinuation: true }),
      { anchor: 4, first: 4, last: 6 },
      5,
    );
    expect(classes).toEqual(['lt-row', 'lv-ERROR', 'cont', 'selected', 'current-hit']);
  });

  it('leaves out a selection that does not contain the line', () => {
    expect(rowClasses(line(9), { anchor: 1, first: 1, last: 3 }, null)).toEqual([
      'lt-row',
      'lv-ERROR',
    ]);
  });
});

describe('content pixels', () => {
  it('round-trip between position and pixel', () => {
    expect(contentTop({ top: 10, subPx: 7 }, 20)).toBe(207);
    expect(posFromContentTop(207, 20)).toEqual({ top: 10, subPx: 7 });
    expect(posFromContentTop(-5, 20)).toEqual({ top: 0, subPx: 0 });
  });

  it('maps a capped scroll bar linearly onto the content', () => {
    // 10 million rows of 20 px, bar range 8 million px minus the viewport.
    const content = 10_000_000 * 20;
    const range = 8_000_000 - 600;
    expect(contentTopFromScrollbar(range / 2, range, content, 600)).toBeCloseTo(
      (content - 600) / 2,
    );
    expect(contentTopFromScrollbar(range * 2, range, content, 600)).toBe(content - 600);
    expect(contentTopFromScrollbar(10, 0, content, 600)).toBe(0);
  });
});

describe('holdForSelection', () => {
  it('holds only a selection the user dragged while reading', () => {
    expect(holdForSelection(false, true, true)).toBe(true);
    expect(holdForSelection(true, true, true)).toBe(false);
    expect(holdForSelection(false, false, true)).toBe(false);
  });

  it('never holds for a stale selection (double click, script)', () => {
    expect(holdForSelection(false, true, false)).toBe(false);
  });
});

describe('isDrag', () => {
  it('is a click while the pointer stays within 4 px', () => {
    expect(isDrag(0, 0)).toBe(false);
    expect(isDrag(2, 2)).toBe(false);
    expect(isDrag(-3, 0)).toBe(false);
  });

  it('is a drag from 4 px on, in any direction', () => {
    expect(isDrag(4, 0)).toBe(true);
    expect(isDrag(0, -30)).toBe(true);
    expect(isDrag(3, 3)).toBe(true);
  });
});

describe('textColumnWidth', () => {
  it('is the widest text plus room, at least the free width', () => {
    expect(textColumnWidth(100, 800)).toBe(800);
    expect(textColumnWidth(1000.2, 800)).toBe(1025);
  });
});
