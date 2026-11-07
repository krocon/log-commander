import { describe, expect, it } from 'vitest';
import { formatMapping, newProfileId, parseMapping } from './profile-logic';

describe('profile logic', () => {
  it('parses word=level lines', () => {
    expect(parseMapping('OOPS=fatal\n\n meh = WARN ')).toEqual({
      mapping: { OOPS: 'FATAL', meh: 'WARN' },
    });
  });

  it('reports the bad line', () => {
    const result = parseMapping('OOPS=LOUD');
    expect('error' in result && result.error).toContain('OOPS=LOUD');
    expect('error' in parseMapping('nothing')).toBe(true);
  });

  it('formats back', () => {
    expect(formatMapping({ A: 'INFO', B: 'WARN' })).toBe('A=INFO\nB=WARN');
    expect(formatMapping(undefined)).toBe('');
  });

  it('finds a free id', () => {
    const profile = (id: string) => ({ id, name: id, patterns: [] });
    expect(newProfileId([])).toBe('custom-1');
    expect(newProfileId([profile('custom-2')])).toBe('custom-3');
  });
});
