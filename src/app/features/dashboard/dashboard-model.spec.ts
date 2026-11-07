import { describe, expect, it } from 'vitest';
import { ReportSchema, SchemaColumn } from '../../core/log/log.models';
import {
  defaultDashboard,
  mergeDashboards,
  moved,
  resized,
  templates,
  toggleField,
} from './dashboard-model';

const col = (name: string, extra: Partial<SchemaColumn> = {}): SchemaColumn => ({
  name,
  sqlType: 'TEXT',
  description: name,
  column: null,
  kind: null,
  unit: null,
  included: true,
  ...extra,
});

const schema = (sources = 1): ReportSchema => ({
  table: 'log',
  columns: [
    col('line', { sqlType: 'INTEGER' }),
    col('ts', { sqlType: 'INTEGER' }),
    col('level'),
    col('source', { sqlType: 'INTEGER' }),
    col('took', { sqlType: 'REAL', column: 'took', kind: 'duration', description: 'took' }),
    col('cpu', { sqlType: 'REAL', column: 'cpu', kind: 'percent', description: 'cpu' }),
    col('mem', { sqlType: 'REAL', column: 'mem', kind: 'size', description: 'mem' }),
    col('logger', { column: 'logger', included: false }),
  ],
  sources: Array.from({ length: sources }, (_, i) => `f${i}.log`),
  status: null,
});

describe('templates', () => {
  it('levels per minute, error rate, a per-source one only for a merge, one per number field', () => {
    const ids = templates(schema()).map((t) => t.id);
    expect(ids).toContain('levels-per-minute');
    expect(ids).toContain('error-rate');
    expect(ids).not.toContain('per-source');
    expect(ids).toContain('field-took');
    expect(ids).toContain('field-mem');
    expect(templates(schema(2)).map((t) => t.id)).toContain('per-source');
  });

  it('are plain SQL with bucket and the field in its base unit', () => {
    const took = templates(schema()).find((t) => t.id === 'field-took');
    expect(took?.sql).toContain('avg("took") AS mittel, max("took") AS maximum');
    expect(took?.sql).toContain("bucket(ts, '1m')");
    expect(took?.title).toContain('(s)');
    const levels = templates(schema()).find((t) => t.id === 'levels-per-minute');
    expect(levels?.sql).toMatch(/GROUP BY t, level/);
  });

  it('quotes field names that are SQL keywords', () => {
    const s = schema();
    s.columns.push(col('order', { sqlType: 'REAL', column: 'order', kind: 'number' }));
    const sql = templates(s).find((t) => t.id === 'field-order')?.sql ?? '';
    expect(sql).toContain('avg("order") AS mittel, max("order") AS maximum');
    expect(sql).toContain('AND "order" IS NOT NULL');
  });

  it('no template for numbers that are ids', () => {
    const s = schema();
    s.columns.push(col('pid', { sqlType: 'REAL', column: 'pid', kind: 'number' }));
    expect(templates(s).map((t) => t.id)).not.toContain('field-pid');
  });

  it('without a schema still the general ones', () => {
    expect(templates(null).length).toBe(5);
  });

  it('a new dashboard takes two number fields at most', () => {
    const d = defaultDashboard(schema());
    expect(d.panels.filter((p) => p.title.includes('Mittel')).length).toBe(2);
    expect(d.auto).toBe(true);
    expect(d.fields).toBeNull();
    expect(new Set(d.panels.map((p) => p.id)).size).toBe(d.panels.length);
  });
});

describe('mergeDashboards', () => {
  it('drops broken panels and repairs values', () => {
    const merged = mergeDashboards({
      log4j: {
        panels: [
          { id: 'a', title: 'A', sql: 'SELECT 1', kind: 'pie', width: 3, height: 'l' },
          { id: 'a', title: 'dup', sql: 'SELECT 2' },
          { id: 'b', sql: 'SELECT 3', kind: 'nope', width: 9, height: 'x' },
          { id: '', sql: 'x' },
          { title: 'no id', sql: 'x' },
          'broken',
        ],
        auto: false,
        fields: ['logger', 3],
      },
      broken: 'x',
    });
    expect(Object.keys(merged)).toEqual(['log4j']);
    const d = merged['log4j'];
    expect(d.panels.map((p) => p.id)).toEqual(['a', 'b']);
    expect(d.panels[1]).toEqual({
      id: 'b',
      title: 'Panel',
      sql: 'SELECT 3',
      kind: 'line',
      width: 2,
      height: 'm',
    });
    expect(d.auto).toBe(false);
    expect(d.fields).toBeNull();
  });

  it('nothing stored is no dashboard', () => {
    expect(mergeDashboards(undefined)).toEqual({});
    expect(mergeDashboards([])).toEqual({});
  });
});

describe('fields and layout', () => {
  it('ticking a field starts from what the table has', () => {
    expect(toggleField(schema(), null, 'logger', true)).toEqual(['took', 'cpu', 'mem', 'logger']);
    expect(toggleField(schema(), ['took'], 'took', false)).toEqual([]);
  });

  it('sizes stay within the grid, moving swaps neighbours', () => {
    const p = {
      id: 'a',
      title: '',
      sql: '',
      kind: 'line' as const,
      width: 4 as const,
      height: 'l' as const,
    };
    expect(resized(p, 'wider').width).toBe(4);
    expect(resized(p, 'narrower').width).toBe(3);
    expect(resized(p, 'taller').height).toBe('l');
    expect(resized(p, 'lower').height).toBe('m');
    const q = { ...p, id: 'b' };
    expect(moved([p, q], 'b', -1).map((x) => x.id)).toEqual(['b', 'a']);
    expect(moved([p, q], 'a', -1).map((x) => x.id)).toEqual(['a', 'b']);
  });
});
