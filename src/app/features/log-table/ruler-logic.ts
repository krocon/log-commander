import { Level } from '../../core/log/log.models';
import { formatCount } from '../../shared/format';

/**
 * Levels the overview ruler marks, most severe first (prompt 007); also the order of the three densities per
 * bucket in `Overview.density`.
 */
export type RulerLevel = 'FATAL' | 'ERROR' | 'WARN';
export const RULER_LEVELS: readonly RulerLevel[] = ['FATAL', 'ERROR', 'WARN'];

/** A mark is at least this high, so a single error among millions of lines stays visible. */
export const MIN_MARK_PX = 3;
/** How close the pointer must be to a bookmark or the selection to hit it. */
export const PIN_SLOP_PX = 4;
/** Density (share of a pixel's lines) at which a bar fills its lane; denser looks the same. */
export const SATURATION = 0.5;
/** Width of the WARN lane in px; FATAL and ERROR share the wider lane left of it. */
const WARN_LANE_PX = 4;

/**
 * A run of neighbouring buckets in which one level occurs. Each level has its own runs, so levels never
 * hide each other; how dense the level is per bucket decides the length of its bar.
 */
export interface RulerMark {
  level: RulerLevel;
  /** First bucket and the one after the last. */
  from: number;
  to: number;
  y: number;
  h: number;
  /** Density 0–1 per bucket of the run. */
  density: number[];
}

/** Density of a level per bucket (0–1) from the backend's 0–255, three per bucket. */
function densityAt(density: readonly number[], bucket: number, level: number): number {
  return (density[bucket * RULER_LEVELS.length + level] ?? 0) / 255;
}

/**
 * Densities (three per pixel row of the ruler, `Overview.density`) to marks: per level, neighbouring
 * buckets in which it occurs form one mark; every mark is at least `MIN_MARK_PX` high and stays inside.
 */
export function rulerMarks(density: readonly number[], height: number): RulerMark[] {
  const n = Math.floor(density.length / RULER_LEVELS.length);
  const marks: RulerMark[] = [];
  if (n === 0 || height <= 0) return marks;
  const scale = height / n;
  RULER_LEVELS.forEach((level, k) => {
    let i = 0;
    while (i < n) {
      // `!(d > 0)` also skips anything that is not a number, so the run below always advances.
      if (!(densityAt(density, i, k) > 0)) {
        i++;
        continue;
      }
      const run: number[] = [];
      let j = i;
      while (j < n && densityAt(density, j, k) > 0) run.push(densityAt(density, j++, k));
      const span = (j - i) * scale;
      const h = Math.max(MIN_MARK_PX, span);
      const y = Math.max(0, Math.min(height - h, i * scale - (h - span) / 2));
      marks.push({ level, from: i, to: j, y, h: Math.min(h, height), density: run });
      i = j;
    }
  });
  return marks;
}

/** Where the bars of a level go across the ruler: from `x`, at most `w` and at least `min` px long. */
export interface RulerLane {
  x: number;
  w: number;
  min: number;
}

/**
 * Two lanes: FATAL and ERROR share the wide one on the left (the rare errors are what the ruler is for),
 * WARN has a narrow one on the right.
 */
export function rulerLanes(width: number): Record<RulerLevel, RulerLane> {
  const warn = Math.min(WARN_LANE_PX, Math.max(1, Math.floor(width / 3)));
  const severeW = Math.max(1, width - warn - 2);
  const severe = { x: 1, w: severeW, min: Math.min(3, severeW) };
  return {
    FATAL: severe,
    ERROR: severe,
    WARN: { x: width - warn, w: warn, min: Math.min(2, warn) },
  };
}

/** Length of a bar: the lane's minimum for a single line, growing with the density up to `SATURATION`. */
export function barWidth(density: number, lane: RulerLane): number {
  if (density <= 0) return 0;
  return Math.round(lane.min + (lane.w - lane.min) * Math.min(1, density / SATURATION));
}

/** A rectangle to fill, in the order of the list. */
export interface RulerRect {
  level: RulerLevel;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The bars of the marks. A mark lower than `MIN_MARK_PX` is one bar as long as its densest bucket,
 * otherwise each bucket gets its own length (equal neighbours joined). In a shared lane the shorter bar is
 * drawn last, so FATAL and ERROR both stay visible; at equal length FATAL is on top.
 */
export function rulerRects(
  marks: readonly RulerMark[],
  buckets: number,
  height: number,
  width: number,
): RulerRect[] {
  if (buckets <= 0 || height <= 0) return [];
  const lanes = rulerLanes(width);
  const scale = height / buckets;
  const rects: RulerRect[] = [];
  for (const mark of marks) {
    const lane = lanes[mark.level];
    if ((mark.to - mark.from) * scale < MIN_MARK_PX) {
      const w = barWidth(Math.max(...mark.density), lane);
      rects.push({ level: mark.level, x: lane.x, y: mark.y, w, h: mark.h });
      continue;
    }
    let last: RulerRect | null = null;
    for (let i = 0; i < mark.density.length; i++) {
      const w = barWidth(mark.density[i], lane);
      const y = (mark.from + i) * scale;
      if (last && last.w === w) {
        last.h = y + scale - last.y;
      } else {
        last = { level: mark.level, x: lane.x, y, w, h: scale };
        rects.push(last);
      }
    }
  }
  const rank = (level: RulerLevel) => -RULER_LEVELS.indexOf(level);
  return rects.sort((a, b) => b.w - a.w || rank(a.level) - rank(b.level));
}

/** Pixel of a position in the view. */
export function positionToY(position: number, count: number, height: number): number {
  if (count <= 0) return 0;
  return (Math.min(Math.max(position, 0), count) / count) * height;
}

/** Position under a pixel of the ruler. */
export function yToPosition(y: number, count: number, height: number): number {
  if (count <= 0 || height <= 0) return 0;
  const position = Math.floor((Math.min(Math.max(y, 0), height) / height) * count);
  return Math.min(count - 1, position);
}

/** Positions `[start, end)` that buckets `[from, to)` cover (out of `n`). */
export function bucketPositions(
  from: number,
  to: number,
  n: number,
  count: number,
): { start: number; end: number } {
  if (n <= 0) return { start: 0, end: 0 };
  return {
    start: Math.min(count, Math.ceil((from * count) / n)),
    end: Math.min(count, Math.ceil((to * count) / n)),
  };
}

/** The marks under the pointer, most severe first (a mark is at least `MIN_MARK_PX` high). */
export function marksAt(marks: readonly RulerMark[], y: number): RulerMark[] {
  return marks
    .filter((mark) => y >= mark.y - 0.5 && y <= mark.y + mark.h + 0.5)
    .sort((a, b) => RULER_LEVELS.indexOf(a.level) - RULER_LEVELS.indexOf(b.level));
}

/** The bucket of a mark under the pointer: that of the pixel, or the nearest of a mark drawn higher. */
function bucketIn(mark: RulerMark, y: number, buckets: number, height: number): number {
  const bucket = Math.floor((y / height) * buckets);
  return Math.min(mark.to - 1, Math.max(mark.from, bucket));
}

/** The visible part of the view as a band; at least `minPx` high. */
export function band(
  top: number,
  rows: number,
  count: number,
  height: number,
  minPx = 6,
): { y: number; h: number } | null {
  if (count <= 0 || height <= 0) return null;
  const y = positionToY(top, count, height);
  const h = Math.max(minPx, (Math.min(rows, count) / count) * height);
  return { y: Math.max(0, Math.min(height - h, y)), h: Math.min(h, height) };
}

/** A line the ruler points at: a bookmark, a note (prompt 015) or the selection. */
export interface RulerPin {
  kind: 'bookmark' | 'note' | 'selection';
  line: number;
  position: number;
  /** The filter shows the line itself (otherwise `position` is that of the next shown line). */
  visible: boolean;
}

export function pinY(pin: RulerPin, count: number, height: number): number {
  // The middle of the position's row on the ruler.
  return positionToY(pin.position + 0.5, count, height);
}

/** The pin nearest to the pointer within `PIN_SLOP_PX`; the selection wins a tie. */
export function pinAt(
  pins: readonly RulerPin[],
  y: number,
  count: number,
  height: number,
): RulerPin | null {
  let best: RulerPin | null = null;
  let distance = Infinity;
  for (const pin of pins) {
    const d = Math.abs(pinY(pin, count, height) - y);
    if (d > PIN_SLOP_PX) continue;
    if (d < distance || (d === distance && pin.kind === 'selection')) {
      best = pin;
      distance = d;
    }
  }
  return best;
}

/** The levels a jump from a mark looks for: its own and the more severe ones. */
export function levelsFrom(level: RulerLevel): Level[] {
  return RULER_LEVELS.slice(0, RULER_LEVELS.indexOf(level) + 1).reverse();
}

/** What a click on the ruler does. */
export type RulerTarget =
  /** Scroll to this position. */
  | { kind: 'position'; position: number }
  /**
   * Look for the first entry of `levels` after `from` (exclusive, null = from the start) and before `until`.
   * None there: the mark comes from the lines of an entry that begins further up (a stack trace), so the
   * last entry before; else `fallback`.
   */
  | { kind: 'level'; from: number | null; until: number; levels: Level[]; fallback: number };

/** Whether a hit of the search forward is one of the clicked buckets, not the next one somewhere below. */
export function hitInClick(
  hit: { position: number; wrapped: boolean } | null,
  target: { until: number },
): boolean {
  return hit !== null && !hit.wrapped && hit.position < target.until;
}

interface RulerView {
  marks: readonly RulerMark[];
  pins: readonly RulerPin[];
  count: number;
  height: number;
  buckets: number;
}

/** The marks under the pointer and the buckets `[from, to)` they mean there. */
function hereAt(
  y: number,
  view: RulerView,
): { marks: RulerMark[]; from: number; to: number } | null {
  const marks = marksAt(view.marks, y);
  if (marks.length === 0) return null;
  const buckets = marks.map((m) => bucketIn(m, y, view.buckets, view.height));
  return { marks, from: Math.min(...buckets), to: Math.max(...buckets) + 1 };
}

/**
 * Bookmarks and the selection first, then the marks: the first entry of their levels from the pixel on
 * (in a long dense run that is near the pointer, not at the start of the run); else the proportional position.
 */
export function clickTarget(y: number, view: RulerView): RulerTarget {
  const pin = pinAt(view.pins, y, view.count, view.height);
  if (pin) return { kind: 'position', position: pin.position };
  const here = hereAt(y, view);
  if (here) {
    const { start } = bucketPositions(here.from, here.from + 1, view.buckets, view.count);
    const { end } = bucketPositions(here.from, here.to, view.buckets, view.count);
    // The backend marks a bucket with every line that reaches into it: the first may begin in the bucket
    // before (its start is not on a bucket edge). `from` is exclusive, the search starts one later.
    const first = view.buckets > 0 ? Math.floor((here.from * view.count) / view.buckets) : 0;
    const levels = new Set<Level>(here.marks.flatMap((m) => levelsFrom(m.level)));
    return {
      kind: 'level',
      from: first > 0 ? first - 1 : null,
      until: Math.max(end, first + 1),
      levels: [...RULER_LEVELS].reverse().filter((l) => levels.has(l)),
      fallback: start,
    };
  }
  return { kind: 'position', position: yToPosition(y, view.count, view.height) };
}

/** A density in words: whole percent, `< 1 %` for a trace. */
function percent(density: number): string {
  return density < 0.01 ? '< 1 %' : `${Math.round(density * 100)} %`;
}

/** Tooltip of the ruler at a pixel: the pin, the marks' levels with their density and lines, or what a click does. */
export function rulerTooltip(y: number, view: RulerView): string {
  const pin = pinAt(view.pins, y, view.count, view.height);
  if (pin) {
    const what =
      pin.kind === 'bookmark' ? 'Lesezeichen' : pin.kind === 'note' ? 'Notiz' : 'Gewählte Zeile';
    const hidden = pin.visible ? '' : ' (vom Filter ausgeblendet)';
    return `${what}: Zeile ${formatCount(pin.line + 1)}${hidden}`;
  }
  const here = hereAt(y, view);
  if (here) {
    const levels = here.marks
      .map((m) => {
        const bucket = bucketIn(m, y, view.buckets, view.height);
        return `${m.level} ${percent(m.density[bucket - m.from])}`;
      })
      .join(', ');
    const { start, end } = bucketPositions(here.from, here.to, view.buckets, view.count);
    const range =
      end - start > 1
        ? `Zeilen ${formatCount(start + 1)}–${formatCount(end)} der Ansicht`
        : `Zeile ${formatCount(start + 1)} der Ansicht`;
    return `Dichte ${levels} · ${range} · Klick springt zum ersten Eintrag`;
  }
  return 'Klick springt an diese Stelle';
}
