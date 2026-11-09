import { describe, expect, it } from 'vitest';
import { countConditions } from '../sessions/filter-tree';
import {
  McpError,
  int,
  isoOf,
  levelsArg,
  isSecretColumn,
  maskSecrets,
  maskValue,
  oneOf,
  parseTime,
  reqInt,
  searchArg,
  str,
  textOut,
  timeArg,
  treeForAi,
  treeFromAi,
} from './mcp-logic';
import { MCP_LIMITS } from './mcp-limits';
import { pushHistory } from './mcp-history';

function codeOf(f: () => unknown): string | null {
  try {
    f();
    return null;
  } catch (e) {
    return e instanceof McpError ? e.code : 'other';
  }
}

describe('arguments', () => {
  it('takes defaults, checks ranges and types', () => {
    expect(int({}, 'count', { min: 1, max: 500, def: 50 })).toBe(50);
    expect(int({ count: 7 }, 'count', { min: 1, max: 500, def: 50 })).toBe(7);
    expect(codeOf(() => int({ count: 501 }, 'count', { min: 1, max: 500, def: 50 }))).toBe(
      'invalid_args',
    );
    expect(codeOf(() => int({ count: 1.5 }, 'count', { min: 1, max: 500, def: 50 }))).toBe(
      'invalid_args',
    );
    expect(codeOf(() => reqInt({}, 'line', { min: 1, max: 9 }))).toBe('invalid_args');
    expect(codeOf(() => str({ q: '' }, 'q', 10))).toBe('invalid_args');
    expect(codeOf(() => str({ q: 'x'.repeat(11) }, 'q', 10))).toBe('invalid_args');
    expect(oneOf({}, 'mode', ['raw', 'columns'] as const, 'raw')).toBe('raw');
    expect(codeOf(() => oneOf({ mode: 'x' }, 'mode', ['raw', 'columns'] as const))).toBe(
      'invalid_args',
    );
    expect(levelsArg({ levels: ['ERROR', 'ERROR', 'WARN'] }, 'levels')).toEqual(['ERROR', 'WARN']);
    expect(codeOf(() => levelsArg({ levels: ['SEVERE'] }, 'levels'))).toBe('invalid_args');
  });

  it('reads a search with the toolbar defaults', () => {
    expect(searchArg({ search: { text: 'timeout' } })).toEqual({
      query: { text: 'timeout', isRegex: false, caseSensitive: false },
      mode: 'filter',
    });
    expect(searchArg({})).toBeUndefined();
  });
});

describe('maskSecrets', () => {
  it('replaces values of known secrets and counts them', () => {
    const r = maskSecrets(
      'login user=bob password=hunter2 api_key: "abc123" Authorization: Bearer abcdefghijkl',
    );
    expect(r.text).toBe(
      'login user=bob password=«masked» api_key: «masked» Authorization: «masked»',
    );
    expect(r.count).toBe(3);
  });

  it('masks bearer tokens and JWTs on their own and leaves ordinary text', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(maskSecrets(`got Bearer abc.def-ghi_jkl and ${jwt}`).text).toBe(
      'got Bearer «masked» and «masked»',
    );
    const plain = 'GET /api/users 200 took 12ms tokenizer ready';
    expect(maskSecrets(plain)).toEqual({ text: plain, count: 0 });
  });

  it('finds secret keys inside longer names, quoted values with spaces and headers (review 022)', () => {
    const cases: [string, string][] = [
      ['DB_PASSWORD=s3cr3t next', 'DB_PASSWORD=«masked» next'],
      ['db_password=x', 'db_password=«masked»'],
      ['{"accessToken":"abc def"}', '{"accessToken":«masked»}'],
      ['aws_secret_access_key = AKIA/xyz', 'aws_secret_access_key = «masked»'],
      ['auth: bearer abcdefghijkl', 'auth: bearer «masked»'],
      ['Set-Cookie: sid=42; HttpOnly', 'Set-Cookie: «masked»'],
      ['connect postgres://app:hunter2@db:5432/x', 'connect postgres://app:«masked»@db:5432/x'],
      ['-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----', '«masked»'],
    ];
    for (const [input, out] of cases) expect(maskSecrets(input).text, input).toBe(out);
    expect(isSecretColumn('password')).toBe(true);
    expect(isSecretColumn('message')).toBe(false);
    expect(maskValue('api_key', 'abc', true)).toBe('«masked»');
    expect(maskValue('msg', 'pwd=1', true)).toBe('pwd=«masked»');
    expect(maskValue('msg', 7, true)).toBe(7);
    expect(maskValue('password', 'x', false)).toBe('x');
  });

  it('cuts after masking and says by how much', () => {
    expect(textOut('abcdef', 4, false)).toEqual({ text: 'abcd', truncatedChars: 2, masked: 0 });
    expect(textOut('pwd=secret!', 100, true).text).toBe('pwd=«masked»');
  });
});

describe('filter tree of the AI', () => {
  const ai = {
    kind: 'group',
    op: 'and',
    children: [
      { kind: 'cond', cond: { type: 'level', levels: ['ERROR'] } },
      {
        kind: 'cond',
        negate: true,
        cond: { type: 'text', text: '/health', isRegex: false, caseSensitive: false },
      },
      { kind: 'cond', cond: { type: 'lines', first: 1, last: 100 } },
    ],
  };

  it('becomes the sidebar tree with 0-based lines and back', () => {
    const tree = treeFromAi(ai);
    expect(tree.id).toBe('root');
    expect(countConditions(tree)).toBe(3);
    const lines = tree.children[2];
    expect(lines.kind === 'cond' && lines.cond).toEqual({ type: 'lines', first: 0, last: 99 });
    expect(treeForAi(tree)).toEqual(ai);
  });

  it('fails instead of dropping conditions', () => {
    const bad = { ...ai, children: [...ai.children, { kind: 'cond', cond: { type: 'magic' } }] };
    expect(codeOf(() => treeFromAi(bad))).toBe('invalid_filter');
    expect(codeOf(() => treeFromAi({ kind: 'cond' }))).toBe('invalid_filter');
    const many = {
      kind: 'group',
      op: 'or',
      children: Array.from({ length: 65 }, () => ({
        kind: 'cond',
        cond: { type: 'level', levels: ['ERROR'] },
      })),
    };
    expect(codeOf(() => treeFromAi(many))).toBe('invalid_filter');
  });
});

describe('times', () => {
  it('reads ISO, a date with a space and a clock time as local time', () => {
    const local = new Date(2026, 10, 9, 14, 3, 0).getTime() * 1000;
    expect(parseTime('2026-11-09T14:03:00')).toBe(local);
    expect(parseTime('2026-11-09 14:03')).toBe(local);
    expect(parseTime('14:03', new Date(2026, 10, 9, 20, 0))).toBe(local);
    expect(parseTime('2026-11-09T13:03:00Z')).toBe(Date.UTC(2026, 10, 9, 13, 3) * 1000);
    expect(parseTime('yesterday')).toBeNull();
    expect(isoOf(Date.UTC(2026, 0, 2, 3, 4, 5) * 1000)).toBe('2026-01-02T03:04:05.000Z');
    expect(codeOf(() => timeArg({ time: 'soon' }, 'time', true))).toBe('invalid_args');
  });
});

describe('history', () => {
  it('keeps the newest entries up to the limit', () => {
    let all = pushHistory([], { at: 0, tool: 'a', tab: null, result: 'ok', ms: 1 });
    for (let i = 0; i < MCP_LIMITS.historyMax + 5; i++) {
      all = pushHistory(all, { at: i, tool: `t${i}`, tab: null, result: 'ok', ms: 1 });
    }
    expect(all.length).toBe(MCP_LIMITS.historyMax);
    expect(all[0].tool).toBe(`t${MCP_LIMITS.historyMax + 4}`);
  });
});
