import { SearchQuery } from '../../core/log/log.models';
import { TextSegment, buildSegments } from '../log-table/highlight';

/**
 * Formatting of an entry for the detail panel (prompt 004): an own tokenizer for JSON and XML that only
 * changes indentation and colour. No `JSON.parse` (it rounds 64-bit ids) and no `DOMParser` (it fails on
 * the fragments logs are full of). Everything here returns segments; the panel renders them as text nodes.
 */

/** Above this the panel shows the raw text: formatting must stay instant. */
export const MAX_FORMAT_CHARS = 256 * 1024;
/** Deeper nesting is not formatted (and the recursion stays small). */
const MAX_DEPTH = 256;
/** Places in the head line where a block may start (`payload={…}`). */
const MAX_HEAD_CANDIDATES = 8;
/** Search marks in the raw view, at most. */
const MAX_MATCHES = 10_000;
const INDENT = '  ';

export type DetailKind = 'json' | 'xml';

export interface Formatted {
  kind: DetailKind;
  segments: TextSegment[];
}

class Out {
  readonly segments: TextSegment[] = [];

  push(text: string, cls = ''): void {
    if (!text) return;
    const last = this.segments[this.segments.length - 1];
    if (last && last.cls === cls) last.text += text;
    else this.segments.push({ text, cls });
  }
}

/** The text with a JSON or XML block formatted, or null if there is none (then the panel shows it raw). */
export function formatDetail(text: string): Formatted | null {
  if (text.length > MAX_FORMAT_CHARS) return null;
  for (const start of blockStarts(text)) {
    const formatted = text[start] === '<' ? formatXml(text, start) : formatJson(text, start);
    if (formatted) return formatted;
  }
  return null;
}

/** Where a block may begin: the whole text, the rest after the head line, a few places in the head line. */
export function blockStarts(text: string): number[] {
  const starts: number[] = [];
  const add = (i: number) => {
    if (i < text.length && !starts.includes(i) && startsBlock(text, i)) starts.push(i);
  };
  add(skipSpace(text, 0));
  const newline = text.indexOf('\n');
  if (newline >= 0) add(skipSpace(text, newline + 1));
  const headEnd = newline < 0 ? text.length : newline;
  let found = 0;
  for (let i = 0; i < headEnd && found < MAX_HEAD_CANDIDATES; i++) {
    const c = text[i];
    if (c === '{' || c === '[' || c === '<') {
      found++;
      add(i);
    }
  }
  return starts;
}

function startsBlock(text: string, i: number): boolean {
  const c = text[i];
  if (c === '{' || c === '[') return true;
  return c === '<' && (text.startsWith('<?xml', i) || /[A-Za-z_]/.test(text[i + 1] ?? ''));
}

function skipSpace(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

// ---------------------------------------------------------------- JSON

/**
 * A JSON value from `start`; after it only spaces up to a line end. The text before stays as it is, the
 * text after it (further lines) follows raw. Numbers are copied character by character.
 */
function formatJson(text: string, start: number): Formatted | null {
  const out = new Out();
  out.push(text.slice(0, start));
  const parser = new JsonFormatter(text, start, out);
  if (!parser.value(0)) return null;
  let end = parser.pos;
  while (end < text.length && (text[end] === ' ' || text[end] === '\t' || text[end] === '\r')) {
    end++;
  }
  if (end < text.length && text[end] !== '\n') return null;
  out.push(text.slice(parser.pos));
  return { kind: 'json', segments: out.segments };
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const LITERAL = /true|false|null/y;

class JsonFormatter {
  pos: number;

  constructor(
    private readonly text: string,
    start: number,
    private readonly out: Out,
  ) {
    this.pos = start;
  }

  value(depth: number): boolean {
    if (depth > MAX_DEPTH) return false;
    this.space();
    const c = this.text[this.pos];
    if (c === '{') return this.container('{', '}', depth, true);
    if (c === '[') return this.container('[', ']', depth, false);
    if (c === '"') {
      const s = this.string();
      if (s === null) return false;
      this.out.push(s, 'f-string');
      return true;
    }
    for (const [pattern, cls] of [
      [NUMBER, 'f-number'],
      [LITERAL, 'f-literal'],
    ] as const) {
      pattern.lastIndex = this.pos;
      const match = pattern.exec(this.text);
      if (match) {
        this.pos += match[0].length;
        this.out.push(match[0], cls);
        return true;
      }
    }
    return false;
  }

  private container(open: string, close: string, depth: number, object: boolean): boolean {
    this.pos++;
    this.space();
    if (this.text[this.pos] === close) {
      this.pos++;
      this.out.push(open + close, 'f-punct');
      return true;
    }
    this.out.push(open, 'f-punct');
    const inner = '\n' + INDENT.repeat(depth + 1);
    for (;;) {
      this.out.push(inner);
      if (object) {
        this.space();
        if (this.text[this.pos] !== '"') return false;
        const key = this.string();
        if (key === null) return false;
        this.out.push(key, 'f-key');
        this.space();
        if (this.text[this.pos] !== ':') return false;
        this.pos++;
        this.out.push(':', 'f-punct');
        this.out.push(' ');
      }
      if (!this.value(depth + 1)) return false;
      this.space();
      const c = this.text[this.pos];
      if (c === ',') {
        this.pos++;
        this.out.push(',', 'f-punct');
      } else if (c === close) {
        this.pos++;
        this.out.push('\n' + INDENT.repeat(depth));
        this.out.push(close, 'f-punct');
        return true;
      } else {
        return false;
      }
    }
  }

  /** A string with its quotes and escapes as written, or null if it does not end on its line. */
  private string(): string | null {
    const start = this.pos;
    this.pos++;
    while (this.pos < this.text.length) {
      const c = this.text[this.pos];
      if (c === '\\') this.pos += 2;
      else if (c === '"') return this.text.slice(start, ++this.pos);
      else if (c === '\n') return null;
      else this.pos++;
    }
    return null;
  }

  private space(): void {
    while (this.pos < this.text.length && ' \t\n\r'.includes(this.text[this.pos])) this.pos++;
  }
}

// ---------------------------------------------------------------- XML

type XmlNode =
  | { type: 'open'; name: string; attrs: { name: string; value: string | null }[]; empty: boolean }
  | { type: 'close'; name: string }
  | { type: 'text'; text: string }
  | { type: 'special'; text: string; cls: string };

const NAME = /[A-Za-z_:][\w.:-]*/y;
const CLOSE_TAG = /<\/([A-Za-z_:][\w.:-]*)\s*>/y;
const UNQUOTED = /[^\s>"'=<`]+/y;

function sticky(pattern: RegExp, text: string, pos: number): string | null {
  pattern.lastIndex = pos;
  return pattern.exec(text)?.[0] ?? null;
}

/**
 * Tags, text, comments, CDATA and processing instructions from `start` to the end. Fragments and several
 * roots are fine; a `<` that starts no valid tag, or an unterminated tag, comment or CDATA, is not XML.
 */
export function tokenizeXml(text: string, start: number): XmlNode[] | null {
  const nodes: XmlNode[] = [];
  let pos = start;
  const special = (open: string, close: string, cls: string): boolean => {
    const end = text.indexOf(close, pos + open.length);
    if (end < 0) return false;
    nodes.push({ type: 'special', text: text.slice(pos, end + close.length), cls });
    pos = end + close.length;
    return true;
  };
  while (pos < text.length) {
    if (text[pos] !== '<') {
      const next = text.indexOf('<', pos);
      const end = next < 0 ? text.length : next;
      nodes.push({ type: 'text', text: text.slice(pos, end) });
      pos = end;
      continue;
    }
    let ok: boolean;
    if (text.startsWith('<!--', pos)) ok = special('<!--', '-->', 'f-comment');
    else if (text.startsWith('<![CDATA[', pos)) ok = special('<![CDATA[', ']]>', 'f-cdata');
    else if (text.startsWith('<?', pos)) ok = special('<?', '?>', 'f-meta');
    else if (text.startsWith('<!', pos)) ok = special('<!', '>', 'f-meta');
    else if (text.startsWith('</', pos)) {
      CLOSE_TAG.lastIndex = pos;
      const match = CLOSE_TAG.exec(text);
      ok = !!match;
      if (match) {
        nodes.push({ type: 'close', name: match[1] });
        pos += match[0].length;
      }
    } else {
      const tag = openTag(text, pos);
      ok = !!tag;
      if (tag) {
        nodes.push(tag.node);
        pos = tag.end;
      }
    }
    if (!ok) return null;
  }
  return nodes.some((n) => n.type === 'open') || nodes.some((n) => n.type === 'special')
    ? nodes
    : null;
}

function openTag(text: string, start: number): { node: XmlNode; end: number } | null {
  const name = sticky(NAME, text, start + 1);
  if (!name) return null;
  let pos = start + 1 + name.length;
  const attrs: { name: string; value: string | null }[] = [];
  for (;;) {
    pos = skipSpace(text, pos);
    if (text.startsWith('/>', pos)) {
      return { node: { type: 'open', name, attrs, empty: true }, end: pos + 2 };
    }
    if (text[pos] === '>')
      return { node: { type: 'open', name, attrs, empty: false }, end: pos + 1 };
    const attr = sticky(NAME, text, pos);
    if (!attr) return null;
    pos = skipSpace(text, pos + attr.length);
    let value: string | null = null;
    if (text[pos] === '=') {
      pos = skipSpace(text, pos + 1);
      const quote = text[pos];
      if (quote === '"' || quote === "'") {
        // A quoted value may hold `>`.
        const end = text.indexOf(quote, pos + 1);
        if (end < 0) return null;
        value = text.slice(pos, end + 1);
        pos = end + 1;
      } else {
        value = sticky(UNQUOTED, text, pos);
        if (!value) return null;
        pos += value.length;
      }
    }
    attrs.push({ name: attr, value });
  }
}

function formatXml(text: string, start: number): Formatted | null {
  const nodes = tokenizeXml(text, start);
  if (!nodes) return null;
  const out = new Out();
  const prefix = text.slice(0, start);
  out.push(prefix);
  let depth = 0;
  let first = !prefix || prefix.endsWith('\n');
  const line = () => {
    if (!first) out.push('\n');
    first = false;
    out.push(INDENT.repeat(depth));
  };
  const textOf = (node: XmlNode | undefined) => (node?.type === 'text' ? node.text.trim() : null);
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.type === 'open') {
      line();
      pushOpen(out, node);
      if (node.empty) continue;
      const inner = textOf(nodes[i + 1]);
      const after = nodes[i + (inner !== null ? 2 : 1)];
      // `<a>text</a>` and `<a></a>` stay on one line.
      if (after?.type === 'close' && (inner === null || !inner.includes('\n'))) {
        if (inner) out.push(inner);
        pushClose(out, after.name);
        i += inner !== null ? 2 : 1;
        continue;
      }
      depth++;
    } else if (node.type === 'close') {
      depth = Math.max(0, depth - 1);
      line();
      pushClose(out, node.name);
    } else if (node.type === 'text') {
      const trimmed = node.text.trim();
      if (!trimmed) continue;
      line();
      out.push(trimmed);
    } else {
      line();
      out.push(node.text, node.cls);
    }
  }
  return { kind: 'xml', segments: out.segments };
}

function pushOpen(out: Out, node: Extract<XmlNode, { type: 'open' }>): void {
  out.push('<' + node.name, 'f-tag');
  for (const attr of node.attrs) {
    out.push(' ');
    out.push(attr.name, 'f-attr');
    if (attr.value !== null) {
      out.push('=', 'f-punct');
      out.push(attr.value, 'f-string');
    }
  }
  out.push(node.empty ? '/>' : '>', 'f-tag');
}

function pushClose(out: Out, name: string): void {
  out.push(`</${name}>`, 'f-tag');
}

// ---------------------------------------------------------------- raw view

/**
 * Matches of the current search in the text, `[start, end)` in UTF-16 units. A regex the backend accepts
 * but JavaScript does not (other syntax) just marks nothing.
 */
export function findMatches(text: string, query: SearchQuery): [number, number][] {
  if (!query.text) return [];
  let pattern: RegExp;
  try {
    const source = query.isRegex ? query.text : query.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pattern = new RegExp(source, query.caseSensitive ? 'g' : 'gi');
  } catch {
    return [];
  }
  const matches: [number, number][] = [];
  for (const match of text.matchAll(pattern)) {
    if (match[0].length === 0) continue;
    matches.push([match.index, match.index + match[0].length]);
    if (matches.length >= MAX_MATCHES) break;
  }
  return matches;
}

/** The raw text with the inline tokens of the log view and the search marks. */
export function rawSegments(text: string, query: SearchQuery): TextSegment[] {
  return buildSegments(text, findMatches(text, query));
}
