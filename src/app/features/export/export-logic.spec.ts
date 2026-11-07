import { describe, expect, it } from 'vitest';
import { Column } from '../../core/log/log.models';
import {
  exportColumns,
  exportFileName,
  exportRange,
  progressText,
  withExtension,
} from './export-logic';

const col = (id: string, label = id): Column => ({ id, label, kind: 'text' }) as Column;

describe('export logic', () => {
  it('suggests a file name per scope and format', () => {
    expect(exportFileName('app.log', 'view', 'csv')).toBe('app-ansicht.csv');
    expect(exportFileName('2 Dateien', 'all', 'jsonl')).toBe('2 Dateien-alles.jsonl');
    expect(exportFileName('a:b?.log', 'selection', 'txt')).toBe('a_b_-auswahl.txt');
    expect(exportFileName('', 'all', 'txt')).toBe('log-alles.txt');
  });

  it('adds the extension the backend needs', () => {
    expect(withExtension('/x/out', 'csv')).toBe('/x/out.csv');
    expect(withExtension('/x/out.CSV', 'csv')).toBe('/x/out.CSV');
    expect(withExtension('/x/out.txt', 'jsonl')).toBe('/x/out.txt.jsonl');
    expect(withExtension('/x/out.log', 'txt')).toBe('/x/out.log');
    expect(withExtension('C:\\x\\out.ndjson', 'jsonl')).toBe('C:\\x\\out.ndjson');
  });

  it('turns the scope into a range', () => {
    expect(exportRange('selection', null)).toBeNull();
    expect(exportRange('selection', { first: 3, last: 9 })).toEqual({
      kind: 'selection',
      first: 3,
      last: 9,
    });
    expect(exportRange('view', null)).toEqual({ kind: 'view' });
    expect(exportRange('all', { first: 1, last: 2 })).toEqual({ kind: 'all' });
  });

  it('offers the columns of the format in the order of the view', () => {
    expect(exportColumns(null)).toEqual([]);
    expect(exportColumns([col('message')])).toEqual([]);
    const cols = [col('timestamp', 'Zeit'), col('level', 'Level'), col('message', 'Nachricht')];
    expect(exportColumns(cols, ['message', 'timestamp']).map((c) => c.id)).toEqual([
      'message',
      'timestamp',
      'level',
    ]);
  });

  it('writes the progress', () => {
    expect(
      progressText({
        jobId: 1,
        state: 'running',
        lines: 1500,
        total: 3000,
        bytes: 2048,
        path: '/x',
        error: null,
      }),
    ).toBe('Export 50 % · 1.500 Zeilen · 2 KB');
  });
});
