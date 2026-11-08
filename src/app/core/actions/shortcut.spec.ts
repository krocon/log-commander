import { describe, expect, it } from 'vitest';
import {
  KeyEventLike,
  canonicalShortcut,
  eventKey,
  formatShortcut,
  parseShortcut,
  strokeFromEvent,
  strokeToString,
  typesText,
} from './shortcut';

const ev = (key: string, code: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key,
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});
const fromEvent = (e: KeyEventLike, platform: 'macos' | 'windows' | 'linux' = 'macos') =>
  strokeToString(strokeFromEvent(e, platform)!);

describe('shortcut notation', () => {
  it('canonicalises modifier order, case and aliases', () => {
    expect(canonicalShortcut('shift+mod+s', 'linux')).toBe('Mod+Shift+S');
    expect(canonicalShortcut('alt+cmd+left', 'macos')).toBe('Mod+Alt+ArrowLeft');
    expect(canonicalShortcut('ctrl+del', 'windows')).toBe('Mod+Delete');
    expect(canonicalShortcut('esc', 'linux')).toBe('Escape');
    expect(canonicalShortcut('f12', 'linux')).toBe('F12');
    expect(canonicalShortcut('Mod++', 'linux')).toBe('Mod++');
    expect(canonicalShortcut('space', 'linux')).toBe('Space');
  });

  it('keeps Ctrl apart from ⌘ on macOS only', () => {
    expect(canonicalShortcut('Ctrl+Tab', 'macos')).toBe('Ctrl+Tab');
    expect(canonicalShortcut('Ctrl+Tab', 'windows')).toBe('Mod+Tab');
  });

  it('drops Shift for punctuation: the character already says it', () => {
    expect(canonicalShortcut('Shift+?', 'macos')).toBe('?');
    expect(canonicalShortcut('>', 'linux')).toBe('>');
    expect(canonicalShortcut('Shift+E', 'linux')).toBe('Shift+E');
  });

  it('parses chords and refuses invalid input', () => {
    expect(parseShortcut('Mod+K T', 'macos')?.map(strokeToString)).toEqual(['Mod+K', 'T']);
    for (const bad of ['', 'Hyper+A', 'Mod+', 'F99', 'A B C', 'Mod+Banana', 'x'.repeat(65)]) {
      expect(canonicalShortcut(bad, 'linux'), bad).toBeNull();
    }
    expect(parseShortcut(42 as unknown as string, 'linux')).toBeNull();
  });

  it('reads letters from key, from code when ⌥ changes the character (macOS)', () => {
    expect(eventKey(ev('s', 'KeyS'))).toBe('S');
    expect(eventKey(ev('ø', 'KeyO', { altKey: true }))).toBe('O');
    expect(eventKey(ev('Dead', 'KeyE', { altKey: true }))).toBe('E');
    // QWERTZ: the key labelled Z sits where QWERTY has Y; the label wins.
    expect(eventKey(ev('z', 'KeyY'))).toBe('Z');
    expect(eventKey(ev('ä', 'Quote'))).toBe('Ä');
  });

  it('reads digits and the numpad from code', () => {
    expect(eventKey(ev('/', 'Digit7', { shiftKey: true }))).toBe('7'); // German Shift+7
    expect(eventKey(ev('¡', 'Digit1', { altKey: true }))).toBe('1');
    expect(eventKey(ev('+', 'NumpadAdd'))).toBe('NumpadAdd');
    expect(eventKey(ev('Enter', 'NumpadEnter'))).toBe('Enter');
  });

  it('reads punctuation from key on every layout, from code under ⌥', () => {
    // `?`: US Shift+/, German Shift+ß; `>`: US Shift+., German Shift+<
    expect(fromEvent(ev('?', 'Slash', { shiftKey: true }))).toBe('?');
    expect(fromEvent(ev('?', 'Minus', { shiftKey: true }))).toBe('?');
    expect(fromEvent(ev('>', 'Period', { shiftKey: true }))).toBe('>');
    expect(fromEvent(ev('>', 'IntlBackslash', { shiftKey: true }))).toBe('>');
    expect(fromEvent(ev('<', 'IntlBackslash'))).toBe('<');
    // `Mod+,` on QWERTZ and QWERTY alike
    expect(fromEvent(ev(',', 'Comma', { metaKey: true }))).toBe('Mod+,');
    expect(fromEvent(ev('≤', 'Comma', { altKey: true }))).toBe('Alt+,');
    // synthetic events without code (the e2e scenario)
    expect(fromEvent(ev('>', ''))).toBe('>');
  });

  it('names special keys and ignores lone modifiers', () => {
    expect(eventKey(ev(' ', 'Space'))).toBe('Space');
    expect(eventKey(ev('F10', 'F10'))).toBe('F10');
    expect(eventKey(ev('Backspace', 'Backspace'))).toBe('Backspace');
    expect(eventKey(ev('Shift', 'ShiftLeft'))).toBeNull();
    expect(eventKey(ev('Meta', 'MetaLeft'))).toBeNull();
    expect(eventKey(ev('Dead', ''))).toBeNull();
  });

  it('builds the same string from an event as from the keymap', () => {
    const mac = fromEvent(ev('p', 'KeyP', { metaKey: true, shiftKey: true }), 'macos');
    expect(mac).toBe(canonicalShortcut('Mod+Shift+P', 'macos'));
    expect(fromEvent(ev('Tab', 'Tab', { ctrlKey: true }), 'windows')).toBe(
      canonicalShortcut('Ctrl+Tab', 'windows'),
    );
    expect(fromEvent(ev('Tab', 'Tab', { ctrlKey: true }), 'macos')).toBe('Ctrl+Tab');
    // Meta counts as Mod off macOS too (Linux Super), so the scenario's metaKey works everywhere.
    expect(fromEvent(ev('b', 'KeyB', { metaKey: true }), 'linux')).toBe('Mod+B');
    expect(fromEvent(ev('†', 'KeyT', { metaKey: true, altKey: true }), 'macos')).toBe('Mod+Alt+T');
  });

  it('tells typing keys from command keys', () => {
    const s = (t: string) => parseShortcut(t, 'linux')![0];
    expect(typesText(s('K'))).toBe(true);
    expect(typesText(s('Shift+K'))).toBe(true);
    expect(typesText(s('Space'))).toBe(true);
    expect(typesText(s('Enter'))).toBe(false);
    expect(typesText(s('Mod+K'))).toBe(false);
  });

  it('shows shortcuts per platform', () => {
    expect(formatShortcut('Mod+Shift+O', 'macos')).toBe('⇧⌘O');
    expect(formatShortcut('Mod+Ctrl+Alt+G', 'macos')).toBe('⌃⌥⌘G');
    expect(formatShortcut('Mod+Shift+O', 'windows')).toBe('Strg+Umschalt+O');
    expect(formatShortcut('Mod+Alt+T', 'linux')).toBe('Strg+Alt+T');
    expect(formatShortcut('Home', 'windows')).toBe('Pos1');
    expect(formatShortcut('Space', 'macos')).toBe('Leertaste');
    expect(formatShortcut('Mod+K T', 'macos')).toBe('⌘K T');
    expect(formatShortcut('NumpadAdd', 'linux')).toBe('Num+');
    expect(formatShortcut('nonsense+', 'linux')).toBe('nonsense+');
  });
});
