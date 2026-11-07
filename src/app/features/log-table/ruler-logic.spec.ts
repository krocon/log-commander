import { describe, expect, it } from 'vitest';
import {
  MIN_MARK_PX,
  RulerPin,
  band,
  bucketPositions,
  clickTarget,
  levelBit,
  levelsFrom,
  markAt,
  positionToY,
  rulerMarks,
  rulerTooltip,
  topLevel,
  yToPosition,
} from './ruler-logic';

const E = levelBit('ERROR');
const W = levelBit('WARN');
const F = levelBit('FATAL');
const I = levelBit('INFO');

describe('ruler-logic', () => {
  it('maps positions to pixels and back', () => {
    expect(positionToY(0, 1000, 500)).toBe(0);
    expect(positionToY(500, 1000, 500)).toBe(250);
    expect(positionToY(2000, 1000, 500)).toBe(500);
    expect(yToPosition(250, 1000, 500)).toBe(500);
    expect(yToPosition(500, 1000, 500)).toBe(999);
    expect(yToPosition(-3, 1000, 500)).toBe(0);
    expect(yToPosition(10, 0, 500)).toBe(0);
    // Round trip within one pixel's worth of lines.
    for (const p of [0, 1, 17, 499, 998]) {
      expect(Math.abs(yToPosition(positionToY(p, 1000, 500), 1000, 500) - p)).toBeLessThanOrEqual(
        1,
      );
    }
  });

  it('puts FATAL before ERROR before WARN', () => {
    expect(topLevel(W | E)).toBe('ERROR');
    expect(topLevel(W | E | F)).toBe('FATAL');
    expect(topLevel(W | I)).toBe('WARN');
    expect(topLevel(I)).toBeNull();
    expect(levelsFrom('WARN')).toEqual(['WARN', 'ERROR', 'FATAL']);
    expect(levelsFrom('ERROR')).toEqual(['ERROR', 'FATAL']);
  });

  it('merges neighbouring buckets of the same level into one mark', () => {
    const buckets = [0, E, E | W, W, 0, F | E, I];
    const marks = rulerMarks(buckets, 7);
    expect(marks.map((m) => [m.level, m.from, m.to])).toEqual([
      ['ERROR', 1, 3],
      ['WARN', 3, 4],
      ['FATAL', 5, 6],
    ]);
    expect(marks[0].levels).toEqual(['ERROR', 'WARN']);
  });

  it('keeps a single error among millions visible with the minimum height', () => {
    const buckets = new Array<number>(800).fill(I);
    buckets[799] = E;
    const marks = rulerMarks(buckets, 800);
    expect(marks).toHaveLength(1);
    expect(marks[0].h).toBe(MIN_MARK_PX);
    // Inside the ruler at the bottom edge.
    expect(marks[0].y + marks[0].h).toBeLessThanOrEqual(800);
    buckets[799] = I;
    buckets[0] = E;
    expect(rulerMarks(buckets, 800)[0].y).toBe(0);
  });

  it('finds the mark under the pointer, the more severe one where they overlap', () => {
    const marks = rulerMarks([0, 0, E, W, 0, 0], 6);
    expect(markAt(marks, 2.5)?.level).toBe('ERROR');
    expect(markAt(marks, 0)).toBeNull();
  });

  it('covers the positions of buckets', () => {
    expect(bucketPositions(0, 1, 100, 1000)).toEqual({ start: 0, end: 10 });
    expect(bucketPositions(99, 100, 100, 1000)).toEqual({ start: 990, end: 1000 });
    // More buckets than lines.
    expect(bucketPositions(5, 6, 10, 3)).toEqual({ start: 2, end: 2 });
  });

  it('draws the visible band at least a few pixels high', () => {
    expect(band(500, 40, 1000, 500)).toEqual({ y: 250, h: 20 });
    expect(band(0, 40, 10_000_000, 500)?.h).toBe(6);
    expect(band(999_999, 40, 1_000_000, 500)?.y).toBe(494);
    expect(band(0, 40, 0, 500)).toBeNull();
  });

  it('a click goes to a pin first, then to the mark, else to the proportional position', () => {
    const buckets = new Array<number>(100).fill(0);
    buckets[50] = E;
    const marks = rulerMarks(buckets, 100);
    const pins: RulerPin[] = [{ kind: 'bookmark', line: 7, position: 200, visible: true }];
    const view = { marks, pins, count: 1000, height: 100, buckets: 100 };
    expect(clickTarget(20, view)).toEqual({ kind: 'position', position: 200 });
    expect(clickTarget(50.5, view)).toEqual({
      kind: 'level',
      from: 499,
      levels: ['ERROR', 'FATAL'],
      fallback: 500,
    });
    expect(clickTarget(80, view)).toEqual({ kind: 'position', position: 800 });
    // A mark in the first bucket searches from the start.
    buckets[0] = W;
    const first = clickTarget(0.5, { ...view, marks: rulerMarks(buckets, 100), pins: [] });
    expect(first).toMatchObject({ kind: 'level', from: null, levels: ['WARN', 'ERROR', 'FATAL'] });
  });

  it('tells in words what a mark or pin is', () => {
    const buckets = new Array<number>(100).fill(0);
    buckets[10] = E | W;
    const marks = rulerMarks(buckets, 100);
    const pins: RulerPin[] = [{ kind: 'selection', line: 41, position: 900, visible: false }];
    const view = { marks, pins, count: 1000, height: 100, buckets: 100 };
    expect(rulerTooltip(10.5, view)).toContain('ERROR, WARN');
    expect(rulerTooltip(10.5, view)).toContain('Zeilen 101–110');
    expect(rulerTooltip(90, view)).toBe('Gewählte Zeile: Zeile 42 (vom Filter ausgeblendet)');
    expect(rulerTooltip(50, view)).toBe('Klick springt an diese Stelle');
  });
});
