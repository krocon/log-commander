import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Timeline, TimelineBucket } from '../../core/log/log.models';
import {
  MIN_LEVEL_PX,
  US,
  bucketAt,
  bucketTooltip,
  filterTimeText,
  lineTime,
  outages,
  outsideText,
  timeTicks,
  timelineColumns,
  timelineSummary,
  visibleBand,
  windowOf,
  xToTime,
  zoomRange,
} from './timeline-logic';

const bucket = (all: number, warn = 0, error = 0, fatal = 0): TimelineBucket => ({
  all,
  warn,
  error,
  fatal,
});

function timeline(partial: Partial<Timeline>): Timeline {
  return {
    epoch: 0,
    totalLines: 0,
    entries: 0,
    hasTimes: true,
    from: 0,
    to: 100 * US.s,
    buckets: [],
    gaps: [],
    min: 0,
    max: 100 * US.s,
    before: 0,
    after: 0,
    untimed: 0,
    anchors: [],
    ...partial,
  };
}

describe('timelineColumns', () => {
  it('stacks the rest, WARN, ERROR and FATAL from the bottom, scaled to the fullest bucket', () => {
    const rects = timelineColumns([bucket(100, 10, 20, 10), bucket(50)], 20, 50);
    const first = rects.filter((r) => r.x === 0);
    expect(first.map((r) => r.part)).toEqual(['fatal', 'error', 'warn', 'all']);
    // Top down without holes, the column as high as the plot.
    expect(first[0].y).toBe(0);
    for (let i = 1; i < first.length; i++) expect(first[i].y).toBe(first[i - 1].y + first[i - 1].h);
    expect(first.reduce((s, r) => s + r.h, 0)).toBe(50);
    expect(first.find((r) => r.part === 'error')!.h).toBe(10);
    const second = rects.filter((r) => r.x === 10);
    expect(second).toEqual([{ part: 'all', x: 10, y: 25, w: 9, h: 25 }]);
  });

  it('keeps a single error visible next to a huge bucket', () => {
    const rects = timelineColumns([bucket(100_000), bucket(3, 0, 1)], 4, 56);
    const error = rects.find((r) => r.part === 'error')!;
    expect(error.h).toBe(MIN_LEVEL_PX);
    expect(error.x).toBe(2);
  });

  it('leaves empty buckets empty and draws nothing without entries', () => {
    expect(timelineColumns([bucket(0), bucket(5)], 10, 10).every((r) => r.x === 5)).toBe(true);
    expect(timelineColumns([bucket(0)], 10, 10)).toEqual([]);
    expect(timelineColumns([], 10, 10)).toEqual([]);
  });
});

describe('outages', () => {
  it('takes gaps of ten times the usual spacing, at least a bucket long', () => {
    // 100 buckets of a second, 5 entries each: the usual spacing is 0.2 s, an outage lasts 2 s and a bucket.
    const buckets = Array.from({ length: 100 }, () => bucket(5));
    const t = timeline({
      buckets,
      gaps: [
        { from: 10 * US.s, to: 10.5 * US.s },
        { from: 20 * US.s, to: 22 * US.s },
        { from: 50 * US.s, to: 80 * US.s },
      ],
    });
    expect(outages(t)).toEqual([
      { from: 20 * US.s, to: 22 * US.s },
      { from: 50 * US.s, to: 80 * US.s },
    ]);
  });

  it('asks more of a sparse log', () => {
    // One entry per bucket: an outage lasts ten buckets.
    const t = timeline({
      buckets: Array.from({ length: 100 }, () => bucket(1)),
      gaps: [
        { from: 0, to: 5 * US.s },
        { from: 40 * US.s, to: 52 * US.s },
      ],
    });
    expect(outages(t)).toEqual([{ from: 40 * US.s, to: 52 * US.s }]);
  });

  it('names the silence in the tooltip and in the summary', () => {
    const start = new Date(2026, 0, 15, 10, 0, 0).getTime() * 1000;
    const t = timeline({
      from: start,
      to: start + 60 * US.m,
      entries: 312,
      buckets: Array.from({ length: 60 }, (_, i) =>
        i >= 4 && i < 51 ? bucket(0) : bucket(6, 0, i === 42 ? 6 : 0),
      ),
      gaps: [{ from: start + 4 * US.m, to: start + 51 * US.m }],
    });
    expect(bucketTooltip(t, 20)).toBe('keine Einträge 10:04:00–10:51:00');
    expect(bucketTooltip(t, 2)).toBe('10:02:00–10:03:00: 6 Einträge');
    expect(bucketTooltip(t, 59)).toBe('10:59:00–11:00:00: 6 Einträge');
    expect(timelineSummary(t)).toBe('Zeitstrahl 10:00–11:00, 312 Einträge, Lücke 10:04–10:51');
  });
});

describe('summary and tooltips', () => {
  it('names the peak of errors and marks counts from the summary as approximate', () => {
    const start = new Date(2026, 0, 15, 10, 0, 0).getTime() * 1000;
    const buckets = Array.from({ length: 60 }, () => bucket(10));
    buckets[42] = bucket(400, 3, 300.4, 11.6);
    const t = timeline({ from: start, to: start + 60 * US.m, buckets, entries: 990 });
    expect(timelineSummary(t)).toBe(
      'Zeitstrahl 10:00–11:00, 990 Einträge, Spitze 10:42 mit 312 Fehlern',
    );
    expect(bucketTooltip(t, 42)).toBe(
      '10:42:00–10:43:00: 400 Einträge (≈ 12 FATAL, ≈ 300 ERROR, 3 WARN)',
    );
    expect(timelineSummary(timeline({ hasTimes: false }))).toBe(
      'Zeitstrahl: keine Zeitstempel erkannt',
    );
  });

  it('tells about outliers outside the axis', () => {
    const t = timeline({ before: 2, after: 0, min: new Date(1970, 0, 1, 1).getTime() * 1000 });
    expect(outsideText(t)).toBe('Außerhalb der Achse: 2 früher ab 01.01.1970 01:00:00');
    expect(outsideText(timeline({}))).toBe('');
  });
});

describe('ticks', () => {
  // Local time decides the labels: a zone with summer time, whatever the machine uses.
  beforeEach(() => {
    vi.stubEnv('TZ', 'Europe/Berlin');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('picks a step that leaves room and aligns it in local time', () => {
    const from = new Date(2026, 0, 15, 10, 3, 17).getTime() * 1000;
    const ticks = timeTicks(from, from + US.h, 600, 90);
    // An hour on 600 px: 10 minutes are 100 px.
    expect(ticks.map((t) => t.label)).toEqual([
      '10:10',
      '10:20',
      '10:30',
      '10:40',
      '10:50',
      '11:00',
    ]);
    expect(ticks[1].x - ticks[0].x).toBeCloseTo(100, 5);
  });

  it('shows seconds for short ranges and the date at midnight', () => {
    const from = new Date(2026, 0, 15, 10, 0, 0).getTime() * 1000;
    expect(timeTicks(from, from + 10 * US.s, 1000, 90)[1].label).toBe('10:00:01');
    const evening = new Date(2026, 0, 15, 20, 0, 0).getTime() * 1000;
    const labels = timeTicks(evening, evening + 8 * US.h, 400, 90).map((t) => t.label);
    expect(labels).toContain('16.01.');
  });

  it('keeps full local hours across the change to summer time', () => {
    // 2026-03-29: 02:00 local does not exist in Berlin; five real hours end at 06:00.
    const from = new Date(2026, 2, 29, 0, 0, 0).getTime() * 1000;
    const ticks = timeTicks(from, from + 5 * US.h, 500, 90);
    expect(ticks.map((t) => t.label)).toEqual([
      '29.03.',
      '01:00',
      '03:00',
      '04:00',
      '05:00',
      '06:00',
    ]);
    // In UTC the axis is linear: the local hours 01:00 and 03:00 are one real hour apart.
    expect(ticks[2].ts - ticks[1].ts).toBe(US.h);
  });

  it('gives nothing for an empty range', () => {
    expect(timeTicks(5, 5, 100)).toEqual([]);
    expect(timeTicks(0, 10, 0)).toEqual([]);
  });
});

describe('axis, band and zoom', () => {
  it('maps x to time and back', () => {
    expect(xToTime(50, 0, 1000, 100)).toBe(500);
    expect(xToTime(-5, 0, 1000, 100)).toBe(0);
    expect(xToTime(500, 0, 1000, 100)).toBe(1000);
    expect(bucketAt(99.9, 10, 100)).toBe(9);
    expect(bucketAt(0, 10, 100)).toBe(0);
  });

  it('interpolates the time of a line between anchors', () => {
    const anchors = [
      { line: 0, ts: 0 },
      { line: 256, ts: 256 * US.s },
      { line: 512, ts: 3_600 * US.s },
    ];
    expect(lineTime(anchors, 128)).toBe(128 * US.s);
    expect(lineTime(anchors, 384)).toBe((256 + (3_600 - 256) / 2) * US.s);
    expect(lineTime(anchors, 9_999)).toBe(3_600 * US.s);
    expect(lineTime([], 3)).toBeNull();
  });

  it('draws the band of the visible lines at least 2 px wide', () => {
    const t = {
      from: 0,
      to: 100 * US.s,
      anchors: [
        { line: 0, ts: 0 },
        { line: 100, ts: 100 * US.s },
      ],
    };
    expect(visibleBand(t, 10, 20, 200)).toEqual({ x: 20, w: 20 });
    expect(visibleBand(t, 50, 50, 200)).toEqual({ x: 100, w: 2 });
    expect(visibleBand(t, null, 3, 200)).toBeNull();
  });

  it('zooms around the pointer within the file and back to the whole file', () => {
    const all = { from: 0, to: 1000 * US.s };
    const zoomed = zoomRange(all, 250 * US.s, 0.5, all)!;
    expect(zoomed).toEqual({ from: 125 * US.s, to: 625 * US.s });
    // Out again past the whole file: no zoom.
    expect(zoomRange(zoomed, 300 * US.s, 4, all)).toBeNull();
    // At the edge it stays inside.
    expect(zoomRange(all, 0, 0.1, all)).toEqual({ from: 0, to: 100 * US.s });
    expect(windowOf(9, 3).from).toBe(3);
  });

  it('writes filter times in local time, the end rounded up', () => {
    const ts = new Date(2026, 0, 15, 10, 4, 59, 500).getTime() * 1000;
    expect(filterTimeText(ts)).toBe('2026-01-15 10:04:59');
    expect(filterTimeText(ts, true)).toBe('2026-01-15 10:05:00');
  });
});
