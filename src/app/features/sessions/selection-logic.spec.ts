import { describe, expect, it } from 'vitest';
import {
  extendSelection,
  headLine,
  neighbourQuery,
  neighbourRow,
  steppedSelection,
} from './selection-logic';

// Entries of the Spring Boot sample: 0..4 single lines, 5..12 a stack trace, 13, 14.
const stack = { first: 5, last: 12 };
const single = (n: number) => ({ first: n, last: n });

describe('extendSelection', () => {
  it('keeps the whole anchor entry when extending upwards', () => {
    expect(extendSelection(5, stack, single(3))).toEqual({ anchor: 5, first: 3, last: 12 });
  });

  it('reaches the end of the target entry downwards', () => {
    expect(extendSelection(4, single(4), stack)).toEqual({ anchor: 4, first: 4, last: 12 });
  });

  it('shrinks back to the anchor entry', () => {
    expect(extendSelection(5, stack, single(9))).toEqual({ anchor: 5, first: 5, last: 12 });
  });
});

describe('headLine', () => {
  it('is the bottom of a selection that is only the anchor entry', () => {
    expect(headLine({ anchor: 5, first: 5, last: 12 })).toBe(12);
  });

  it('is the bottom of a selection grown downwards', () => {
    expect(headLine({ anchor: 3, first: 3, last: 12 })).toBe(12);
  });

  it('is the top of a selection grown upwards', () => {
    expect(headLine({ anchor: 13, first: 5, last: 13 })).toBe(5);
  });
});

describe('neighbourQuery and neighbourRow', () => {
  it('asks for the line after the entry below', () => {
    expect(neighbourQuery(stack, 1)).toEqual({ line: 13, offset: 0 });
  });

  it('asks for the row before the entry above', () => {
    expect(neighbourQuery(stack, -1)).toEqual({ line: 5, offset: -1 });
  });

  it('stops at both ends of the view', () => {
    expect(neighbourRow(0, -1, 15)).toBeNull();
    expect(neighbourRow(15, 0, 15)).toBeNull();
    expect(neighbourRow(14, 0, 15)).toBe(14);
    expect(neighbourRow(5, -1, 15)).toBe(4);
  });

  it('a filtered view: positions, not lines, decide the neighbour', () => {
    // Only lines 2, 7 and 20 visible: 7 is at row 1, the line after the entry 7..9 is the first visible after 9.
    expect(neighbourRow(2, neighbourQuery({ first: 7, last: 9 }, 1).offset, 3)).toBe(2);
    expect(neighbourRow(1, neighbourQuery({ first: 7, last: 9 }, -1).offset, 3)).toBe(0);
  });
});

describe('steppedSelection', () => {
  const sel = { anchor: 5, first: 5, last: 12 };

  it('moves to the target entry', () => {
    expect(steppedSelection(sel, single(13), false, null)).toEqual({
      anchor: 13,
      first: 13,
      last: 13,
    });
  });

  it('extends from the anchor entry', () => {
    expect(steppedSelection(sel, single(13), true, stack)).toEqual({
      anchor: 5,
      first: 5,
      last: 13,
    });
  });
});
