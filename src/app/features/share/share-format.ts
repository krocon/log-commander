/**
 * Sharing a selection for a ticket (prompt 015): a head with file, lines, time span and the active filter, the
 * text as a code block (Markdown fence or Jira `{code}`), notes as a list. At most `SHARE_LIMIT` bytes; for more
 * there is the export.
 */

export const SHARE_LIMIT = 64 * 1024;

export type ShareKind = 'markdown' | 'jira';

export interface ShareInput {
  file: string;
  /** 0-based line numbers of the selection. */
  first: number;
  last: number;
  /** Lines the text holds (the view may hide some of the selection). */
  lineCount: number;
  /** Time of the first and the last entry, as the log writes it; null without times. */
  from: string | null;
  to: string | null;
  /** The filter of the tab as text („ERROR › Timeout“), null without one. */
  filter: string | null;
  text: string;
  notes: readonly { line: number; text: string }[];
  /** The selection went on beyond `text` (it was taken only in part). */
  more?: boolean;
}

export interface ShareResult {
  text: string;
  /** The code was cut to stay below the limit. */
  truncated: boolean;
}

/** Zero-width space: breaks `{code` in the text without showing. */
const ZWSP = String.fromCharCode(0x200b);
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

/** A Markdown fence longer than every backtick run in the text (at least three). */
export function markdownFence(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Inline Markdown: characters that would format are escaped, line breaks become spaces. */
export function escapeMarkdown(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').replace(/([\\`*_[\]<>#|~!])/g, '\\$1');
}

/** Inline Jira wiki markup: the characters that start formatting or macros are escaped. */
export function escapeJira(text: string): string {
  // `!` starts an image that Jira loads by itself (tracking pixel), `[` a link, `{` a macro, `|` a table.
  return text.replace(/\s*[\r\n]+\s*/g, ' ').replace(/([\\*_{}[\]|^~+?!-])/g, '\\$1');
}

/**
 * The Jira block for the text: `{code}`, or `{noformat}` if the text contains `{code`; if it contains both,
 * `{code}` with a zero-width space after each `{` of `{code`, so the block cannot be closed early.
 */
export function jiraBlock(text: string): { open: string; close: string; body: string } {
  const hasCode = /\{code/i.test(text);
  const hasNoformat = /\{noformat/i.test(text);
  if (hasCode && !hasNoformat) return { open: '{noformat}', close: '{noformat}', body: text };
  const body = hasCode ? text.replace(/\{(code)/gi, `{${ZWSP}$1`) : text;
  return { open: '{code}', close: '{code}', body };
}

function lineSpan(input: ShareInput): string {
  const a = input.first + 1;
  const b = input.last + 1;
  const range = a === b ? `Zeile ${a}` : `Zeilen ${a}–${b}`;
  const count = input.lineCount === 1 ? '1 Zeile' : `${input.lineCount} Zeilen`;
  return `${range} (${count})`;
}

function timeSpan(input: ShareInput): string | null {
  if (!input.from) return null;
  return input.to && input.to !== input.from ? `${input.from} – ${input.to}` : input.from;
}

const CUT_NOTE = '… gekürzt (64 KB), den ganzen Bereich liefert der Export (⌘/Strg+⇧+E)';

export function shareText(kind: ShareKind, input: ShareInput): ShareResult {
  const build = (code: string, cut: boolean): string => {
    const esc = kind === 'markdown' ? escapeMarkdown : escapeJira;
    const bold = (t: string) => (kind === 'markdown' ? `**${t}**` : `*${t}*`);
    const head = [bold(esc(input.file)), esc(lineSpan(input))];
    const time = timeSpan(input);
    if (time) head.push(esc(time));
    const out = [head.join(' · ')];
    if (input.filter) out.push(`Filter: ${esc(input.filter)}`);
    out.push('');
    if (kind === 'markdown') {
      const fence = markdownFence(code);
      out.push(fence, code, fence);
    } else {
      const block = jiraBlock(code);
      out.push(`${block.open}\n${block.body}\n${block.close}`);
    }
    if (cut) out.push(kind === 'markdown' ? `_${CUT_NOTE}_` : `_${CUT_NOTE}_`);
    if (input.notes.length) {
      out.push('', kind === 'markdown' ? '**Notizen**' : '*Notizen*');
      for (const note of input.notes) {
        out.push(`${kind === 'markdown' ? '-' : '*'} Zeile ${note.line + 1}: ${esc(note.text)}`);
      }
    }
    return `${out.join('\n')}\n`;
  };
  const code = input.text.replace(/\n$/, '');
  const full = build(code, input.more === true);
  if (bytes(full) <= SHARE_LIMIT) return { text: full, truncated: input.more === true };
  // Cut whole lines until it fits; the frame (head, notes) takes its share first.
  const frame = bytes(build('', true));
  let room = SHARE_LIMIT - frame;
  const kept: string[] = [];
  for (const line of code.split('\n')) {
    const size = bytes(line) + 1;
    if (size > room) break;
    kept.push(line);
    room -= size;
  }
  return { text: build(kept.join('\n'), true), truncated: true };
}
