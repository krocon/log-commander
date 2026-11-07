import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, MAX_RECENT_FILES, addRecent, mergeSettings } from './settings.models';

describe('settings', () => {
  it('falls back to defaults for missing or broken values', () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    const broken = mergeSettings({
      theme: 'pink' as never,
      fontSize: 'x' as never,
      recentFiles: 7 as never,
      colorOverrides: null as never,
    });
    expect(broken.theme).toBe('system');
    expect(broken.fontSize).toBe(DEFAULT_SETTINGS.fontSize);
    expect(broken.recentFiles).toEqual([]);
    expect(broken.colorOverrides).toEqual({});
  });

  it('limits the font size', () => {
    expect(mergeSettings({ fontSize: 500 }).fontSize).toBe(24);
    expect(mergeSettings({ fontSize: 1 }).fontSize).toBe(9);
  });

  it('keeps recent files unique, newest first, limited', () => {
    expect(addRecent(['a', 'b'], 'b')).toEqual(['b', 'a']);
    const many = Array.from({ length: 30 }, (_, i) => `f${i}`);
    expect(addRecent(many, 'new')).toHaveLength(MAX_RECENT_FILES);
  });
});
