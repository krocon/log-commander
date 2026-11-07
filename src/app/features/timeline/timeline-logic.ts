import { TimeAnchor, TimeRange, Timeline, TimelineBucket } from '../../core/log/log.models';
import { formatCount } from '../../shared/format';

/** Microseconds per unit; the backend counts time in microseconds since the epoch (UTC). */
export const US = { s: 1_000_000, m: 60_000_000, h: 3_600_000_000, d: 86_400_000_000 } as const;

/** A gap is an outage when it lasts this many times the usual spacing of entries (prompt 014). */
export const OUTAGE_FACTOR = 10;
/** A level part of a column is at least this high, so a single error stays visible. */
export const MIN_LEVEL_PX = 2;
/** The narrowest zoom: ten seconds. */
export const MIN_SPAN = 10 * US.s;

/** Level parts of a column, from the bottom: the rest, WARN, ERROR, FATAL on top. */
export type ColumnPart = 'all' | 'warn' | 'error' | 'fatal';
export const COLUMN_PARTS: readonly ColumnPart[] = ['all', 'warn', 'error', 'fatal'];

/** A part of one column, in CSS pixels from the top left of the plot. */
export interface ColumnRect {
  part: ColumnPart;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Buckets to stacked columns: the height of a column is its share of the fullest bucket; inside, from the
 * bottom, the entries without a level of interest (neutral), then WARN, ERROR and FATAL. A level part is at
 * least `MIN_LEVEL_PX` high when it has any entry; the neutral part gives way for that.
 */
export function timelineColumns(
  buckets: readonly TimelineBucket[],
  width: number,
  height: number,
): ColumnRect[] {
  const n = buckets.length;
  const rects: ColumnRect[] = [];
  if (n === 0 || width <= 0 || height <= 0) return rects;
  const max = Math.max(...buckets.map((b) => b.all));
  if (!(max > 0)) return rects;
  const scale = height / max;
  const step = width / n;
  buckets.forEach((b, i) => {
    if (!(b.all > 0)) return;
    const x = Math.floor(i * step);
    const w = Math.max(1, Math.floor((i + 1) * step) - x - (step >= 3 ? 1 : 0));
    const total = Math.min(height, Math.max(1, Math.round(b.all * scale)));
    const levels = (['warn', 'error', 'fatal'] as const).map((part) => ({
      part,
      h: b[part] > 0 ? Math.max(MIN_LEVEL_PX, Math.round(b[part] * scale)) : 0,
    }));
    const levelSum = levels.reduce((sum, l) => sum + l.h, 0);
    let top = height - Math.max(total, Math.min(height, levelSum));
    const neutral = Math.max(0, height - top - levelSum);
    // Top down: FATAL, ERROR, WARN, then the rest.
    for (const { part, h } of [...levels].reverse()) {
      if (h === 0) continue;
      const clipped = Math.min(h, height - top);
      if (clipped > 0) rects.push({ part, x, y: top, w, h: clipped });
      top += clipped;
    }
    if (neutral > 0) rects.push({ part: 'all', x, y: top, w, h: neutral });
  });
  return rects;
}

/** Median of the non-empty buckets (entries per bucket), 0 if all are empty. */
export function medianCount(buckets: readonly TimelineBucket[]): number {
  const counts = buckets
    .map((b) => b.all)
    .filter((c) => c > 0)
    .sort((a, b) => a - b);
  if (counts.length === 0) return 0;
  const mid = counts.length >> 1;
  return counts.length % 2 ? counts[mid] : (counts[mid - 1] + counts[mid]) / 2;
}

/**
 * Gaps of the backend that are outages: at least `OUTAGE_FACTOR` times the usual spacing of entries (bucket
 * width over the median entries per bucket) and at least one bucket long. Shorter quiet stretches stay plain
 * empty columns.
 */
export function outages(timeline: Pick<Timeline, 'from' | 'to' | 'buckets' | 'gaps'>): TimeRange[] {
  const n = timeline.buckets.length;
  if (n === 0 || timeline.to <= timeline.from) return [];
  const bucketSpan = (timeline.to - timeline.from) / n;
  const median = medianCount(timeline.buckets);
  if (median <= 0) return [];
  const spacing = bucketSpan / median;
  const least = Math.max(bucketSpan, OUTAGE_FACTOR * spacing);
  return timeline.gaps.filter((g) => g.to - g.from >= least);
}

/** x of a time on a plot of `width` pixels from `from` to `to`. */
export function timeToX(ts: number, from: number, to: number, width: number): number {
  return to > from ? ((ts - from) / (to - from)) * width : 0;
}

/** Time at x, clamped to the axis. */
export function xToTime(x: number, from: number, to: number, width: number): number {
  if (width <= 0) return from;
  const share = Math.min(1, Math.max(0, x / width));
  return Math.round(from + share * (to - from));
}

/**
 * The time of a line from the anchors (line → time at chunk boundaries, ascending lines), linear between
 * them; `null` without anchors.
 */
export function lineTime(anchors: readonly TimeAnchor[], line: number): number | null {
  if (anchors.length === 0) return null;
  if (line <= anchors[0].line) return anchors[0].ts;
  const last = anchors[anchors.length - 1];
  if (line >= last.line) return last.ts;
  let lo = 0;
  let hi = anchors.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid].line <= line) lo = mid;
    else hi = mid;
  }
  const a = anchors[lo];
  const b = anchors[hi];
  return a.ts + ((b.ts - a.ts) * (line - a.line)) / Math.max(1, b.line - a.line);
}

/** The band of the visible lines (first and last file line shown), at least 2 px wide, or null. */
export function visibleBand(
  timeline: Pick<Timeline, 'from' | 'to' | 'anchors'>,
  first: number | null,
  last: number | null,
  width: number,
): { x: number; w: number } | null {
  if (first === null || last === null || width <= 0) return null;
  const a = lineTime(timeline.anchors, first);
  const b = lineTime(timeline.anchors, last);
  if (a === null || b === null) return null;
  const x1 = timeToX(Math.min(a, b), timeline.from, timeline.to, width);
  const x2 = timeToX(Math.max(a, b), timeline.from, timeline.to, width);
  if (x2 < 0 || x1 > width) return null;
  const left = Math.max(0, Math.min(x1, width - 2));
  return { x: left, w: Math.max(2, Math.min(width, x2) - left) };
}

/**
 * A zoom by `factor` (< 1 in, > 1 out) around `center`, keeping it under the pointer, within `limits` (the
 * whole file). `null` when the result covers the whole file again.
 */
export function zoomRange(
  range: TimeRange,
  center: number,
  factor: number,
  limits: TimeRange,
): TimeRange | null {
  const span = range.to - range.from;
  const full = limits.to - limits.from;
  const next = Math.max(MIN_SPAN, span * factor);
  if (next >= full) return null;
  const share = span > 0 ? (center - range.from) / span : 0.5;
  let from = center - share * next;
  from = Math.min(Math.max(from, limits.from), limits.to - next);
  return { from: Math.round(from), to: Math.round(from + next) };
}

/** A dragged window from two times, at least `MIN_SPAN` wide. */
export function windowOf(a: number, b: number): TimeRange {
  const from = Math.min(a, b);
  const to = Math.max(a, b, from + MIN_SPAN / 10);
  return { from, to };
}

// ------------------------------------------------------------------ ticks

/** Tick steps from a second to a year; days and longer follow the local calendar. */
const STEPS: readonly { us: number; unit: 's' | 'm' | 'h' | 'd' | 'mo' | 'y'; n: number }[] = [
  ...[1, 2, 5, 10, 15, 30].map((n) => ({ us: n * US.s, unit: 's' as const, n })),
  ...[1, 2, 5, 10, 15, 30].map((n) => ({ us: n * US.m, unit: 'm' as const, n })),
  ...[1, 2, 3, 6, 12].map((n) => ({ us: n * US.h, unit: 'h' as const, n })),
  ...[1, 2, 7, 14].map((n) => ({ us: n * US.d, unit: 'd' as const, n })),
  ...[1, 3, 6].map((n) => ({ us: n * 30 * US.d, unit: 'mo' as const, n })),
  { us: 365 * US.d, unit: 'y', n: 1 },
];

export interface Tick {
  ts: number;
  x: number;
  label: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Ticks for the axis in local time, at least `spacing` pixels apart. Computed on local calendar fields, so
 * a daylight saving change keeps the labels on full hours; the positions are UTC.
 */
export function timeTicks(from: number, to: number, width: number, spacing = 90): Tick[] {
  if (!(to > from) || width <= 0) return [];
  const perPx = (to - from) / width;
  const step = STEPS.find((s) => s.us / perPx >= spacing) ?? STEPS[STEPS.length - 1];
  const start = new Date(Math.floor(from / 1000));
  // Round down to the step on local fields, then walk.
  const d = new Date(start);
  d.setMilliseconds(0);
  switch (step.unit) {
    case 's':
      d.setSeconds(Math.floor(d.getSeconds() / step.n) * step.n);
      break;
    case 'm':
      d.setSeconds(0);
      d.setMinutes(Math.floor(d.getMinutes() / step.n) * step.n);
      break;
    case 'h':
      d.setMinutes(0, 0);
      d.setHours(Math.floor(d.getHours() / step.n) * step.n);
      break;
    case 'd':
      d.setHours(0, 0, 0);
      break;
    case 'mo':
      d.setHours(0, 0, 0);
      d.setDate(1);
      d.setMonth(Math.floor(d.getMonth() / step.n) * step.n);
      break;
    case 'y':
      d.setHours(0, 0, 0);
      d.setMonth(0, 1);
      break;
  }
  const ticks: Tick[] = [];
  for (let guard = 0; guard < 1000; guard++) {
    const ts = d.getTime() * 1000;
    if (ts > to) break;
    if (ts >= from) {
      ticks.push({ ts, x: timeToX(ts, from, to, width), label: tickLabel(d, step.unit) });
    }
    switch (step.unit) {
      case 's':
      case 'm':
        d.setTime(d.getTime() + step.us / 1000);
        break;
      case 'h':
        d.setHours(d.getHours() + step.n);
        break;
      case 'd':
        d.setDate(d.getDate() + step.n);
        break;
      case 'mo':
        d.setMonth(d.getMonth() + step.n);
        break;
      case 'y':
        d.setFullYear(d.getFullYear() + 1);
        break;
    }
  }
  return ticks;
}

function tickLabel(d: Date, unit: string): string {
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const date = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.`;
  if (unit === 's') return `${time}:${pad(d.getSeconds())}`;
  if (unit === 'm' || unit === 'h') {
    return d.getHours() === 0 && d.getMinutes() === 0 ? date : time;
  }
  if (unit === 'y') return String(d.getFullYear());
  if (unit === 'mo') return `${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  return date;
}

// ------------------------------------------------------------------ text

/** A time in local time, with the date when the range is longer than a day or crosses midnight. */
export function formatTime(ts: number, withDate = false, seconds = true): string {
  const d = new Date(Math.floor(ts / 1000));
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}${seconds ? `:${pad(d.getSeconds())}` : ''}`;
  return withDate
    ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${time}`
    : time;
}

/** Whether labels of this range need the date. */
export function needsDate(from: number, to: number): boolean {
  const a = new Date(Math.floor(from / 1000));
  const b = new Date(Math.floor(to / 1000));
  return a.toDateString() !== b.toDateString();
}

/** A time as the filter's time condition reads it (local, `YYYY-MM-DD HH:MM:SS`); `up` rounds up. */
export function filterTimeText(ts: number, up = false): string {
  const ms = up ? Math.ceil(ts / 1_000_000) * 1000 : Math.floor(ts / 1_000_000) * 1000;
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** "≈ 12" for a fractional count from the summary; whole counts without "≈". */
function approx(n: number): string {
  if (n > 0 && n < 1) return '< 1';
  const rounded = Math.round(n);
  return Math.abs(n - rounded) < 0.01 ? formatCount(rounded) : `≈ ${formatCount(rounded)}`;
}

/** Tooltip of a column: its time, entries and levels; for a gap the silence. */
export function bucketTooltip(timeline: Timeline, index: number): string {
  const n = timeline.buckets.length;
  const b = timeline.buckets[index];
  if (!b || n === 0) return '';
  const span = (timeline.to - timeline.from) / n;
  const start = timeline.from + index * span;
  const end = start + span;
  const date = needsDate(timeline.from, timeline.to);
  const when = `${formatTime(start, date)}–${formatTime(end)}`;
  const gap = outages(timeline).find((g) => g.from < end && g.to > start);
  if (gap) {
    return `keine Einträge ${formatTime(gap.from, date)}–${formatTime(gap.to)}`;
  }
  if (!(b.all > 0)) return `${when}: keine Einträge`;
  const levels = [
    b.fatal > 0 ? `${approx(b.fatal)} FATAL` : '',
    b.error > 0 ? `${approx(b.error)} ERROR` : '',
    b.warn > 0 ? `${approx(b.warn)} WARN` : '',
  ].filter(Boolean);
  return `${when}: ${approx(b.all)} Einträge${levels.length ? ` (${levels.join(', ')})` : ''}`;
}

/** Entries outside the axis, for the hint at its edges (outliers like a year 1970 line). */
export function outsideText(timeline: Timeline): string {
  const parts: string[] = [];
  const date = true;
  if (timeline.before > 0) {
    const since = timeline.min !== null ? ` ab ${formatTime(timeline.min, date)}` : '';
    parts.push(`${formatCount(timeline.before)} früher${since}`);
  }
  if (timeline.after > 0) {
    const until = timeline.max !== null ? ` bis ${formatTime(timeline.max, date)}` : '';
    parts.push(`${formatCount(timeline.after)} später${until}`);
  }
  return parts.length ? `Außerhalb der Achse: ${parts.join(', ')}` : '';
}

/**
 * The summary for screen readers (`aria-label`): the range, how many entries, the bucket with the most
 * errors and the longest outage, e.g. „Spitze 10:42 mit 312 Fehlern“.
 */
export function timelineSummary(timeline: Timeline): string {
  if (!timeline.hasTimes) return 'Zeitstrahl: keine Zeitstempel erkannt';
  const date = needsDate(timeline.from, timeline.to);
  const parts = [
    `Zeitstrahl ${formatTime(timeline.from, date, false)}–${formatTime(timeline.to, date, false)}`,
    `${formatCount(timeline.entries)} Einträge`,
  ];
  const n = timeline.buckets.length;
  if (n > 0) {
    let best = -1;
    let most = 0;
    timeline.buckets.forEach((b, i) => {
      const errors = b.error + b.fatal;
      if (errors > most) {
        most = errors;
        best = i;
      }
    });
    if (best >= 0 && most >= 0.5) {
      const at = timeline.from + ((best + 0.5) * (timeline.to - timeline.from)) / n;
      parts.push(`Spitze ${formatTime(at, date, false)} mit ${approx(most)} Fehlern`);
    }
  }
  const gaps = outages(timeline);
  if (gaps.length > 0) {
    const longest = gaps.reduce((a, b) => (b.to - b.from > a.to - a.from ? b : a));
    parts.push(
      `${gaps.length === 1 ? 'Lücke' : `${gaps.length} Lücken, längste`} ${formatTime(longest.from, date, false)}–${formatTime(longest.to, false, false)}`,
    );
  }
  return parts.join(', ');
}

/** Bucket under x. */
export function bucketAt(x: number, buckets: number, width: number): number {
  if (buckets <= 0 || width <= 0) return 0;
  return Math.min(buckets - 1, Math.max(0, Math.floor((x / width) * buckets)));
}
