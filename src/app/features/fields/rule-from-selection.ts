import { ValueKind } from '../../core/log/log.models';

/** A rule as built from marked text: the regex with one group, a name from the word in front, the kind. */
export interface SelectionRule {
  pattern: string;
  name: string;
  kind: ValueKind;
  unit: string | null;
}

/** Characters `regex::escape` escapes in Rust; the same set keeps the pattern valid there and here. */
const META = /[\\.+*?()|[\]{}^$#&\-~]/g;

export function escapeRegex(text: string): string {
  return text.replace(META, '\\$&');
}

const NUMBER = '[-+]?\\d+(?:[.,]\\d+)*';
const DURATION_UNITS = ['ns', 'us', 'µs', 'μs', 'ms', 'min', 'sec', 's', 'm', 'h', 'd'];
const SIZE_UNIT = /^(?:[kmgt]i?b|b|bytes?)$/i;
/** Units in the group: any unit of the kind, so `340ms` and `1.2s` are both found. */
const UNIT_GROUP: Partial<Record<ValueKind, string>> = {
  percent: '\\s?%',
  duration: '\\s?(?:ns|us|µs|μs|ms|min|sec|s|m|h|d)\\b',
  size: '\\s?(?:[kKmMgGtT]i?[bB]|[bB]|[kKmMgGtT])\\b',
};
/** At most this much of the text in front is taken over as context. */
const MAX_CONTEXT = 30;

function unitKind(unit: string): ValueKind | null {
  if (unit === '%') return 'percent';
  if (DURATION_UNITS.includes(unit)) return 'duration';
  if (SIZE_UNIT.test(unit)) return 'size';
  return null;
}

const isSpace = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);
const isWord = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}_]/u.test(c);

/** The text in front as a regex: digits generalised, whitespace as `\s+`, a word start as `\b`. */
function prefixOf(text: string, start: number): { pattern: string; word: string } {
  if (start === 0) return { pattern: '^', word: '' };
  let i = start;
  while (i > 0 && isSpace(text[i - 1])) i--;
  const spaces = start - i;
  const end = i;
  while (i > 0 && !isSpace(text[i - 1]) && end - i < MAX_CONTEXT) i--;
  const word = text.slice(i, end);
  let pattern = escapeRegex(word).replace(/\d+/g, '\\d+');
  if (word && isWord(word[0])) {
    // A whole word: from the start of the line or of a word; a cut one has no boundary.
    if (i === 0) pattern = `^${pattern}`;
    else if (!isWord(text[i - 1])) pattern = `\\b${pattern}`;
  } else if (!word && i === 0) {
    pattern = '^';
  }
  if (spaces > 0) pattern += '\\s+';
  return { pattern, word };
}

/** A name from the word in front (`cpu=` → `cpu`), else from the value's kind. */
function nameOf(word: string, kind: ValueKind): string {
  const words = word.match(/[\p{L}_][\p{L}\p{N}_]*/gu);
  const name = words?.[words.length - 1];
  if (name) return name.slice(0, 40);
  return kind === 'text' ? 'feld' : 'wert';
}

/**
 * A rule from text marked in a line (prompt 011): the marked part becomes the group, the text right in front
 * (the key, `cpu=`, or the word before, `took `) and right behind (a unit, a closing quote) the context. A
 * number gets a number pattern, so other values match as well; a unit inside or right after it decides the
 * kind. `start`/`end` are UTF-16 offsets into `text`; null if nothing but whitespace is marked.
 */
export function ruleFromSelection(text: string, start: number, end: number): SelectionRule | null {
  start = Math.max(0, Math.min(start, text.length));
  end = Math.max(start, Math.min(end, text.length));
  while (start < end && isSpace(text[start])) start++;
  while (end > start && isSpace(text[end - 1])) end--;
  if (start === end) return null;
  const marked = text.slice(start, end);
  const after = text.slice(end);
  let group: string;
  let suffix = '';
  let kind: ValueKind = 'text';
  let unit: string | null = null;
  const number = /^[-+]?\d+(?:[.,]\d+)*(?:\s?(%|[\p{L}µ]{1,7}))?$/u.exec(marked);
  const unitKindOf = number?.[1] ? unitKind(number[1]) : null;
  if (number && (!number[1] || unitKindOf)) {
    if (number[1] && unitKindOf) {
      // The unit is marked too: any unit of its kind belongs to the value.
      kind = unitKindOf;
      group = `(${NUMBER}${UNIT_GROUP[kind] ?? ''})`;
    } else {
      // A unit right behind the number is context, and the unit of values without one.
      const behind = /^\s?(%|[\p{L}µ]{1,7})(?![\p{L}\p{N}_])/u.exec(after);
      const kindBehind = behind ? unitKind(behind[1]) : null;
      group = `(${NUMBER})`;
      if (behind && kindBehind) {
        kind = kindBehind;
        unit = behind[1];
        suffix = escapeRegex(behind[0]).replace(/^\s/, '\\s?');
      } else {
        kind = 'number';
        suffix = isWord(after[0]) ? '' : '\\b';
      }
    }
  } else {
    // Text: up to the character behind it, or to the next whitespace.
    const next = after[0];
    if (next === undefined) {
      group = '(.+)';
    } else if (/\s/.test(marked)) {
      group = '(.+?)';
      suffix = escapeRegex(next).replace(/^\s$/, '\\s');
    } else if (isSpace(next) || isWord(next)) {
      group = '(\\S+)';
    } else {
      group = `([^\\s${escapeRegex(next)}]+)`;
    }
  }
  if (end === text.length && !suffix.endsWith('$')) suffix = suffix === '\\b' ? '$' : `${suffix}$`;
  const prefix = prefixOf(text, start);
  return {
    pattern: `${prefix.pattern}${group}${suffix}`,
    name: nameOf(prefix.word, kind),
    kind,
    unit,
  };
}

/** Where marked text lies in a line: the first place inside `within` (a cell), else anywhere; null if not there. */
export function locateSelection(
  text: string,
  marked: string,
  within: readonly [number, number] | null = null,
): [number, number] | null {
  const trimmed = marked.split(/\r?\n/).find((l) => l.trim()) ?? '';
  if (!trimmed.trim()) return null;
  if (within) {
    const at = text.slice(within[0], within[1]).indexOf(trimmed);
    if (at >= 0) return [within[0] + at, within[0] + at + trimmed.length];
  }
  const at = text.indexOf(trimmed);
  return at >= 0 ? [at, at + trimmed.length] : null;
}
