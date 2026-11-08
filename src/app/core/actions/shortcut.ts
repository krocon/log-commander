import { Platform } from './platform';

/**
 * Keyboard shortcuts in one canonical notation (prompt 021, taken from files-and-folders, design 002 D2):
 * `[Mod+][Ctrl+][Alt+][Shift+]<Key>`, a chord as two strokes with a space (`Mod+K T`).
 * `Mod` is ⌘ on macOS and Ctrl elsewhere; `Ctrl` is the real Control key on macOS and the same as `Mod`
 * elsewhere (normalised to `Mod`). Keymap strings and keyboard events go through the same functions, so they
 * always compare equal.
 *
 * Which key an event means (the reasons matter, do not shorten):
 * - Letters come from `key` (QWERTZ: the key labelled Z is `Z`), else from `code`: on macOS ⌥ changes `key`
 *   (⌥O gives `ø`), dead keys give `Dead`.
 * - Digits and the numpad come from `code`: German Shift+7 gives `/`, ⌥1 gives `¡`.
 * - Punctuation comes from `key`, so `?`, `<`, `>` and `,` are the characters the user sees on the keycap,
 *   whatever the layout (German `?` is Shift+ß, US `?` is Shift+/). Shift is part of making the character and
 *   is dropped for punctuation: `?` and `Shift+?` are the same shortcut. With ⌥ on macOS `key` is a different
 *   character again, then the physical key (`code`, US names) decides.
 */
export interface Stroke {
  readonly mod: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  /** Canonical key name, e.g. `S`, `5`, `F6`, `Enter`, `NumpadAdd`, `?`. */
  readonly key: string;
}

const NAMED_KEYS = [
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'ContextMenu',
  'NumpadAdd',
  'NumpadSubtract',
  'NumpadMultiply',
  'NumpadDivide',
  'NumpadDecimal',
  'Numpad0',
  'Numpad1',
  'Numpad2',
  'Numpad3',
  'Numpad4',
  'Numpad5',
  'Numpad6',
  'Numpad7',
  'Numpad8',
  'Numpad9',
];
const NAMED = new Map<string, string>(NAMED_KEYS.map((k) => [k.toLowerCase(), k]));
/** Aliases accepted when reading. */
const ALIASES: Readonly<Record<string, string>> = {
  esc: 'Escape',
  del: 'Delete',
  return: 'Enter',
  ins: 'Insert',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  pgup: 'PageUp',
  pgdn: 'PageDown',
  plus: '+',
  minus: '-',
};
/** Punctuation by physical key (US names), for ⌥ on macOS and dead keys. */
const CODE_PUNCTUATION: Readonly<Record<string, string>> = {
  Period: '.',
  Comma: ',',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  IntlBackslash: '<',
};
const MODIFIER_KEYS = new Set([
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'AltGraph',
  'CapsLock',
  'Fn',
  'OS',
]);

const LETTER = /^\p{L}$/u;

/** A single character that is neither a letter nor a digit: Shift does not count for it. */
export function isPunctuation(key: string): boolean {
  return [...key].length === 1 && !LETTER.test(key) && !/^[0-9]$/.test(key) && key !== ' ';
}

/** Canonical key name for a token from a keymap string, `null` if unknown. */
export function canonicalKey(token: string): string | null {
  if ([...token].length === 1) {
    if (token === ' ') return 'Space';
    return LETTER.test(token) ? token.toUpperCase() : token;
  }
  const lower = token.toLowerCase();
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower.toUpperCase();
  return NAMED.get(lower) ?? ALIASES[lower] ?? null;
}

/** Parses one stroke (`Mod+Shift+S`); `null` if it is not a valid shortcut. */
export function parseStroke(text: string, platform: Platform): Stroke | null {
  const raw = text.trim();
  if (!raw) return null;
  // A "+" key is written "Mod++".
  const parts = raw.endsWith('++') ? [...raw.slice(0, -2).split('+'), '+'] : raw.split('+');
  const keyToken = parts.pop();
  if (keyToken === undefined || keyToken === '') return null;
  let mod = false;
  let ctrl = false;
  let alt = false;
  let shift = false;
  for (const p of parts) {
    switch (p.trim().toLowerCase()) {
      case 'mod':
      case 'cmd':
      case 'meta':
        mod = true;
        break;
      case 'ctrl':
      case 'control':
        if (platform === 'macos') ctrl = true;
        else mod = true;
        break;
      case 'alt':
      case 'option':
        alt = true;
        break;
      case 'shift':
        shift = true;
        break;
      default:
        return null;
    }
  }
  const key = canonicalKey(keyToken);
  if (!key) return null;
  return { mod, ctrl, alt, shift: shift && !isPunctuation(key), key };
}

/** Parses a shortcut with an optional chord (`Mod+K T`); `null` if invalid. At most two strokes. */
export function parseShortcut(text: string, platform: Platform): Stroke[] | null {
  if (typeof text !== 'string' || text.length > 64) return null;
  const strokes = text
    .trim()
    .split(/\s+/)
    .map((s) => parseStroke(s, platform));
  if (strokes.length === 0 || strokes.length > 2 || strokes.some((s) => s === null)) return null;
  return strokes as Stroke[];
}

export function strokeToString(s: Stroke): string {
  return `${s.mod ? 'Mod+' : ''}${s.ctrl ? 'Ctrl+' : ''}${s.alt ? 'Alt+' : ''}${s.shift ? 'Shift+' : ''}${s.key}`;
}

/** Canonical form of a shortcut string, `null` if invalid. */
export function canonicalShortcut(text: string, platform: Platform): string | null {
  const strokes = parseShortcut(text, platform);
  return strokes ? strokes.map(strokeToString).join(' ') : null;
}

/** The fields of a KeyboardEvent a stroke depends on (testable without DOM). */
export type KeyEventLike = Pick<
  KeyboardEvent,
  'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
>;

/** Key name of an event (rules above), `null` for a lone modifier or an unknown key. */
export function eventKey(evt: Pick<KeyboardEvent, 'key' | 'code' | 'altKey'>): string | null {
  const key = evt.key ?? '';
  const code = evt.code ?? '';
  if (MODIFIER_KEYS.has(key)) return null;
  if (code.startsWith('Numpad')) {
    return code === 'NumpadEnter' ? 'Enter' : (NAMED.get(code.toLowerCase()) ?? null);
  }
  if (code.startsWith('Digit')) return code.slice(5);
  if (key.length === 1 && /[a-z]/i.test(key)) return key.toUpperCase();
  if (code.startsWith('Key') && code.length === 4) return code.slice(3);
  if (key === ' ') return 'Space';
  if ([...key].length === 1 && !(evt.altKey && CODE_PUNCTUATION[code])) {
    return LETTER.test(key) ? key.toUpperCase() : key;
  }
  if (CODE_PUNCTUATION[code]) return CODE_PUNCTUATION[code];
  if (key === 'Dead') return null;
  return canonicalKey(key);
}

export function strokeFromEvent(evt: KeyEventLike, platform: Platform): Stroke | null {
  const key = eventKey(evt);
  if (key === null) return null;
  const mac = platform === 'macos';
  return {
    mod: mac ? evt.metaKey : evt.ctrlKey || evt.metaKey,
    ctrl: mac ? evt.ctrlKey : false,
    alt: evt.altKey,
    shift: evt.shiftKey && !isPunctuation(key),
    key,
  };
}

/** With Mod, Ctrl or Alt: a command, not typing. */
export function hasCommandModifier(s: Stroke): boolean {
  return s.mod || s.ctrl || s.alt;
}

export function isFunctionKey(key: string): boolean {
  return /^F\d{1,2}$/.test(key);
}

/** A stroke that types something into a text field (a character or Space, with Shift at most). */
export function typesText(s: Stroke): boolean {
  return !hasCommandModifier(s) && (s.key === 'Space' || [...s.key].length === 1);
}

// ---- display ----

const MAC_KEYS: Readonly<Record<string, string>> = {
  Enter: '↩',
  Backspace: '⌫',
  Delete: '⌦',
  Escape: 'Esc',
  Tab: '⇥',
  Home: '↖',
  End: '↘',
  PageUp: '⇞',
  PageDown: '⇟',
  Space: 'Leertaste',
};
const KEYS: Readonly<Record<string, string>> = {
  Enter: 'Eingabe',
  Backspace: 'Rücktaste',
  Delete: 'Entf',
  Insert: 'Einfg',
  Escape: 'Esc',
  Tab: 'Tab',
  Home: 'Pos1',
  End: 'Ende',
  PageUp: 'Bild↑',
  PageDown: 'Bild↓',
  Space: 'Leertaste',
  ContextMenu: 'Menütaste',
};
const BOTH: Readonly<Record<string, string>> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  ContextMenu: 'Menütaste',
  NumpadAdd: 'Num+',
  NumpadSubtract: 'Num−',
  NumpadMultiply: 'Num*',
  NumpadDivide: 'Num/',
  NumpadDecimal: 'Num,',
};

function keyLabel(key: string, platform: Platform): string {
  const own = platform === 'macos' ? MAC_KEYS[key] : KEYS[key];
  if (own) return own;
  if (BOTH[key]) return BOTH[key];
  return key.startsWith('Numpad') ? `Num${key.slice(6)}` : key;
}

/** Display text: `⌃⌥⇧⌘S` on macOS (Apple order), `Strg+Alt+Umschalt+S` elsewhere. */
export function formatStroke(s: Stroke, platform: Platform): string {
  const key = keyLabel(s.key, platform);
  if (platform === 'macos') {
    return `${s.ctrl ? '⌃' : ''}${s.alt ? '⌥' : ''}${s.shift ? '⇧' : ''}${s.mod ? '⌘' : ''}${key}`;
  }
  return `${s.mod ? 'Strg+' : ''}${s.alt ? 'Alt+' : ''}${s.shift ? 'Umschalt+' : ''}${key}`;
}

export function formatShortcut(text: string, platform: Platform): string {
  const strokes = parseShortcut(text, platform);
  return strokes ? strokes.map((s) => formatStroke(s, platform)).join(' ') : text;
}
