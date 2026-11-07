import { describe, expect, it } from 'vitest';
import { TextSegment } from '../log-table/highlight';
import {
  MAX_FORMAT_CHARS,
  blockStarts,
  findMatches,
  formatDetail,
  rawSegments,
  tokenizeXml,
} from './detail-format';

const textOf = (segments: TextSegment[]) => segments.map((s) => s.text).join('');
const withClass = (segments: TextSegment[], cls: string) =>
  segments.filter((s) => s.cls === cls).map((s) => s.text);

describe('detail format: JSON', () => {
  it('keeps a big number exactly as written', () => {
    const result = formatDetail('{"id":9007199254740993,"n":-1.5e+300}');
    expect(result?.kind).toBe('json');
    expect(textOf(result!.segments)).toBe('{\n  "id": 9007199254740993,\n  "n": -1.5e+300\n}');
    expect(withClass(result!.segments, 'f-number')).toEqual(['9007199254740993', '-1.5e+300']);
  });

  it('indents nested values and keeps empty containers short', () => {
    const result = formatDetail('[1,{"a":[true,null],"b":{}},[]]');
    expect(textOf(result!.segments)).toBe(
      '[\n  1,\n  {\n    "a": [\n      true,\n      null\n    ],\n    "b": {}\n  },\n  []\n]',
    );
    expect(withClass(result!.segments, 'f-key')).toEqual(['"a"', '"b"']);
    expect(withClass(result!.segments, 'f-literal')).toEqual(['true', 'null']);
  });

  it('leaves braces and quotes inside strings alone', () => {
    const result = formatDetail('{"msg":"a {b} [c] \\"q\\" , : d"}');
    expect(textOf(result!.segments)).toBe('{\n  "msg": "a {b} [c] \\"q\\" , : d"\n}');
    expect(withClass(result!.segments, 'f-string')).toEqual(['"a {b} [c] \\"q\\" , : d"']);
  });

  it('formats a block after the head line and keeps the head as it is', () => {
    const text = '2024-01-01 ERROR request failed\n{"status":500,"trace":"x"}';
    const result = formatDetail(text);
    expect(textOf(result!.segments)).toBe(
      '2024-01-01 ERROR request failed\n{\n  "status": 500,\n  "trace": "x"\n}',
    );
  });

  it('finds a block in the head line, the lines after it follow raw', () => {
    const text = '2024-01-01 INFO [main] payload={"a":1}\n  more';
    const result = formatDetail(text);
    expect(textOf(result!.segments)).toBe('2024-01-01 INFO [main] payload={\n  "a": 1\n}\n  more');
  });

  it('gives up on broken JSON: the panel shows the raw text', () => {
    for (const broken of [
      '{"a":1',
      '{"a":1,}',
      '{a:1}',
      '{"a":01}',
      '{"a":"open}',
      '[1 2]',
      '{"a":1} trailing',
      '{"a":tru}',
    ]) {
      expect(formatDetail(broken), broken).toBeNull();
    }
  });

  it('does not format very large or very deep text', () => {
    expect(formatDetail(`{"a":"${'x'.repeat(MAX_FORMAT_CHARS)}"}`)).toBeNull();
    expect(formatDetail('['.repeat(400) + ']'.repeat(400))).toBeNull();
  });

  it('finds the places a block may start', () => {
    expect(blockStarts('  {"a":1}')).toEqual([2]);
    expect(blockStarts('head [x] <b\n<?xml version="1.0"?><a/>')).toEqual([12, 5, 9]);
    expect(blockStarts('plain text\n\tat a.B')).toEqual([]);
  });
});

describe('detail format: XML', () => {
  it('indents a fragment, short elements stay on one line', () => {
    const result = formatDetail('<order id="7"><item>a</item><item/><note></note></order>');
    expect(result?.kind).toBe('xml');
    expect(textOf(result!.segments)).toBe(
      '<order id="7">\n  <item>a</item>\n  <item/>\n  <note></note>\n</order>',
    );
    expect(withClass(result!.segments, 'f-attr')).toEqual(['id']);
    expect(withClass(result!.segments, 'f-string')).toEqual(['"7"']);
  });

  it('handles the declaration, comments, CDATA and an attribute with >', () => {
    const text =
      '<?xml version="1.0"?><a x="1 > 0" y=\'b\'><!-- note <b> --><![CDATA[<raw> & ]]></a>';
    const result = formatDetail(text);
    expect(textOf(result!.segments)).toBe(
      '<?xml version="1.0"?>\n<a x="1 > 0" y=\'b\'>\n  <!-- note <b> -->\n  <![CDATA[<raw> & ]]>\n</a>',
    );
    expect(withClass(result!.segments, 'f-comment')).toEqual(['<!-- note <b> -->']);
    expect(withClass(result!.segments, 'f-cdata')).toEqual(['<![CDATA[<raw> & ]]>']);
    expect(withClass(result!.segments, 'f-meta')).toEqual(['<?xml version="1.0"?>']);
  });

  it('puts a block in the head line on its own line', () => {
    const result = formatDetail('2024-01-01 WARN SOAP fault <Fault><code>42</code></Fault>');
    expect(textOf(result!.segments)).toBe(
      '2024-01-01 WARN SOAP fault \n<Fault>\n  <code>42</code>\n</Fault>',
    );
  });

  it('rejects what is no XML', () => {
    expect(formatDetail('<a x="open></a>')).toBeNull();
    expect(formatDetail('<a><!-- open</a>')).toBeNull();
    expect(formatDetail('<a>1 < 2</a>')).toBeNull();
    expect(tokenizeXml('if a <b then', 3)).toBeNull();
    expect(formatDetail('2 < 3 and 4 > 1')).toBeNull();
  });
});

describe('detail format: raw view', () => {
  const query = (text: string, isRegex = false, caseSensitive = false) => ({
    text,
    isRegex,
    caseSensitive,
  });

  it('marks matches of the current search', () => {
    expect(findMatches('Order 1, order 2', query('order'))).toEqual([
      [0, 5],
      [9, 14],
    ]);
    expect(findMatches('Order 1, order 2', query('order', false, true))).toEqual([[9, 14]]);
    expect(findMatches('a.b axb', query('a.b'))).toEqual([[0, 3]]);
    expect(findMatches('a.b axb', query('a.b', true))).toEqual([
      [0, 3],
      [4, 7],
    ]);
    expect(findMatches('x', query('(', true))).toEqual([]);
    expect(findMatches('x', query(''))).toEqual([]);
    expect(findMatches('aaa', query('a*', true))).toEqual([[0, 3]]);
  });

  it('builds segments with tokens and hits', () => {
    const segments = rawSegments('ERROR order 42', query('order'));
    expect(textOf(segments)).toBe('ERROR order 42');
    expect(segments.find((s) => s.text === 'order')?.cls).toBe('hit');
    expect(segments.find((s) => s.text === '42')?.cls).toBe('t-number');
  });
});
