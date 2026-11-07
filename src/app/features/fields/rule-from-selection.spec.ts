import { describe, expect, it } from 'vitest';
import { escapeRegex, locateSelection, ruleFromSelection } from './rule-from-selection';

/** Builds the rule for `marked` inside `text` and runs it (JS regex; the patterns are meant for Rust). */
function build(text: string, marked: string, at = text.indexOf(marked)) {
  const rule = ruleFromSelection(text, at, at + marked.length);
  if (!rule) throw new Error('no rule');
  const run = (line: string) => new RegExp(rule.pattern).exec(line)?.[1] ?? null;
  return { ...rule, run };
}

describe('ruleFromSelection', () => {
  it('takes the key in front and the unit behind a number', () => {
    const r = build('INFO cpu=72.3% mem=1.2GB', '72.3');
    expect(r.pattern).toBe('\\bcpu=([-+]?\\d+(?:[.,]\\d+)*)%');
    expect(r).toMatchObject({ name: 'cpu', kind: 'percent', unit: '%' });
    expect(r.run('x cpu=5% y')).toBe('5');
    expect(r.run('x cpu=5,5% y')).toBe('5,5');
    expect(r.run('xcpu=5%')).toBeNull();
    const mem = build('INFO cpu=72.3% mem=1.2GB', '1.2');
    expect(mem).toMatchObject({ name: 'mem', kind: 'size', unit: 'GB' });
    expect(mem.run('mem=700GB')).toBe('700');
  });

  it('keeps a marked unit in the group and allows any unit of its kind', () => {
    const r = build('call took 340ms', '340ms');
    expect(r).toMatchObject({ name: 'took', kind: 'duration', unit: null });
    expect(r.run('call took 1.2s')).toBe('1.2s');
    expect(r.run('call took 340ms')).toBe('340ms');
    expect(r.pattern.endsWith('$')).toBe(true);
  });

  it('anchors at the start and the end of the line', () => {
    const start = build('42 items done', '42');
    expect(start.pattern).toBe('^([-+]?\\d+(?:[.,]\\d+)*)\\b');
    expect(start).toMatchObject({ kind: 'number', name: 'wert' });
    expect(start.run('7 items done')).toBe('7');
    const end = build('status is ok', 'ok');
    expect(end.pattern).toBe('\\bis\\s+(.+)$');
    expect(end.run('status is not ok')).toBe('not ok');
    expect(end.name).toBe('is');
  });

  it('escapes special characters of the context', () => {
    const r = build('a.b[c]=(42) {x}', '42');
    expect(r.pattern).toBe('^a\\.b\\[c\\]=\\(([-+]?\\d+(?:[.,]\\d+)*)\\b');
    expect(r.run('a.b[c]=(7) z')).toBe('7');
    expect(r.run('aXb[c]=(7)')).toBeNull();
    expect(escapeRegex('a-b#c&d~e$')).toBe('a\\-b\\#c\\&d\\~e\\$');
  });

  it('generalises digits in front, takes text up to the character behind it', () => {
    const r = build('10.0.0.5:8080 user="alice" ok', 'alice');
    expect(r.pattern).toBe('\\buser="([^\\s"]+)');
    expect(r).toMatchObject({ name: 'user', kind: 'text' });
    expect(r.run('x user="bob" y')).toBe('bob');
    const port = build('10.0.0.5:8080 open', '8080');
    expect(port.run('192.168.1.10:443 open')).toBe('443');
    const words = build('msg [hello world] end', 'hello world');
    expect(words.pattern).toBe('\\[(.+?)\\]');
    expect(words.run('msg [a b c] end')).toBe('a b c');
  });

  it('counts UTF-16 like the selection (umlauts, emoji)', () => {
    const r = build('🎉 Größe=12 kB fertig', '12');
    expect(r).toMatchObject({ name: 'Größe', kind: 'size', unit: 'kB' });
    expect(r.run('🎉 Größe=3 kB fertig')).toBe('3');
  });

  it('trims the marked text and refuses only whitespace', () => {
    expect(ruleFromSelection('a  b', 1, 3)).toBeNull();
    const r = ruleFromSelection('took  340ms ', 4, 12);
    expect(r?.kind).toBe('duration');
  });
});

describe('locateSelection', () => {
  it('finds marked text in the cell first, the first line of a selection over rows', () => {
    const text = 'a=1 b=1';
    expect(locateSelection(text, '1', [4, 7])).toEqual([6, 7]);
    expect(locateSelection(text, '1')).toEqual([2, 3]);
    expect(locateSelection(text, 'b=1\nnext row')).toEqual([4, 7]);
    expect(locateSelection(text, 'zzz')).toBeNull();
    expect(locateSelection(text, '  ')).toBeNull();
  });
});
