import { describe, expect, it } from 'vitest';
import { ACTIONS, ACTION_IDS, actionDef, isActionId } from './action-catalog';
import {
  DEFAULT_KEYMAPS,
  assignShortcut,
  checkCandidate,
  pruneOverride,
  reservedReason,
  resolveKeymap,
} from './keymap';
import { Platform } from './platform';
import { canonicalShortcut } from './shortcut';

const PLATFORMS: Platform[] = ['macos', 'windows', 'linux'];

describe('default keymaps', () => {
  for (const platform of PLATFORMS) {
    it(`${platform}: known ids, valid, nothing reserved, nothing twice`, () => {
      const raw = DEFAULT_KEYMAPS[platform];
      for (const [id, list] of Object.entries(raw)) {
        expect(isActionId(id), id).toBe(true);
        for (const s of list as string[]) {
          const c = canonicalShortcut(s, platform);
          expect(c, `${id} ${s}`).toBe(s); // written canonically
          expect(
            reservedReason(c!, actionDef(id as never).scope, platform),
            `${id} ${s}`,
          ).toBeNull();
        }
      }
      expect(resolveKeymap(platform).problems).toEqual([]);
    });
  }

  it('macOS switches tabs with the real Control key (⌘Tab is the system’s)', () => {
    expect(resolveKeymap('macos').bindings.NEXT_TAB).toEqual(['Ctrl+Tab']);
    expect(resolveKeymap('windows').bindings.NEXT_TAB).toEqual(['Mod+Tab']);
  });

  it('every action of the catalogue is listed once with a label', () => {
    expect(new Set(ACTION_IDS).size).toBe(ACTION_IDS.length);
    for (const a of ACTIONS) {
      expect(a.id).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(a.label.length).toBeGreaterThan(2);
    }
  });

  it('the same key in the log and in the search field is no conflict (Esc)', () => {
    const keymap = resolveKeymap('linux');
    expect(keymap.lookup.get('Escape')).toEqual(['CLEAR_SELECTION', 'CLEAR_SEARCH']);
  });
});

describe('resolveKeymap', () => {
  it('an override replaces the list of its action; [] means none', () => {
    const keymap = resolveKeymap('linux', { TOGGLE_FREEZE: ['K'], FOLLOW_END: [] });
    expect(keymap.bindings.TOGGLE_FREEZE).toEqual(['K']);
    expect(keymap.bindings.FOLLOW_END).toEqual([]);
    expect(keymap.lookup.get('K')).toEqual(['TOGGLE_FREEZE']);
    expect(keymap.lookup.has('P')).toBe(false);
    expect(keymap.lookup.has('F')).toBe(false);
    expect(keymap.problems).toEqual([]);
  });

  it('reports unknown ids, invalid, reserved and broken entries, and skips them', () => {
    const keymap = resolveKeymap('macos', {
      NO_SUCH_ACTION: ['K'],
      TOGGLE_FREEZE: ['Hyper+K', 'K', 42],
      OPEN_FILE: ['Mod+Q'],
      CLOSE_TAB: 'Mod+W',
      FOCUS_SEARCH: ['Mod+V'],
    });
    expect(keymap.bindings.TOGGLE_FREEZE).toEqual(['K']);
    expect(keymap.bindings.OPEN_FILE).toEqual([]);
    expect(keymap.bindings.CLOSE_TAB).toEqual([]);
    expect(keymap.bindings.FOCUS_SEARCH).toEqual([]);
    const text = keymap.problems.join('\n');
    expect(text).toContain('Unbekannte Aktion „NO_SUCH_ACTION“');
    expect(text).toContain('„Hyper+K“ ist kein gültiges Kürzel');
    expect(text).toContain('„42“ ist kein gültiges Kürzel');
    expect(text).toContain('⌘Q für „Datei öffnen“ ist reserviert');
    expect(text).toContain('keine Liste');
    expect(text).toContain('Bearbeiten in Eingabefeldern');
  });

  it('on a conflict the override wins, the other action loses the key with a notice', () => {
    const keymap = resolveKeymap('linux', { TOGGLE_COLUMNS: ['P'] });
    expect(keymap.bindings.TOGGLE_COLUMNS).toEqual(['P']);
    expect(keymap.bindings.TOGGLE_FREEZE).toEqual([]);
    expect(keymap.problems).toEqual([
      'P gehört „Spalten oder Rohzeilen“, „Einfrieren (Freeze) an/aus“ verliert es.',
    ]);
  });

  it('a single stroke that starts a chord is reported', () => {
    const keymap = resolveKeymap('linux', {
      OPEN_SHORTCUTS: ['Mod+K T'],
      OPEN_SETTINGS: ['Mod+K'],
    });
    expect(keymap.problems.join()).toContain('verdeckt den Akkord');
  });

  it('a printable key cannot act in the search field', () => {
    expect(reservedReason('K', 'field', 'linux')).toContain('Tippen');
    expect(reservedReason('Enter', 'field', 'linux')).toBeNull();
    expect(reservedReason('Mod+C', 'view', 'linux')).toBeNull();
    expect(reservedReason('Mod+C', 'global', 'linux')).toContain('Eingabefeldern');
    expect(reservedReason('Alt+F4', 'global', 'windows')).toBeTruthy();
    expect(reservedReason('Mod+W', 'global', 'macos')).toBeNull();
  });
});

describe('recording in the editor', () => {
  const keymap = resolveKeymap('linux');

  it('says what a recorded shortcut would do', () => {
    expect(checkCandidate('TOGGLE_FREEZE', 'K', keymap, 'linux')).toEqual({
      kind: 'ok',
      shortcut: 'K',
    });
    expect(checkCandidate('TOGGLE_FREEZE', 'P', keymap, 'linux').kind).toBe('same');
    expect(checkCandidate('TOGGLE_FREEZE', 'T', keymap, 'linux')).toEqual({
      kind: 'conflict',
      shortcut: 'T',
      owner: 'TOGGLE_COLUMNS',
    });
    expect(checkCandidate('OPEN_FILE', 'Alt+F4', keymap, 'linux').kind).toBe('reserved');
    // Esc of the search field is not taken by Esc of the log
    expect(checkCandidate('CLEAR_SEARCH', 'Escape', keymap, 'linux').kind).toBe('same');
  });

  it('replaces or adds, takes the key from the loser, keeps only differences', () => {
    const replaced = assignShortcut({}, keymap, 'TOGGLE_FREEZE', 'K', 'linux', null);
    expect(replaced).toEqual({ TOGGLE_FREEZE: ['K'] });
    const added = assignShortcut({}, keymap, 'TOGGLE_FREEZE', 'K', 'linux', null, 'add');
    expect(added).toEqual({ TOGGLE_FREEZE: ['P', 'K'] });
    const taken = assignShortcut({}, keymap, 'TOGGLE_FREEZE', 'T', 'linux', 'TOGGLE_COLUMNS');
    expect(taken).toEqual({ TOGGLE_FREEZE: ['T'], TOGGLE_COLUMNS: [] });
    // back to the default: the entry goes
    expect(
      assignShortcut({ TOGGLE_FREEZE: ['K'] }, keymap, 'TOGGLE_FREEZE', 'P', 'linux', null),
    ).toEqual({});
    expect(pruneOverride({ FOLLOW_END: ['F', 'End'], NOPE: ['X'] }, 'linux')).toEqual({});
  });
});
