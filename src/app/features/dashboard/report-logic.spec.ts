import { describe, expect, it } from 'vitest';
import { ReportResult, ReportValue } from '../../core/log/log.models';
import {
  MAX_POINTS,
  describeQueryError,
  effectiveKind,
  firstLineQuery,
  formatCell,
  intervalOf,
  lineOfRow,
  pieSlices,
  rangeAt,
  seriesSums,
  singleValue,
  suggestInterval,
  toChartData,
  withInterval,
} from './report-logic';

const result = (columns: string[], rows: ReportValue[][]): ReportResult => ({
  columns,
  rows,
  truncated: false,
  elapsedMs: 1,
});

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 15, 9, 0);

describe('toChartData', () => {
  it('takes ts or bucket with whole numbers as the time axis, numbers as series', () => {
    const d = toChartData(
      result(
        ['t', 'n', 'avg_took'],
        [
          [T0 + MIN, 3, 0.5],
          [T0, 2, null],
        ],
      ),
    );
    expect(d.axis).toBe('time');
    expect(d.x).toEqual([T0, T0 + MIN]);
    expect(d.series.map((s) => s.label)).toEqual(['n', 'avg_took']);
    expect(d.series[0].values).toEqual([2, 3]);
    expect(d.series[1].values).toEqual([null, 0.5]);
    expect(d.step).toBe(MIN);
  });

  it('splits into series by a text column, gaps where a combination is missing', () => {
    const d = toChartData(
      result(
        ['t', 'level', 'n'],
        [
          [T0, 'INFO', 5],
          [T0, 'ERROR', 1],
          [T0 + MIN, 'INFO', 4],
        ],
      ),
    );
    expect(d.splitColumn).toBe('level');
    expect(d.series.map((s) => s.label)).toEqual(['INFO', 'ERROR']);
    expect(d.series[0].level).toBe('INFO');
    expect(d.series[1].values).toEqual([1, null]);
    expect(seriesSums(d)).toEqual({ INFO: 9, ERROR: 1 });
  });

  it('names series by value and column with several number columns', () => {
    const d = toChartData(result(['t', 'host', 'a', 'b'], [[T0, 'x', 1, 2]]));
    expect(d.series.map((s) => s.label)).toEqual(['x · a', 'x · b']);
    expect(d.series[0].level).toBeNull();
  });

  it('a NULL split value is a series of its own', () => {
    const d = toChartData(result(['t', 'logger', 'n'], [[T0, null, 1]]));
    expect(d.series[0].label).toBe('(leer)');
  });

  it('without a time axis the first column is categories', () => {
    const d = toChartData(
      result(
        ['logger', 'n'],
        [
          ['a.B', 4],
          ['c.D', 2],
        ],
      ),
    );
    expect(d.axis).toBe('category');
    expect(d.categories).toEqual(['a.B', 'c.D']);
    expect(d.x).toEqual([0, 1]);
    expect(effectiveKind('line', d)).toBe('bars');
    expect(effectiveKind('pie', d)).toBe('pie');
  });

  it('a column named t with text is no time axis', () => {
    expect(toChartData(result(['t', 'n'], [['x', 1]])).axis).toBe('category');
  });

  it('rows without time are left out and counted', () => {
    const d = toChartData(
      result(
        ['ts', 'n'],
        [
          [null, 7],
          [T0, 1],
        ],
      ),
    );
    expect(d.x).toEqual([T0]);
    expect(d.skipped).toBe(1);
  });

  it('no rows, no columns, no numbers: nothing to draw, with a reason', () => {
    expect(toChartData(result(['t', 'n'], [])).message).toBe('Keine Zeilen');
    expect(toChartData(result([], [])).axis).toBe('empty');
    expect(toChartData(result(['level', 'name'], [['INFO', 'x']])).message).toContain(
      'Keine Zahlenspalte',
    );
  });

  it('limits the number of series', () => {
    const rows: ReportValue[][] = [];
    for (let i = 0; i < 40; i++) rows.push([T0, `s${i}`, 1]);
    const d = toChartData(result(['t', 'name', 'n'], rows));
    expect(d.series.length).toBe(24);
    expect(d.droppedSeries).toBe(16);
  });
});

describe('pieSlices', () => {
  it('largest first, at most 8, the rest as Sonstige', () => {
    const rows: ReportValue[][] = [];
    for (let i = 1; i <= 10; i++) rows.push([`c${i}`, i]);
    const slices = pieSlices(toChartData(result(['name', 'n'], rows)));
    expect(slices.length).toBe(8);
    expect(slices[0]).toMatchObject({ label: 'c10', value: 10, splitValue: 'c10' });
    expect(slices[7]).toEqual({
      label: 'Sonstige',
      value: 1 + 2 + 3,
      level: null,
      splitValue: null,
    });
  });

  it('with a time axis each series summed, levels keep their level', () => {
    const d = toChartData(
      result(
        ['t', 'level', 'n'],
        [
          [T0, 'INFO', 5],
          [T0 + MIN, 'INFO', 4],
          [T0, 'ERROR', 1],
        ],
      ),
    );
    expect(pieSlices(d)).toEqual([
      { label: 'INFO', value: 9, level: 'INFO', splitValue: 'INFO' },
      { label: 'ERROR', value: 1, level: 'ERROR', splitValue: 'ERROR' },
    ]);
  });

  it('a level column as categories carries the level', () => {
    const d = toChartData(result(['level', 'n'], [['WARN', 2]]));
    expect(pieSlices(d)[0].level).toBe('WARN');
  });
});

describe('click on a time range', () => {
  const d = toChartData(
    result(
      ['t', 'n'],
      [
        [T0, 1],
        [T0 + MIN, 1],
        [T0 + 5 * MIN, 1],
      ],
    ),
  );

  it('the bucket up to the next one, a gap or the last one one step on', () => {
    expect(rangeAt(d, 0)).toEqual({ from: T0, to: T0 + MIN });
    expect(rangeAt(d, 1)).toEqual({ from: T0 + MIN, to: T0 + 2 * MIN });
    expect(rangeAt(d, 2)).toEqual({ from: T0 + 5 * MIN, to: T0 + 6 * MIN });
    expect(rangeAt(d, 3)).toBeNull();
  });

  it('finds the first line with min(line), for a level series of that level', () => {
    expect(firstLineQuery({ from: 1000, to: 2000 }, null)).toBe(
      'SELECT min(line) AS line FROM log WHERE ts >= 1000 AND ts < 2000',
    );
    expect(firstLineQuery({ from: 1000.7, to: 2000 }, 'ERROR')).toBe(
      "SELECT min(line) AS line FROM log WHERE ts >= 1000 AND ts < 2000 AND level = 'ERROR'",
    );
  });

  it('the bucket of the SQL gives the range of a single point', () => {
    const one = toChartData(
      result(['t', 'n'], [[T0, 1]]),
      intervalOf("SELECT bucket(ts, '5m') AS t"),
    );
    expect(rangeAt(one, 0)).toEqual({ from: T0, to: T0 + 5 * MIN });
    expect(intervalOf('SELECT bucket(ts) AS t')).toBe(MIN);
    expect(intervalOf("SELECT bucket(ts, '2h')")).toBe(7_200_000);
    expect(intervalOf("SELECT bucket(ts, '1d')")).toBe(86_400_000);
    expect(intervalOf('SELECT ts')).toBeNull();
  });

  it('a single point has a range of one millisecond at least', () => {
    const one = toChartData(result(['t', 'n'], [[T0, 1]]));
    expect(rangeAt(one, 0)).toEqual({ from: T0, to: T0 + 1 });
  });
});

describe('too many points', () => {
  it('suggests the smallest interval that brings it under the limit', () => {
    const rows: ReportValue[][] = [];
    for (let i = 0; i <= MAX_POINTS; i++) rows.push([T0 + i * MIN, 1]);
    const d = toChartData(result(['t', 'n'], rows));
    expect(suggestInterval(d)).toBe('5m');
    expect(suggestInterval(toChartData(result(['t', 'n'], rows.slice(0, 10))))).toBeNull();
  });

  it('replaces the interval of every bucket call, or adds one', () => {
    expect(withInterval("SELECT bucket(ts, '1m') AS t, bucket(ts) FROM log", '15m')).toBe(
      "SELECT bucket(ts, '15m') AS t, bucket(ts, '15m') FROM log",
    );
  });
});

describe('cells and rows', () => {
  it('times local, numbers German, NULL empty, line as is', () => {
    expect(formatCell('t', Date.UTC(2026, 0, 15, 9))).toMatch(/^2026-01-15 \d\d:00:00$/);
    expect(formatCell('n', 1234.5)).toBe('1.234,5');
    expect(formatCell('line', 12345)).toBe('12345');
    expect(formatCell('x', null)).toBe('');
    expect(formatCell('x', '<b>')).toBe('<b>');
  });

  it('a row with a line column is a link', () => {
    const r = result(
      ['line', 'level'],
      [
        [42, 'ERROR'],
        [null, 'INFO'],
        [0, 'INFO'],
      ],
    );
    expect(lineOfRow(r, 0)).toBe(42);
    expect(lineOfRow(r, 1)).toBeNull();
    expect(lineOfRow(r, 2)).toBeNull();
    expect(lineOfRow(result(['n'], [[1]]), 0)).toBeNull();
  });

  it('single value: the first number of the first row', () => {
    expect(singleValue(result(['name', 'n'], [['x', 5]]))).toBe(5);
    expect(singleValue(result(['name'], [['x']]))).toBe('x');
    expect(singleValue(result(['n'], []))).toBeNull();
  });
});

describe('describeQueryError', () => {
  it('known messages in German, the rest as the engine says', () => {
    expect(describeQueryError('time limit of 10 s exceeded')).toBe(
      'Zeitlimit von 10 s überschritten',
    );
    expect(describeQueryError('not authorized')).toContain('nur Lesen');
    expect(describeQueryError('too many queries at once (at most 6)')).toBe(
      'Zu viele Abfragen zugleich (höchstens 6)',
    );
    expect(describeQueryError('string or blob too big')).toContain('64 KB');
    expect(describeQueryError('no such column: foo (at character 8)')).toBe(
      'no such column: foo (at character 8)',
    );
  });
});
