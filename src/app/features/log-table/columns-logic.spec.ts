import { describe, expect, it } from 'vitest';
import { Column, ColumnSet, LogLine } from '../../core/log/log.models';
import {
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  canMove,
  clampWidth,
  columnsActive,
  fillWidth,
  layoutFromTable,
  layoutOf,
  moveColumn,
  resolveColumns,
  setHidden,
  sliceSegments,
  spanStart,
  spansRow,
} from './columns-logic';
import { cellSegments } from './highlight';

const COLUMNS: Column[] = [
  { id: 'timestamp', label: 'Zeit', kind: 'timestamp' },
  { id: 'level', label: 'Level', kind: 'level' },
  { id: 'thread', label: 'Thread', kind: 'text' },
  { id: 'message', label: 'Nachricht', kind: 'text' },
];
const set = (columns: Column[]): ColumnSet => ({
  revision: 1,
  confidence: 1,
  profileId: 'log4j',
  inferredLayout: null,
  columns,
});
const ids = (cols: { id: string }[]) => cols.map((c) => c.id).join(',');

function line(text: string, fields: [number, number][], extra: Partial<LogLine> = {}): LogLine {
  return {
    line: 0,
    level: 'INFO',
    source: 0,
    text,
    isContinuation: false,
    truncated: false,
    matches: [],
    fields,
    ...extra,
  };
}

describe('columns-logic', () => {
  it('shows columns only for more than the message', () => {
    expect(columnsActive('columns', set(COLUMNS))).toBe(true);
    expect(columnsActive('raw', set(COLUMNS))).toBe(false);
    expect(columnsActive('columns', set([COLUMNS[3]]))).toBe(false);
    expect(columnsActive('columns', null)).toBe(false);
  });

  it('starts in the order of the format with widths by kind', () => {
    const cols = resolveColumns(COLUMNS, undefined, 8);
    expect(ids(cols)).toBe('timestamp,level,thread,message');
    expect(cols.map((c) => c.field)).toEqual([0, 1, 2, 3]);
    expect(cols[0].width).toBeGreaterThan(cols[1].width);
    expect(cols.every((c) => !c.hidden)).toBe(true);
  });

  it('merges a saved layout: saved order, new columns at the end, gone ones ignored', () => {
    const cols = resolveColumns(
      COLUMNS,
      {
        order: ['message', 'gone', 'level', 'level'],
        widths: { level: 99, gone: 5 },
        hidden: ['thread'],
      },
      8,
    );
    expect(ids(cols)).toBe('message,level,timestamp,thread');
    expect(cols.find((c) => c.id === 'level')!.width).toBe(99);
    expect(cols.find((c) => c.id === 'level')!.field).toBe(1);
    expect(cols.find((c) => c.id === 'thread')!.hidden).toBe(true);
  });

  it('never hides the message', () => {
    const cols = resolveColumns(COLUMNS, { order: [], widths: {}, hidden: ['message'] }, 8);
    expect(cols.find((c) => c.id === 'message')!.hidden).toBe(false);
    expect(setHidden(cols, 'message', true).find((c) => c.id === 'message')!.hidden).toBe(false);
    expect(setHidden(cols, 'level', true).find((c) => c.id === 'level')!.hidden).toBe(true);
  });

  it('clamps widths', () => {
    expect(clampWidth(3)).toBe(MIN_COLUMN_WIDTH);
    expect(clampWidth(1e9)).toBe(MAX_COLUMN_WIDTH);
    expect(clampWidth(Number.NaN)).toBe(MIN_COLUMN_WIDTH);
    expect(clampWidth(100.6)).toBe(101);
    const cols = resolveColumns(COLUMNS, { order: [], widths: { level: 1 }, hidden: [] }, 8);
    expect(cols[1].width).toBe(MIN_COLUMN_WIDTH);
  });

  it('moves past hidden neighbours and not beyond the ends', () => {
    const cols = setHidden(resolveColumns(COLUMNS, undefined, 8), 'level', true);
    expect(ids(moveColumn(cols, 'thread', -1))).toBe('thread,timestamp,level,message');
    expect(ids(moveColumn(cols, 'timestamp', -1))).toBe(ids(cols));
    expect(ids(moveColumn(cols, 'message', 1))).toBe(ids(cols));
    expect(canMove(cols, 'message', 1)).toBe(false);
    expect(canMove(cols, 'message', -1)).toBe(true);
  });

  it('round-trips through the settings', () => {
    const cols = setHidden(resolveColumns(COLUMNS, undefined, 8), 'thread', true);
    expect(resolveColumns(COLUMNS, layoutOf(cols), 8)).toEqual(cols);
  });

  it('takes order and widths from the table, but not the width of the filling last column', () => {
    const cols = resolveColumns(COLUMNS, undefined, 8);
    const next = layoutFromTable(cols, ['level', 'timestamp', 'thread', 'message'], {
      level: 80,
      timestamp: 150,
      thread: 90,
      message: 1234,
    });
    expect(ids(next)).toBe('level,timestamp,thread,message');
    expect(next[0].width).toBe(80);
    expect(next[3].width).toBe(cols[3].width);
  });

  it('fills the rest with the last column, at least its content', () => {
    expect(fillWidth(100, 1000, 300)).toBe(700);
    expect(fillWidth(900, 1000, 300)).toBe(900);
    expect(fillWidth(0, 100, 300)).toBe(MIN_COLUMN_WIDTH);
  });

  it('lets continuations and unsplit lines span', () => {
    expect(
      spansRow(
        line('a b', [
          [0, 1],
          [0, 0],
          [0, 0],
          [2, 3],
        ]),
        3,
      ),
    ).toBe(false);
    expect(
      spansRow(
        line(
          '  at x',
          [
            [0, 0],
            [0, 0],
            [0, 0],
            [0, 6],
          ],
          { isContinuation: true },
        ),
        3,
      ),
    ).toBe(true);
    expect(
      spansRow(
        line('banner', [
          [0, 0],
          [0, 0],
          [0, 0],
          [0, 6],
        ]),
        3,
      ),
    ).toBe(true);
    expect(spansRow(line('no fields', []), 3)).toBe(true);
  });

  it('starts a span at the first column still in view', () => {
    expect(spanStart([100, 0, 50, 300], 0)).toEqual({ index: 0, offset: 0 });
    expect(spanStart([100, 0, 50, 300], 120)).toEqual({ index: 2, offset: 100 });
    expect(spanStart([100, 0, 50, 300], 100)).toEqual({ index: 2, offset: 100 });
    expect(spanStart([100, 50], 5000)).toEqual({ index: 1, offset: 100 });
  });
});

describe('cellSegments', () => {
  it('cuts segments at the field boundaries, a match across them in both cells', () => {
    const segs = [
      { text: 'abc', cls: '' },
      { text: 'def', cls: 'hit' },
      { text: 'gh', cls: '' },
    ];
    expect(sliceSegments(segs, 0, 4)).toEqual([
      { text: 'abc', cls: '' },
      { text: 'd', cls: 'hit' },
    ]);
    expect(sliceSegments(segs, 4, 8)).toEqual([
      { text: 'ef', cls: 'hit' },
      { text: 'gh', cls: '' },
    ]);
    expect(sliceSegments(segs, 3, 3)).toEqual([]);
  });

  it('keeps tokens and matches in the cells of a line', () => {
    const l = line(
      '12:00:01 boom here',
      [
        [0, 8],
        [9, 13],
        [0, 0],
        [14, 18],
      ],
      {
        matches: [[11, 16]],
      },
    );
    expect(cellSegments(l, 0)).toEqual([{ text: '12:00:01', cls: 't-time' }]);
    expect(cellSegments(l, 1)).toEqual([
      { text: 'bo', cls: '' },
      { text: 'om', cls: 'hit' },
    ]);
    expect(cellSegments(l, 2)).toEqual([]);
    expect(cellSegments(l, 3)).toEqual([
      { text: 'he', cls: 'hit' },
      { text: 're', cls: '' },
    ]);
    expect(cellSegments(l, 1)).toBe(cellSegments(l, 1));
  });

  it('counts UTF-16 code units like the backend (emoji)', () => {
    const l = line('😀 x|größer', [
      [0, 4],
      [5, 11],
    ]);
    expect(
      cellSegments(l, 0)
        .map((s) => s.text)
        .join(''),
    ).toBe('😀 x');
    expect(
      cellSegments(l, 1)
        .map((s) => s.text)
        .join(''),
    ).toBe('größer');
  });

  it('puts a line without fields into the fallback column', () => {
    const l = line('plain text', []);
    expect(
      cellSegments(l, 3, 3)
        .map((s) => s.text)
        .join(''),
    ).toBe('plain text');
    expect(cellSegments(l, 0, 3)).toEqual([]);
  });

  it('carries overlapping spans: an extracted value stays in the message (prompt 011)', () => {
    // cpu and took lie inside the message; a match over the value.
    const text = 'INFO 🎉 cpu=72.3% took 340ms';
    const l = line(
      text,
      [
        [0, 4],
        [5, text.length],
        [12, 16],
        [23, text.length],
      ],
      { matches: [[12, 14]] },
    );
    const join = (field: number) =>
      cellSegments(l, field)
        .map((s) => s.text)
        .join('');
    expect(join(1)).toBe('🎉 cpu=72.3% took 340ms');
    expect(join(2)).toBe('72.3');
    expect(join(3)).toBe('340ms');
    // The match lies in both cells, the message and the extracted one.
    expect(cellSegments(l, 2)[0]).toEqual({ text: '72', cls: 't-number hit' });
    expect(cellSegments(l, 1).some((s) => s.text === '72' && s.cls.includes('hit'))).toBe(true);
  });
});
