import { describe, expect, it } from 'vitest';
import { ALL_LEVELS, levelAndSevere, onlyLevel, sameLevels, toggleLevel } from './filter-logic';

describe('filter logic', () => {
  it('toggles a level', () => {
    const off = toggleLevel(ALL_LEVELS, 'INFO');
    expect(off.has('INFO')).toBe(false);
    expect(toggleLevel(off, 'INFO').has('INFO')).toBe(true);
  });

  it('only this level', () => {
    expect([...onlyLevel('ERROR')]).toEqual(['ERROR']);
  });

  it('level and more severe, without UNKNOWN', () => {
    expect([...levelAndSevere('WARN')]).toEqual(['WARN', 'ERROR', 'FATAL']);
    expect([...levelAndSevere('FATAL')]).toEqual(['FATAL']);
    expect([...levelAndSevere('UNKNOWN')]).toEqual(['UNKNOWN']);
  });

  it('compares sets', () => {
    expect(sameLevels(new Set(['WARN', 'ERROR']), new Set(['ERROR', 'WARN']))).toBe(true);
    expect(sameLevels(new Set(['WARN']), new Set(['ERROR']))).toBe(false);
  });
});
