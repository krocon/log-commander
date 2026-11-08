import { describe, expect, it } from 'vitest';
import { BUILT_IN_THEMES, DARK, LIGHT } from '../../core/theme/builtin-themes';
import {
  THUMB_TOKENS,
  matchesFilter,
  moveInGrid,
  pickerSections,
  thumbStyle,
} from './theme-picker-logic';

describe('theme picker logic', () => {
  it('lists „System folgen“ first, then dark and light schemes', () => {
    const sections = pickerSections(BUILT_IN_THEMES, '');
    expect(sections.map((s) => s.key)).toEqual(['system', 'dark', 'light']);
    expect(sections[1].cards.every((c) => c.dark)).toBe(true);
    expect(sections[2].cards.map((c) => c.id)).toEqual(['light', 'true-light', 'solarized-light']);
  });

  it('filters by words in the name and by hell/dunkel', () => {
    const ids = (f: string) =>
      pickerSections(BUILT_IN_THEMES, f).flatMap((s) => s.cards.map((c) => c.id));
    expect(ids('hell')).toEqual(['system', 'light', 'true-light', 'solarized-light']);
    expect(ids('one VIVID')).toEqual(['one-dark-vivid']);
    expect(ids('rainglow dunkel')).toHaveLength(5);
    expect(ids('xyz')).toEqual([]);
    expect(matchesFilter({ id: 'amber', name: 'Amber', dark: true }, 'dark amb')).toBe(true);
  });

  it('moves in the grid by geometry, by columns without a layout', () => {
    const flat = Array.from({ length: 6 }, () => ({ top: 0, left: 0 }));
    expect(moveInGrid(1, 'ArrowRight', flat, 4)).toBe(2);
    expect(moveInGrid(0, 'ArrowLeft', flat, 4)).toBe(0);
    expect(moveInGrid(1, 'ArrowDown', flat, 4)).toBe(5);
    expect(moveInGrid(1, 'ArrowUp', flat, 4)).toBe(-1);
    expect(moveInGrid(2, 'End', flat, 4)).toBe(5);
    expect(moveInGrid(2, 'x', flat, 4)).toBeNull();
    // system card alone, then a row of three, then two
    const boxes = [
      { top: 0, left: 0 },
      { top: 100, left: 0 },
      { top: 100, left: 100 },
      { top: 100, left: 200 },
      { top: 200, left: 0 },
      { top: 200, left: 100 },
    ];
    expect(moveInGrid(0, 'ArrowDown', boxes, 4)).toBe(1);
    expect(moveInGrid(3, 'ArrowDown', boxes, 4)).toBe(5);
    expect(moveInGrid(5, 'ArrowUp', boxes, 4)).toBe(2);
    expect(moveInGrid(2, 'ArrowUp', boxes, 4)).toBe(0);
    expect(moveInGrid(0, 'ArrowUp', boxes, 4)).toBe(-1);
    expect(moveInGrid(4, 'ArrowDown', boxes, 4)).toBe(4);
  });

  it('paints thumbnails only with resolved #rrggbb colours', () => {
    for (const theme of BUILT_IN_THEMES) {
      const style = thumbStyle(theme, LIGHT, DARK);
      expect(Object.keys(style)).toHaveLength(THUMB_TOKENS.length);
      for (const value of Object.values(style)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
