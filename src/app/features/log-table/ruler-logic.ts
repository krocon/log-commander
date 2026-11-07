import { LEVELS, Level } from '../../core/log/log.models';
import { formatCount } from '../../shared/format';

/** Levels the overview ruler marks, most severe first (prompt 007). */
export type RulerLevel = 'FATAL' | 'ERROR' | 'WARN';
export const RULER_LEVELS: readonly RulerLevel[] = ['FATAL', 'ERROR', 'WARN'];

/** A mark is at least this high, so a single error among millions of lines stays visible. */
export const MIN_MARK_PX = 3;
/** How close the pointer must be to a bookmark or the selection to hit it. */
export const PIN_SLOP_PX = 4;

export function levelBit(level: Level): number {
  return 1 << LEVELS.indexOf(level);
}

/** The most severe ruler level among the bits of a bucket, or null. */
export function topLevel(bits: number): RulerLevel | null {
  for (const level of RULER_LEVELS) if (bits & levelBit(level)) return level;
  return null;
}

/** A run of buckets with the same most severe level, as drawn. */
export interface RulerMark {
  level: RulerLevel;
  /** Ruler levels that occur in the run, most severe first. */
  levels: RulerLevel[];
  /** First bucket and the one after the last. */
  from: number;
  to: number;
  y: number;
  h: number;
}

/**
 * Buckets (one per pixel row of the ruler) to marks: neighbouring buckets with the same most severe level
 * form one mark; every mark is at least `MIN_MARK_PX` high and stays inside the ruler.
 */
export function rulerMarks(buckets: readonly number[], height: number): RulerMark[] {
  const n = buckets.length;
  const marks: RulerMark[] = [];
  if (n === 0 || height <= 0) return marks;
  const scale = height / n;
  let i = 0;
  while (i < n) {
    const level = topLevel(buckets[i]);
    if (!level) {
      i++;
      continue;
    }
    let bits = 0;
    let j = i;
    while (j < n && topLevel(buckets[j]) === level) bits |= buckets[j++];
    const span = (j - i) * scale;
    const h = Math.max(MIN_MARK_PX, span);
    const y = Math.max(0, Math.min(height - h, i * scale - (h - span) / 2));
    marks.push({
      level,
      levels: RULER_LEVELS.filter((l) => bits & levelBit(l)),
      from: i,
      to: j,
      y,
      h: Math.min(h, height),
    });
    i = j;
  }
  return marks;
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

/** The mark under the pointer; overlapping marks (minimum height) go by severity. */
export function markAt(marks: readonly RulerMark[], y: number): RulerMark | null {
  let best: RulerMark | null = null;
  for (const mark of marks) {
    if (y < mark.y - 0.5 || y > mark.y + mark.h + 0.5) continue;
    if (!best || RULER_LEVELS.indexOf(mark.level) < RULER_LEVELS.indexOf(best.level)) best = mark;
  }
  return best;
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

/** A line the ruler points at: a bookmark or the selection. */
export interface RulerPin {
  kind: 'bookmark' | 'selection';
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
  /** Look for the first entry of `levels` after `from` (exclusive, null = from the start); else `fallback`. */
  | { kind: 'level'; from: number | null; levels: Level[]; fallback: number };

/** Bookmarks and the selection first, then a mark, else the proportional position. */
export function clickTarget(
  y: number,
  view: {
    marks: readonly RulerMark[];
    pins: readonly RulerPin[];
    count: number;
    height: number;
    buckets: number;
  },
): RulerTarget {
  const pin = pinAt(view.pins, y, view.count, view.height);
  if (pin) return { kind: 'position', position: pin.position };
  const mark = markAt(view.marks, y);
  if (mark) {
    const { start } = bucketPositions(mark.from, mark.to, view.buckets, view.count);
    return {
      kind: 'level',
      from: start > 0 ? start - 1 : null,
      levels: levelsFrom(mark.level),
      fallback: start,
    };
  }
  return { kind: 'position', position: yToPosition(y, view.count, view.height) };
}

/** Tooltip of the ruler at a pixel: the pin, the mark's levels and lines, or what a click does. */
export function rulerTooltip(
  y: number,
  view: {
    marks: readonly RulerMark[];
    pins: readonly RulerPin[];
    count: number;
    height: number;
    buckets: number;
  },
): string {
  const pin = pinAt(view.pins, y, view.count, view.height);
  if (pin) {
    const what = pin.kind === 'bookmark' ? 'Lesezeichen' : 'Gewählte Zeile';
    const hidden = pin.visible ? '' : ' (vom Filter ausgeblendet)';
    return `${what}: Zeile ${formatCount(pin.line + 1)}${hidden}`;
  }
  const mark = markAt(view.marks, y);
  if (mark) {
    const { start, end } = bucketPositions(mark.from, mark.to, view.buckets, view.count);
    const range =
      end - start > 1
        ? `Zeilen ${formatCount(start + 1)}–${formatCount(end)} der Ansicht`
        : `Zeile ${formatCount(start + 1)} der Ansicht`;
    return `${mark.levels.join(', ')} · ${range} · Klick springt zum ersten Eintrag`;
  }
  return 'Klick springt an diese Stelle';
}
