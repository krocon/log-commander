#!/usr/bin/env node
// Checks WCAG AA in both themes of src/styles.css: 4.5:1 for text, 3:1 for graphics.
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
  // Sidebar (prompt 005): the current file on the selection colour.
  ['text', 'row-selected'],
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
  // Detail panel (prompt 004): text, inline tokens and JSON/XML colours on its background.
  ['text-dim', 'bg-app'],
  ['tok-time', 'bg-app'],
  ['tok-number', 'bg-app'],
  ['tok-string', 'bg-app'],
  ['tok-id', 'bg-app'],
  ['tok-url', 'bg-app'],
  // Dashboard (prompt 012): errors and notes of a panel, legend and axis text on the panel.
  ['danger', 'bg-panel'],
  // Timeline (prompt 014): axis labels and hints on the strip.
  ['text-dim', 'ruler-bg'],
  ['text', 'ruler-bg'],
];

// Graphics without text (WCAG 1.4.11, 3:1): the grip of the splitters (src/app/shared/splitter.ts)
// against the bar and against the panes beside it.
const GRAPHIC_PAIRS = [
  ['splitter-grip', 'splitter-bg'],
  ['splitter-grip', 'splitter-hover-bg'],
  ['splitter-grip', 'bg-app'],
  ['splitter-grip', 'bg-panel'],
  ['accent', 'splitter-hover-bg'],
  // Level marks in the statistics of the sidebar (prompt 005), on its background.
  ['lv-trace-fg', 'bg-panel'],
  ['lv-debug-fg', 'bg-panel'],
  ['lv-info-badge', 'bg-panel'],
  ['lv-warn-fg', 'bg-panel'],
  ['lv-error-fg', 'bg-panel'],
  ['lv-error-edge', 'bg-panel'],
  // Source colours of a merge (prompt 006): stripe in the gutter, chips in the toolbar.
  ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap((i) => [
    [`src-${i}`, 'bg-gutter'],
    [`src-${i}`, 'row-selected'],
    [`src-${i}`, 'bg-panel'],
    [`src-${i}`, 'bg-raised'],
  ]),
  // Overview ruler (prompt 007): marks on the ruler and on its visible band, the band's edge, the
  // bookmark flag in the gutter.
  ...['ruler-fatal', 'ruler-error', 'ruler-warn', 'ruler-bookmark', 'ruler-selection'].flatMap(
    (token) => [
      [token, 'ruler-bg'],
      [token, 'ruler-band'],
    ],
  ),
  ['ruler-band-edge', 'ruler-bg'],
  // Timeline (prompt 014): neutral columns on the strip and in the band, the hatching of an outage, cursor
  // and selection (accent) on both.
  ['tl-all', 'ruler-bg'],
  ['tl-all', 'ruler-band'],
  ['tl-gap', 'ruler-bg'],
  ['accent', 'ruler-bg'],
  ['accent', 'ruler-band'],
  ['ruler-bookmark', 'bg-gutter'],
  ['ruler-bookmark', 'row-selected'],
  // Dashboard (prompt 012): series and level series on the panel; the legend names each, so colour is
  // never the only hint.
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => [`chart-${i}`, 'bg-panel']),
  ...['unknown', 'trace', 'debug', 'info', 'warn', 'error', 'fatal'].map((l) => [
    `chart-lv-${l}`,
    'bg-panel',
  ]),
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
  const checks = [
    ...PAIRS.map((pair) => [...pair, 4.5]),
    ...GRAPHIC_PAIRS.map((pair) => [...pair, 3]),
  ];
  for (const [fg, bg, min] of checks) {
    if (!tokens[fg] || !tokens[bg]) throw new Error(`${name}: missing token ${fg} or ${bg}`);
    const ratio = contrast(tokens[fg], tokens[bg]);
    if (ratio < min) {
      console.error(`${name}: ${fg} on ${bg} = ${ratio.toFixed(2)} (below ${min})`);
      failed++;
    }
  }
}
if (failed) process.exit(1);
console.log(
  `contrast ok: ${PAIRS.length} text pairs, ${GRAPHIC_PAIRS.length} graphic pairs in ${blocks.length} themes`,
);
