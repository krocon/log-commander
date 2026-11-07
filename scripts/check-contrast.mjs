#!/usr/bin/env node
// Checks WCAG AA (4.5:1) for the level colours of both themes in src/styles.css.
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const blocks = [...css.matchAll(/\/\* @theme (\w+) \*\/([\s\S]*?)\/\* @end \*\//g)];
if (blocks.length !== 2) throw new Error('expected a dark and a light block in styles.css');

const PAIRS = [
  ['lv-trace-fg', 'lv-trace-bg'],
  ['lv-debug-fg', 'lv-debug-bg'],
  ['lv-info-fg', 'lv-info-bg'],
  ['lv-info-badge', 'lv-info-bg'],
  ['lv-warn-fg', 'lv-warn-bg'],
  ['lv-error-fg', 'lv-error-bg'],
  ['lv-fatal-fg', 'lv-fatal-bg'],
  ['lv-unknown-fg', 'lv-unknown-bg'],
  ['text', 'bg-app'],
  ['text-dim', 'bg-panel'],
  // Column header and column menu (prompt 009).
  ['text', 'bg-panel'],
  ['text', 'bg-raised'],
  ['text', 'bg-hover'],
  ['text-dim', 'bg-raised'],
  ['hit-text', 'hit-bg'],
  ['hit-current-text', 'hit-current-bg'],
  ['tok-time', 'lv-info-bg'],
  ['tok-number', 'lv-info-bg'],
  ['tok-string', 'lv-info-bg'],
  ['tok-id', 'lv-info-bg'],
  ['tok-url', 'lv-info-bg'],
  ['accent-text', 'accent'],
];

function luminance(hex) {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

let failed = 0;
for (const [, name, body] of blocks) {
  const tokens = Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]),
  );
  for (const [fg, bg] of PAIRS) {
    if (!tokens[fg] || !tokens[bg]) throw new Error(`${name}: missing token ${fg} or ${bg}`);
    const ratio = contrast(tokens[fg], tokens[bg]);
    if (ratio < 4.5) {
      console.error(`${name}: ${fg} on ${bg} = ${ratio.toFixed(2)} (below 4.5)`);
      failed++;
    }
  }
}
if (failed) process.exit(1);
console.log(`contrast ok: ${PAIRS.length} pairs in ${blocks.length} themes`);
