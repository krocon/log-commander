import { describe, expect, it } from 'vitest';
import { rowMenuItems } from './row-menu';

describe('row menu', () => {
  it('offers what fits: marked text, the value of a cell, a section', () => {
    expect(rowMenuItems({ selectedText: '', cell: null, hasLine: false })).toEqual([]);
    const all = rowMenuItems({
      selectedText: '  req-42\n',
      cell: { label: 'Thread', value: 'main ' },
      hasLine: true,
    });
    expect(all.map((i) => i.id)).toEqual([
      'filter-text',
      'exclude-text',
      'filter-value',
      'from-here',
      'to-here',
    ]);
    expect(all[0].label).toBe('Filtern auf „req-42“');
    expect(all[2].label).toBe('Filtern nach Thread = „main“');
    const long = rowMenuItems({ selectedText: 'x'.repeat(50), cell: null, hasLine: false });
    expect(long[0].label.length).toBeLessThan(50);
  });
});
