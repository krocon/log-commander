import { describe, expect, it } from 'vitest';
import { buildSegments, tokenize } from './highlight';

const classes = (text: string) =>
  tokenize(text).map((t) => [text.slice(t.start, t.end), t.cls] as const);

describe('highlight', () => {
  it('finds timestamps, levels, numbers, strings', () => {
    expect(classes('2024-01-15 10:00:00,123 ERROR took 15 ms "a b"')).toEqual([
      ['2024-01-15 10:00:00,123', 't-time'],
      ['ERROR', 't-level'],
      ['15', 't-number'],
      ['"a b"', 't-string'],
    ]);
  });

  it('finds uuid, ip and url', () => {
    expect(
      classes('id 123e4567-e89b-12d3-a456-426614174000 from 10.0.0.1:8080 at https://a.io/x?y=1'),
    ).toEqual([
      ['123e4567-e89b-12d3-a456-426614174000', 't-id'],
      ['10.0.0.1:8080', 't-id'],
      ['https://a.io/x?y=1', 't-url'],
    ]);
  });

  it('marks only the first level word', () => {
    expect(classes('INFO some ERROR here').map((c) => c[0])).toEqual(['INFO']);
  });

  it('the text survives segmenting unchanged', () => {
    const text = 'INFO a "q" 12 b';
    const joined = buildSegments(text, [[2, 9]])
      .map((s) => s.text)
      .join('');
    expect(joined).toBe(text);
  });

  it('search matches lie over tokens', () => {
    const segments = buildSegments('took 1234 ms', [[7, 12]]);
    expect(segments).toEqual([
      { text: 'took ', cls: '' },
      { text: '12', cls: 't-number' },
      { text: '34', cls: 't-number hit' },
      { text: ' ms', cls: 'hit' },
    ]);
  });

  it('handles empty lines and very long ones', () => {
    expect(buildSegments('', [])).toEqual([]);
    const long = 'x'.repeat(100_000) + ' 12';
    expect(
      buildSegments(long, [])
        .map((s) => s.text)
        .join(''),
    ).toBe(long);
  });
});
