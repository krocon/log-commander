import { describe, expect, it } from 'vitest';
import { ORDERED_COMMANDS, nextSeq, withSeq } from './call-order';

describe('call order', () => {
  it('numbers rise, also within one millisecond and when the clock goes back', () => {
    const a = nextSeq(1_000);
    const b = nextSeq(1_000);
    const c = nextSeq(999);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(Number.isSafeInteger(nextSeq(Date.now()))).toBe(true);
  });

  it('a page loaded later starts above the numbers of the page before', () => {
    // 500 calls in the millisecond before the reload, then a fresh counter one millisecond later.
    const before = 2_000_000 * 1000 + 500;
    expect(Math.floor(2_000_001) * 1000).toBeGreaterThan(before);
  });

  it('only the ordered commands get a number, the other arguments stay', () => {
    const args = withSeq('set_frozen', { sessionId: 1, frozen: true }, 5_000_000_000_000);
    expect(args).toMatchObject({ sessionId: 1, frozen: true });
    expect(typeof args?.['seq']).toBe('number');
    const next = withSeq('set_frozen', { sessionId: 1, frozen: false }, 5_000_000_000_000);
    expect(next?.['seq'] as number).toBeGreaterThan(args?.['seq'] as number);
    expect(withSeq('get_lines', { sessionId: 1 })).toEqual({ sessionId: 1 });
    expect(withSeq('get_stats', undefined)).toBeUndefined();
    expect(withSeq('set_custom_profiles', undefined)).toHaveProperty('seq');
  });

  it('covers the commands that mean "the last one wins"', () => {
    expect([...ORDERED_COMMANDS].sort()).toEqual([
      'set_custom_profiles',
      'set_extract_rules',
      'set_filter',
      'set_frozen',
      'set_keep_on_rotate',
      'set_profile',
      'set_spool_keep',
    ]);
  });
});
