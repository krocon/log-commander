import { LEVELS, Level, SearchMode, SearchQuery } from '../../core/log/log.models';
import {
  FilterGroupNode,
  FilterNode,
  countConditions,
  sanitizeTree,
} from '../sessions/filter-tree';
import { MCP_LIMITS } from './mcp-limits';

/**
 * Pure helpers of the MCP tools (prompt 022): reading and checking arguments, cutting and masking log text, the
 * filter tree between the AI's form (1-based lines) and the app's, times. The service only orchestrates.
 */

/** An error a tool answers with; `code` goes to the AI (help topic errors). */
export class McpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function fail(code: string, message: string): never {
  throw new McpError(code, message);
}

export type Args = Record<string, unknown>;

export function asArgs(value: unknown): Args {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Args)
    : {};
}

export function optInt(
  args: Args,
  name: string,
  range: { min: number; max: number; def?: number },
): number | undefined {
  const v = args[name];
  if (v === undefined || v === null) return range.def;
  if (typeof v !== 'number' || !Number.isInteger(v))
    fail('invalid_args', `${name} must be an integer`);
  if (v < range.min || v > range.max) {
    fail('invalid_args', `${name} must be between ${range.min} and ${range.max}`);
  }
  return v;
}

export function int(
  args: Args,
  name: string,
  range: { min: number; max: number; def: number },
): number {
  return optInt(args, name, range) as number;
}

export function reqInt(args: Args, name: string, range: { min: number; max: number }): number {
  const v = optInt(args, name, range);
  if (v === undefined) fail('invalid_args', `${name} is required`);
  return v;
}

export function bool(args: Args, name: string, def = false): boolean {
  const v = args[name];
  if (v === undefined || v === null) return def;
  if (typeof v !== 'boolean') fail('invalid_args', `${name} must be true or false`);
  return v;
}

export function optStr(args: Args, name: string, max: number): string | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') fail('invalid_args', `${name} must be a string`);
  if (v.length > max) fail('invalid_args', `${name} is longer than ${max} characters`);
  return v;
}

export function str(args: Args, name: string, max: number): string {
  const v = optStr(args, name, max);
  if (v === undefined || v === '') fail('invalid_args', `${name} is required`);
  return v;
}

export function oneOf<T extends string>(
  args: Args,
  name: string,
  values: readonly T[],
  def?: T,
): T {
  const v = args[name];
  if ((v === undefined || v === null) && def !== undefined) return def;
  if (typeof v !== 'string' || !values.includes(v as T)) {
    fail('invalid_args', `${name} must be one of ${values.join(', ')}`);
  }
  return v as T;
}

export function levelsArg(args: Args, name: string): Level[] | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((l) => !LEVELS.includes(l as Level))) {
    fail('invalid_args', `${name} must be a list of ${LEVELS.join(', ')}`);
  }
  return [...new Set(v as Level[])];
}

/** `search` of set_filter / open_filter_tab. */
export function searchArg(args: Args): { query: SearchQuery; mode: SearchMode } | undefined {
  const v = args['search'];
  if (v === undefined || v === null) return undefined;
  const s = asArgs(v);
  return {
    query: {
      text: optStr(s, 'text', MCP_LIMITS.patternCharsMax) ?? '',
      isRegex: bool(s, 'regex'),
      caseSensitive: bool(s, 'case_sensitive'),
    },
    mode: oneOf(s, 'mode', ['filter', 'highlight'] as const, 'filter'),
  };
}

// ---------------------------------------------------------------- text

export const MASK = '«masked»';

/** Key names that hold secrets (also column ids: a field `password` is masked as a whole). */
const SECRET_KEY = String.raw`(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)`;

/**
 * Known secrets (design E2, review 022 #1): headers, bearer/basic tokens, JWTs, passwords in URLs, PEM private keys
 * and `key=value` / `"key": "value"` whose key contains a secret word (`db_password=`, `accessToken:` …). The key
 * stays, so the AI still sees there was one. A key starts after a non-alphanumeric character, not at `\b`, so
 * `db_password` and `aws_secret_access_key` count. Bounded quantifiers only (no ReDoS).
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,16384}?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/g,
  /((?:^|[^A-Za-z0-9-])(?:proxy-)?authorization:\s*)[^\r\n]{1,1024}/gi,
  /((?:^|[^A-Za-z0-9-])(?:set-)?cookie:\s*)[^\r\n]{1,4096}/gi,
  /(\b(?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]{8,4096}/gi,
  /\beyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}/g,
  /([a-z][a-z0-9+.-]{0,20}:\/\/[^\s:/@]{1,256}:)[^\s@/]{1,256}(?=@)/gi,
  new RegExp(
    String.raw`((?:^|[^A-Za-z0-9])[A-Za-z0-9_.-]{0,40}${SECRET_KEY}[A-Za-z0-9_.-]{0,40}["']?\s*[=:]\s*)("[^"\r\n]{0,1024}"|'[^'\r\n]{0,1024}'|[^\s"'&,;}]{1,1024})`,
    'gi',
  ),
];

const SECRET_COLUMN = new RegExp(`${SECRET_KEY}|authorization|cookie`, 'i');

/** A column whose values are secrets as a whole (`password`, `api_key`, `Authorization` …). */
export function isSecretColumn(id: string): boolean {
  return SECRET_COLUMN.test(id);
}

/** Replaces known secrets; returns the text and how many were replaced. */
export function maskSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (...m: unknown[]) => {
      count++;
      const keep = m[1];
      return typeof keep === 'string' ? keep + MASK : MASK;
    });
  }
  return { text: out, count };
}

/** A cell of an SQL result or a field value for the AI. */
export function maskValue<T>(column: string, value: T, mask: boolean): T | string {
  if (!mask || value === null || value === undefined) return value;
  if (isSecretColumn(column)) return MASK;
  return typeof value === 'string' ? maskSecrets(value).text : value;
}

/** Log text for the AI: masked if wanted, cut at `max` characters. */
export interface TextOut {
  text: string;
  truncatedChars: number;
  masked: number;
}

export function textOut(text: string, max: number, mask: boolean): TextOut {
  const masked = mask ? maskSecrets(text) : { text, count: 0 };
  const cut = masked.text.length > max ? masked.text.slice(0, max) : masked.text;
  return { text: cut, truncatedChars: masked.text.length - cut.length, masked: masked.count };
}

// ---------------------------------------------------------------- filter tree

function mapLines(node: unknown, delta: number): unknown {
  if (typeof node !== 'object' || node === null) return node;
  const n = node as Record<string, unknown>;
  if (n['kind'] === 'group' && Array.isArray(n['children'])) {
    return { ...n, children: (n['children'] as unknown[]).map((c) => mapLines(c, delta)) };
  }
  const cond = n['cond'] as Record<string, unknown> | undefined;
  if (n['kind'] === 'cond' && cond?.['type'] === 'lines') {
    const shift = (v: unknown) => (typeof v === 'number' ? Math.max(0, v + delta) : v);
    return { ...n, cond: { ...cond, first: shift(cond['first']), last: shift(cond['last']) } };
  }
  return n;
}

function countRawConditions(node: unknown, depth = 0): number {
  if (typeof node !== 'object' || node === null || depth > 64) return 0;
  const n = node as Record<string, unknown>;
  if (n['kind'] === 'cond') return 1;
  if (Array.isArray(n['children'])) {
    return (n['children'] as unknown[]).reduce<number>(
      (s, c) => s + countRawConditions(c, depth + 1),
      0,
    );
  }
  return 0;
}

/**
 * The AI's tree as the sidebar's (design A7): 1-based line conditions to 0-based, checked with `sanitizeTree`.
 * A condition the check drops (unknown type, missing field, too deep, too many) fails instead of vanishing.
 */
export function treeFromAi(value: unknown): FilterGroupNode {
  const raw = asArgs(value);
  if (raw['kind'] !== 'group')
    fail('invalid_filter', 'tree must be a group: {"kind":"group","op":"and","children":[…]}');
  const tree = sanitizeTree(mapLines(raw, -1));
  const given = countRawConditions(raw);
  const kept = countConditions(tree);
  if (kept !== given) {
    fail(
      'invalid_filter',
      `${given - kept} of ${given} conditions are not usable (help topic filters: types, fields, at most 64 conditions, 16 levels)`,
    );
  }
  return tree;
}

/** The tree as the AI sees it: without ids and switches it does not need, lines 1-based. */
export function treeForAi(tree: FilterGroupNode): unknown {
  const strip = (node: FilterNode): unknown =>
    node.kind === 'group'
      ? {
          kind: 'group',
          op: node.op,
          ...(node.negate ? { negate: true } : {}),
          ...(node.enabled ? {} : { enabled: false }),
          children: node.children.map(strip),
        }
      : {
          kind: 'cond',
          ...(node.negate ? { negate: true } : {}),
          ...(node.enabled ? {} : { enabled: false }),
          cond: node.cond,
        };
  return mapLines(strip(tree), 1);
}

// ---------------------------------------------------------------- times

/**
 * An ISO 8601 time (or `YYYY-MM-DD HH:MM[:SS]`, or `HH:MM[:SS]` = today) as microseconds UTC; without a zone the
 * local time, like the timeline. Null if it is no time.
 */
export function parseTime(value: string, now = new Date()): number | null {
  const v = value.trim();
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (clock) {
    const d = new Date(now);
    d.setHours(Number(clock[1]), Number(clock[2]), Number(clock[3] ?? 0), 0);
    return d.getTime() * 1000;
  }
  const normal = /^\d{4}-\d{2}-\d{2} \d/.test(v) ? v.replace(' ', 'T') : v;
  if (!/^\d{4}-\d{2}-\d{2}/.test(normal)) return null;
  const ms = Date.parse(normal);
  return Number.isFinite(ms) ? ms * 1000 : null;
}

/** Microseconds UTC as ISO 8601 in UTC (what the AI gets back). */
export function isoOf(micros: number): string {
  return new Date(Math.floor(micros / 1000)).toISOString();
}

export function timeArg(args: Args, name: string, required: true): number;
export function timeArg(args: Args, name: string, required?: false): number | undefined;
export function timeArg(args: Args, name: string, required = false): number | undefined {
  const v = optStr(args, name, 64);
  if (v === undefined || v === '') {
    if (required) fail('invalid_args', `${name} is required`);
    return undefined;
  }
  const t = parseTime(v);
  if (t === null)
    fail('invalid_args', `${name} is no time: use ISO 8601 like 2026-11-09T14:03:00 or 14:03`);
  return t;
}
