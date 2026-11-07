import { LogLine } from '../../core/log/log.models';
import { sliceSegments } from './columns-logic';

export interface TextSegment {
  text: string;
  cls: string;
}

/** Beyond this nothing is tokenised: such lines only need to stay fast. */
const MAX_TOKENIZED = 4000;

const TOKEN =
  /(?<time>\b\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b)|(?<url>\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+)|(?<id>\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b)|(?<level>\b(?:TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|ERR|FATAL|CRITICAL|CRIT|SEVERE)\b)|(?<string>"(?:[^"\\]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(?<number>\b\d+(?:\.\d+)?\b)/gi;

type TokenName = 'time' | 'url' | 'id' | 'level' | 'string' | 'number';
const TOKEN_NAMES: readonly TokenName[] = ['time', 'url', 'id', 'level', 'string', 'number'];

interface Span {
  start: number;
  end: number;
  cls: string;
}

export function tokenize(text: string): Span[] {
  const spans: Span[] = [];
  const scanned = text.length > MAX_TOKENIZED ? text.slice(0, MAX_TOKENIZED) : text;
  let levelSeen = false;
  for (const match of scanned.matchAll(TOKEN)) {
    const groups = match.groups as Record<TokenName, string | undefined>;
    const name = TOKEN_NAMES.find((n) => groups[n] !== undefined);
    if (!name) continue;
    // Only the first level word is the line's level; later ones are message text.
    if (name === 'level') {
      if (levelSeen) continue;
      levelSeen = true;
    }
    spans.push({ start: match.index, end: match.index + match[0].length, cls: `t-${name}` });
  }
  return spans;
}

/** Splits a line into styled segments; search matches lie on top of the tokens. */
export function buildSegments(
  text: string,
  matches: readonly (readonly [number, number])[],
): TextSegment[] {
  const tokens = tokenize(text);
  const cuts = new Set([0, text.length]);
  for (const t of tokens) cuts.add(t.start).add(t.end);
  for (const [start, end] of matches) cuts.add(start).add(end);
  const points = [...cuts].sort((a, b) => a - b);
  const segments: TextSegment[] = [];
  let tokenIndex = 0;
  let matchIndex = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const start = points[i];
    const end = points[i + 1];
    while (tokenIndex < tokens.length && tokens[tokenIndex].end <= start) tokenIndex++;
    while (matchIndex < matches.length && matches[matchIndex][1] <= start) matchIndex++;
    const token = tokens[tokenIndex];
    const inToken = token && token.start <= start ? token.cls : '';
    const match = matches[matchIndex];
    const inMatch = match && match[0] <= start ? 'hit' : '';
    segments.push({ text: text.slice(start, end), cls: `${inToken} ${inMatch}`.trim() });
  }
  return segments;
}

const cache = new WeakMap<LogLine, TextSegment[]>();

/** Computed once per loaded line, and only for lines that actually get rendered. */
export function lineSegments(line: LogLine): TextSegment[] {
  let segments = cache.get(line);
  if (!segments) {
    segments = buildSegments(line.text, line.matches);
    cache.set(line, segments);
  }
  return segments;
}

const cellCache = new WeakMap<LogLine, (TextSegment[] | undefined)[]>();

/**
 * The segments of one field of a line (column view): the segments of the whole line cut at the span, so tokens
 * and matches look the same in every column. Cached per line and field. Without spans (`fields` empty) the
 * whole line is the field `fallback`.
 */
export function cellSegments(line: LogLine, field: number, fallback = -1): TextSegment[] {
  let perField = cellCache.get(line);
  if (!perField) {
    perField = [];
    cellCache.set(line, perField);
  }
  let segments = perField[field];
  if (!segments) {
    const span = line.fields?.[field];
    const [start, end] = span ?? (field === fallback ? [0, line.text.length] : [0, 0]);
    segments = sliceSegments(lineSegments(line), start, Math.min(end, line.text.length));
    perField[field] = segments;
  }
  return segments;
}
