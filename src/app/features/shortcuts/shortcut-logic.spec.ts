import { describe, expect, it } from 'vitest';
import { resolveKeymap } from '../../core/actions/keymap';
import { shortcutGroups } from './shortcut-logic';

describe('shortcutGroups', () => {
  const keymap = resolveKeymap('macos', { TOGGLE_FREEZE: ['K'] });

  it('lists every action by group, with the shortcuts as shown on this OS', () => {
    const groups = shortcutGroups(keymap, { TOGGLE_FREEZE: ['K'] }, '', 'macos');
    expect(groups.map((g) => g.name)).toEqual([
      'Datei',
      'Tabs',
      'Ansicht',
      'Navigation',
      'Auswahl',
      'Filter',
      'Suche',
      'Hilfe',
    ]);
    const open = groups[0].rows.find((r) => r.id === 'OPEN_PATH')!;
    expect(open.keys).toEqual([{ value: 'Mod+Shift+O', text: '⇧⌘O' }]);
    const freeze = groups.flatMap((g) => g.rows).find((r) => r.id === 'TOGGLE_FREEZE')!;
    expect(freeze.changed).toBe(true);
    expect(open.changed).toBe(false);
  });

  it('finds by name, id and shortcut, written or shown', () => {
    const ids = (q: string, platform: 'macos' | 'windows' = 'macos') =>
      shortcutGroups(keymap, {}, q, platform).flatMap((g) => g.rows.map((r) => r.id));
    expect(ids('freeze')).toEqual(['TOGGLE_FREEZE']);
    expect(ids('toggle_free')).toEqual(['TOGGLE_FREEZE']);
    expect(ids('⇧⌘O')).toEqual(['OPEN_PATH']);
    expect(ids('Strg+Umschalt+O', 'windows')).toEqual(['OPEN_PATH']);
    expect(ids('nichts dergleichen')).toEqual([]);
  });
});
