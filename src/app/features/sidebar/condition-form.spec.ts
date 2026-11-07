import { describe, expect, it } from 'vitest';
import { FilterCond } from '../../core/log/log.models';
import { emptyForm, formOf, toCond } from './condition-form';

describe('condition form', () => {
  it('says what is missing before it gives a condition', () => {
    expect(toCond(emptyForm())).toEqual({ missing: 'Text fehlt' });
    expect(toCond({ ...emptyForm(), type: 'level', levels: [] })).toEqual({
      missing: 'Mindestens ein Level wählen',
    });
    expect(toCond({ ...emptyForm(), type: 'time' })).toEqual({
      missing: 'Beginn oder Ende angeben',
    });
    expect(toCond({ ...emptyForm(), type: 'lines', firstLine: 'x' })).toEqual({
      missing: 'Zeilennummern ab 1',
    });
    expect(toCond({ ...emptyForm(), type: 'lines', firstLine: '9', lastLine: '3' })).toEqual({
      missing: 'Die erste Zeile liegt nach der letzten',
    });
    expect(toCond({ ...emptyForm(), type: 'field', op: 'between', value: '1' })).toEqual({
      missing: 'Beide Grenzen angeben',
    });
  });

  it('round-trips every kind, line numbers from 1 in the form and from 0 in the condition', () => {
    const conds: FilterCond[] = [
      { type: 'text', text: 'Timeout', isRegex: false, caseSensitive: true },
      { type: 'level', levels: ['WARN', 'ERROR'] },
      {
        type: 'field',
        column: 'thread',
        op: 'between',
        value: 'a',
        value2: 'm',
        caseSensitive: false,
      },
      { type: 'time', from: '2024-01-15 10:00', to: null },
      {
        type: 'range',
        start: { text: 'BEGIN', isRegex: true, caseSensitive: false },
        end: { text: 'END', isRegex: true, caseSensitive: false },
        inclusive: false,
      },
      { type: 'lines', first: 99, last: null },
    ];
    for (const cond of conds) {
      const form = formOf(cond, true);
      expect(form.negate).toBe(true);
      expect(toCond(form)).toEqual({ cond });
    }
    expect(formOf({ type: 'lines', first: 99, last: 199 }, false).firstLine).toBe('100');
  });

  it('keeps what was typed when the kind changes', () => {
    const form = { ...emptyForm(), text: 'request-42' };
    expect(toCond({ ...form, type: 'range' })).toMatchObject({
      cond: { type: 'range', start: { text: 'request-42' }, end: null, inclusive: true },
    });
  });
});
