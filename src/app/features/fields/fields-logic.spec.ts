import { describe, expect, it } from 'vitest';
import { Column, ExtractRule, FieldSuggestion } from '../../core/log/log.models';
import {
  acceptSuggestions,
  formatColumns,
  formatShare,
  formatValue,
  freeName,
  hintText,
  newRuleId,
  picksOf,
  ruleIssues,
} from './fields-logic';

const COLUMNS: Column[] = [
  { id: 'timestamp', label: 'Zeit', kind: 'timestamp' },
  { id: 'message', label: 'Nachricht', kind: 'text' },
];
const rule = (name: string, extra: Partial<ExtractRule> = {}): ExtractRule => ({
  id: `r-${name}`,
  name,
  column: 'message',
  pattern: `${name}=(\\d+)`,
  kind: 'number',
  unit: null,
  ...extra,
});
const suggestion = (name: string, kind: ExtractRule['kind'] = 'percent'): FieldSuggestion => ({
  rule: rule(name, { id: `s-${name}`, kind, unit: kind === 'number' ? null : '%' }),
  examples: ['1', '2'],
  share: 0.5,
  distinct: 2,
});

describe('fields logic', () => {
  it('finds names that are missing, twice or a column, and too many rules', () => {
    const issues = ruleIssues(
      [
        rule('cpu'),
        rule('CPU', { id: 'b' }),
        rule('nachricht', { id: 'c' }),
        rule(' ', { id: 'd' }),
      ],
      COLUMNS,
    );
    expect(issues.get('r-cpu')).toBeUndefined();
    expect(issues.get('b')).toContain('doppelt');
    expect(issues.get('c')).toContain('schon eine Spalte (Nachricht)');
    expect(issues.get('d')).toBe('Name fehlt');
    const many = Array.from({ length: 33 }, (_, i) => rule(`f${i}`));
    expect(ruleIssues(many, COLUMNS).get('r-f32')).toContain('Höchstens 32');
    expect(ruleIssues([rule('x', { pattern: '' })], COLUMNS).get('r-x')).toBe('Muster fehlt');
  });

  it('leaves extracted columns out of the format columns', () => {
    const set = {
      revision: 1,
      confidence: 1,
      profileId: 'log4j',
      inferredLayout: null,
      columns: [...COLUMNS, { id: 'cpu', label: 'cpu', kind: 'percent' as const, rule: 'r-cpu' }],
    };
    expect(formatColumns(set).map((c) => c.id)).toEqual(['timestamp', 'message']);
    expect(formatColumns(null)).toEqual([]);
  });

  it('makes ids and names unique', () => {
    expect(newRuleId([], 35)).toBe('r-z');
    expect(newRuleId([{ id: 'r-z' }], 35)).toBe('r-10');
    expect(freeName('cpu', [rule('cpu')], COLUMNS)).toBe('cpu_2');
    expect(freeName('message', [], COLUMNS)).toBe('message_2');
    expect(freeName('mem', [], COLUMNS)).toBe('mem');
    expect(freeName('  ', [], COLUMNS)).toBe('feld');
  });

  it('accepts picked suggestions with the edited name and kind', () => {
    const picks = picksOf(
      [suggestion('cpu'), suggestion('took', 'duration'), suggestion('old')],
      [rule('old')],
    );
    expect(picks.map((p) => p.name)).toEqual(['cpu', 'took']);
    picks[0].name = ' load ';
    picks[0].kind = 'number';
    picks[1].picked = false;
    const rules = acceptSuggestions([rule('old')], picks);
    expect(rules.map((r) => [r.name, r.kind, r.unit, r.id])).toEqual([
      ['old', 'number', null, 'r-old'],
      ['load', 'number', null, 's-cpu'],
    ]);
    // An id taken already gets a new one.
    const again = acceptSuggestions(rules, picksOf([suggestion('cpu')]));
    expect(new Set(again.map((r) => r.id)).size).toBe(3);
  });

  it('formats shares, values and the hint', () => {
    expect(formatShare(0.734)).toBe('73 %');
    expect(formatShare(0.052)).toBe('5.2 %');
    expect(formatValue(0.34, 'duration')).toBe('0.34 s');
    expect(formatValue(1288490188.8, 'size')).toBe('1288490000 B');
    expect(formatValue(72.3, 'percent')).toBe('72.3 %');
    expect(formatValue(null, 'number')).toBe('–');
    expect(hintText(1)).toBe('1 Feld erkannt');
    expect(hintText(4)).toBe('4 Felder erkannt');
  });
});
