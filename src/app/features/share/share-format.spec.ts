import { describe, expect, it } from 'vitest';
import {
  SHARE_LIMIT,
  ShareInput,
  escapeJira,
  escapeMarkdown,
  jiraBlock,
  markdownFence,
  shareText,
} from './share-format';

const input = (over: Partial<ShareInput> = {}): ShareInput => ({
  file: 'app_1.log',
  first: 11,
  last: 13,
  lineCount: 3,
  from: '10:00:01',
  to: '10:00:05',
  filter: 'ERROR › Timeout',
  text: 'ERROR one\n  at x.Y\nCaused by: z\n',
  notes: [{ line: 11, text: 'fängt *hier* an' }],
  ...over,
});

describe('share as Markdown and Jira', () => {
  it('writes a head, the code and the notes in Markdown', () => {
    const { text, truncated } = shareText('markdown', input());
    expect(truncated).toBe(false);
    expect(text).toBe(
      [
        '**app\\_1.log** · Zeilen 12–14 (3 Zeilen) · 10:00:01 – 10:00:05',
        'Filter: ERROR › Timeout',
        '',
        '```',
        'ERROR one',
        '  at x.Y',
        'Caused by: z',
        '```',
        '',
        '**Notizen**',
        '- Zeile 12: fängt \\*hier\\* an',
        '',
      ].join('\n'),
    );
  });

  it('makes the fence longer than any backticks in the text', () => {
    expect(markdownFence('a ``` b')).toBe('````');
    expect(markdownFence('no ticks')).toBe('```');
    const { text } = shareText('markdown', input({ text: 'x ```` y\n', notes: [] }));
    expect(text).toContain('`````\nx ```` y\n`````');
  });

  it('writes Jira markup and keeps {code} in the text from closing the block', () => {
    const { text } = shareText('jira', input({ filter: null, from: null }));
    expect(text.startsWith('*app\\_1.log* · Zeilen 12–14 (3 Zeilen)\n\n{code}\nERROR one')).toBe(
      true,
    );
    expect(text).toContain('* Zeile 12: fängt \\*hier\\* an');
    expect(jiraBlock('a {code} b').open).toBe('{noformat}');
    const both = jiraBlock('a {code} {noformat} b');
    expect(both.open).toBe('{code}');
    expect(both.body).not.toContain('{code}');
    expect(both.body.split(String.fromCharCode(0x200b)).join('')).toBe('a {code} {noformat} b');
  });

  it('turns no note into an image, a link or a macro', () => {
    const evil = '!https://evil.example/t.png! [x|https://evil.example] {html}<img>{html}';
    const jira = shareText('jira', input({ notes: [{ line: 11, text: evil }] })).text;
    const line = jira.split('\n').find((l) => l.startsWith('* Zeile 12'))!;
    expect(line).toBe(
      '* Zeile 12: \\!https://evil.example/t.png\\! \\[x\\|https://evil.example\\] \\{html\\}<img>\\{html\\}',
    );
    const md = shareText(
      'markdown',
      input({ notes: [{ line: 11, text: '![t](https://evil.example/t.png)' }] }),
    ).text;
    expect(md).toContain('- Zeile 12: \\!\\[t\\](https://evil.example/t.png)');
  });

  it('escapes inline text', () => {
    expect(escapeMarkdown('a`b\nc')).toBe('a\\`b c');
    expect(escapeJira('{x}|[y]')).toBe('\\{x\\}\\|\\[y\\]');
  });

  it('cuts at 64 KB on a line boundary and says so', () => {
    const line = 'Ä'.repeat(99);
    const big = Array.from({ length: 2000 }, (_, i) => `${i} ${line}`).join('\n');
    const { text, truncated } = shareText('markdown', input({ text: big }));
    expect(truncated).toBe(true);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(SHARE_LIMIT);
    expect(text).toContain('gekürzt');
    const code = text.split('```')[1].trim().split('\n');
    expect(code.every((l) => l.endsWith(line))).toBe(true);
    expect(text).toContain('**Notizen**');
  });

  it('names one line as such', () => {
    const { text } = shareText('jira', input({ first: 4, last: 4, lineCount: 1, to: null }));
    expect(text).toContain('Zeile 5 (1 Zeile) · 10:00:01');
  });
});
