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
      'filter-text-tab',
      'column-from-selection',
      'filter-value',
      'filter-value-tab',
      'from-here',
      'to-here',
    ]);
    expect(all[0].label).toBe('Filtern auf „req-42“');
    expect(all[2].label).toBe('In neuem Tab filtern auf „req-42“');
    expect(all[4].label).toBe('Filtern nach Thread = „main“');
    expect(all[2].disabled).toBeUndefined();
    const long = rowMenuItems({ selectedText: 'x'.repeat(50), cell: null, hasLine: false });
    expect(long[0].label.length).toBeLessThan(50);
    // A column from marked text needs the line it is in.
    expect(long.map((i) => i.id)).not.toContain('column-from-selection');
  });

  it('greys out the filter tabs at the limit and says why (prompt 013)', () => {
    const items = rowMenuItems({
      selectedText: 'x',
      cell: { label: 'Thread', value: 'main' },
      hasLine: false,
      tabLimit: 'Höchstens 8 Tabs je Datei',
    });
    const tabs = items.filter((i) => i.id.endsWith('-tab'));
    expect(tabs).toHaveLength(2);
    expect(tabs.every((i) => i.disabled && i.title === 'Höchstens 8 Tabs je Datei')).toBe(true);
  });
});
