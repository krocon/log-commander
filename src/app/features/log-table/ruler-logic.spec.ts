import {
  MIN_MARK_PX,
  RULER_LEVELS,
  RulerLevel,
  RulerPin,
  band,
  barWidth,
  bucketPositions,
  clickTarget,
  levelsFrom,
  marksAt,
  positionToY,
  rulerLanes,
  rulerMarks,
  rulerRects,
  rulerTooltip,
  yToPosition,
} from './ruler-logic';

type Densities = Partial<Record<RulerLevel, number>>;

/** `Overview.density` from densities 0–1 per bucket. */
function dens(buckets: readonly Densities[]): number[] {
  return buckets.flatMap((b) => RULER_LEVELS.map((l) => Math.round((b[l] ?? 0) * 255)));
}
const E: Densities = { ERROR: 1 };
const W: Densities = { WARN: 1 };
const none: Densities = {};
/** The ruler is 14 px wide with a 1 px border: 13 px of canvas. */
const WIDTH = 13;

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
    expect(levelsFrom('WARN')).toEqual(['WARN', 'ERROR', 'FATAL']);
    expect(levelsFrom('ERROR')).toEqual(['ERROR', 'FATAL']);
  });

  it('gives every level its own runs, so none hides another', () => {
    const marks = rulerMarks(
      dens([none, E, { ERROR: 1, WARN: 1 }, W, none, { FATAL: 1, ERROR: 1 }]),
      6,
    );
    expect(marks.map((m) => [m.level, m.from, m.to])).toEqual([
      ['FATAL', 5, 6],
      ['ERROR', 1, 3],
      ['ERROR', 5, 6],
      ['WARN', 2, 4],
    ]);
  });

  it('keeps a single error among millions visible with the minimum height', () => {
    const buckets = new Array<Densities>(800).fill(none);
    // One line among 1250 per pixel: the smallest density the backend sends.
    buckets[799] = { ERROR: 1 / 255 };
    const marks = rulerMarks(dens(buckets), 800);
    expect(marks).toHaveLength(1);
    expect(marks[0].h).toBe(MIN_MARK_PX);
    // Inside the ruler at the bottom edge.
    expect(marks[0].y + marks[0].h).toBeLessThanOrEqual(800);
    const [bar] = rulerRects(marks, 800, 800, WIDTH);
    // A short but clear bar in the error lane.
    expect(bar).toMatchObject({ level: 'ERROR', x: 1, w: 3, h: MIN_MARK_PX });
    buckets[799] = none;
    buckets[0] = E;
    expect(rulerMarks(dens(buckets), 800)[0].y).toBe(0);
  });

  it('ignores densities that are not numbers instead of hanging', () => {
    expect(rulerMarks([Number.NaN, 0, 0, 0, Number.NaN, 0], 2)).toEqual([]);
  });

  it('lays out two lanes: FATAL and ERROR left, WARN right', () => {
    const lanes = rulerLanes(WIDTH);
    expect(lanes.ERROR).toBe(lanes.FATAL);
    expect(lanes.FATAL).toEqual({ x: 1, w: 7, min: 3 });
    expect(lanes.WARN).toEqual({ x: 9, w: 4, min: 2 });
    expect(barWidth(0, lanes.ERROR)).toBe(0);
    expect(barWidth(0.004, lanes.ERROR)).toBe(3);
    expect(barWidth(0.25, lanes.ERROR)).toBe(5);
    expect(barWidth(0.5, lanes.ERROR)).toBe(7);
    expect(barWidth(1, lanes.WARN)).toBe(4);
  });

  it('a dense log with FATAL in every pixel is not one solid colour', () => {
    // Like the demo: FATAL in a sixth, ERROR in half, WARN in two fifths of every pixel's chunks.
    const buckets = new Array<Densities>(400).fill({ FATAL: 0.17, ERROR: 0.54, WARN: 0.42 });
    const marks = rulerMarks(dens(buckets), 400);
    expect(marks.map((m) => [m.level, m.from, m.to])).toEqual([
      ['FATAL', 0, 400],
      ['ERROR', 0, 400],
      ['WARN', 0, 400],
    ]);
    const rects = rulerRects(marks, 400, 400, WIDTH);
    const fatal = rects.find((r) => r.level === 'FATAL')!;
    const error = rects.find((r) => r.level === 'ERROR')!;
    const warn = rects.find((r) => r.level === 'WARN')!;
    // Equal neighbours become one bar each.
    expect(rects).toHaveLength(3);
    // FATAL is shorter and drawn after ERROR: both colours show side by side.
    expect(fatal.w).toBeLessThan(error.w);
    expect(rects.indexOf(fatal)).toBeGreaterThan(rects.indexOf(error));
    expect(warn.x).toBeGreaterThanOrEqual(error.x + error.w);
    // An area full of FATAL looks different from one with a trace of it.
    const sparse = rulerRects(
      rulerMarks(dens([{ FATAL: 0.01 }, ...buckets.slice(1)]), 400),
      400,
      400,
      WIDTH,
    );
    expect(sparse.find((r) => r.level === 'FATAL' && r.y === 0)!.w).toBeLessThan(fatal.w);
  });

  it('draws the shorter bar of the shared lane on top, FATAL at equal length', () => {
    const rects = rulerRects(
      rulerMarks(
        dens([
          { FATAL: 0.9, ERROR: 0.02 },
          { FATAL: 1, ERROR: 1 },
        ]),
        6,
      ),
      2,
      6,
      WIDTH,
    );
    const order = rects.map((r) => `${r.level}:${r.w}`);
    expect(order).toEqual(['ERROR:7', 'FATAL:7', 'ERROR:3']);
  });

  it('finds the marks under the pointer, the most severe first', () => {
    const marks = rulerMarks(dens([none, none, { ERROR: 1, FATAL: 1 }, none, none, none, W]), 7);
    expect(marksAt(marks, 2.5).map((m) => m.level)).toEqual(['FATAL', 'ERROR']);
    expect(marksAt(marks, 0)).toEqual([]);
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

  it('a click goes to a pin first, then to the marks, else to the proportional position', () => {
    const buckets = new Array<Densities>(100).fill(none);
    buckets[50] = E;
    const marks = rulerMarks(dens(buckets), 100);
    const pins: RulerPin[] = [{ kind: 'bookmark', line: 7, position: 200, visible: true }];
    const view = { marks, pins, count: 1000, height: 100, buckets: 100 };
    expect(clickTarget(20, view)).toEqual({ kind: 'position', position: 200 });
    expect(clickTarget(50.5, view)).toEqual({
      kind: 'level',
      from: 499,
      levels: ['ERROR', 'FATAL'],
      fallback: 500,
    });
    // Just above the mark, which is drawn higher than its one bucket.
    expect(clickTarget(49.6, view)).toMatchObject({ kind: 'level', from: 499 });
    expect(clickTarget(80, view)).toEqual({ kind: 'position', position: 800 });
    // A mark in the first bucket searches from the start.
    buckets[0] = W;
    const first = clickTarget(0.5, { ...view, marks: rulerMarks(dens(buckets), 100), pins: [] });
    expect(first).toMatchObject({ kind: 'level', from: null, levels: ['WARN', 'ERROR', 'FATAL'] });
  });

  it('a click into a long dense run looks from the pixel, not from the start of the run', () => {
    const marks = rulerMarks(dens(new Array<Densities>(100).fill({ ERROR: 0.3 })), 100);
    const view = { marks, pins: [], count: 10_000, height: 100, buckets: 100 };
    expect(clickTarget(70.5, view)).toMatchObject({ kind: 'level', from: 6999, fallback: 7000 });
  });

  it('tells in words what the marks or a pin are', () => {
    const buckets = new Array<Densities>(100).fill(none);
    buckets[10] = { ERROR: 0.3, WARN: 0.002 };
    const marks = rulerMarks(dens(buckets), 100);
    const pins: RulerPin[] = [{ kind: 'selection', line: 41, position: 900, visible: false }];
    const view = { marks, pins, count: 1000, height: 100, buckets: 100 };
    expect(rulerTooltip(10.5, view)).toBe(
      'Dichte ERROR 30 %, WARN < 1 % · Zeilen 101–110 der Ansicht · Klick springt zum ersten Eintrag',
    );
    expect(rulerTooltip(90, view)).toBe('Gewählte Zeile: Zeile 42 (vom Filter ausgeblendet)');
    expect(rulerTooltip(50, view)).toBe('Klick springt an diese Stelle');
  });
});
