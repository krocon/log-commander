#!/usr/bin/env node
// Checks WCAG AA (prompt 020): the dark and light blocks of src/styles.css and every colour scheme in
// src/app/core/theme/themes/, completed from the base of its brightness, against the pairs of
// src/app/core/theme/contrast-pairs.json (text 4.5:1, graphics 3:1). dark.json and light.json must equal the
// blocks of styles.css. `--dir <folder>` checks the schemes of another folder (test fixtures),
// `--write-base` writes dark.json and light.json from styles.css.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  THEME_DIR,
  failures,
  readBaseBlocks,
  readPairs,
  readSchemes,
  readStyles,
} from './theme-lib.mjs';

const FONT_TOKENS = new Set(['--font-ui', '--font-mono']);
const COLOR = /^(#[0-9a-f]{6}|var\(--[a-z0-9-]+\))$/;
const BASE_NAMES = { dark: 'Dunkel', light: 'Hell' };

/** Problems of all schemes as text lines; empty when everything passes. */
export function checkAll({ css, schemes, pairs }) {
  const base = readBaseBlocks(css);
  const problems = [];
  if (!base.dark || !base.light) return ['styles.css: a dark and a light block are needed'];
  const names = new Set(Object.keys(base.dark));
  for (const name of Object.keys(base.light)) {
    if (!names.has(name)) problems.push(`light: ${name} is missing in the dark block`);
  }
  for (const name of names) {
    if (!(name in base.light)) problems.push(`dark: ${name} is missing in the light block`);
  }
  for (const id of ['dark', 'light']) {
    for (const { fg, bg, min, ratio } of failures(base[id], pairs)) {
      problems.push(
        `styles.css ${id}: ${fg} on ${bg} = ${ratio?.toFixed(2) ?? 'missing'} (below ${min})`,
      );
    }
  }
  for (const scheme of schemes) {
    const own = base[scheme.dark ? 'dark' : 'light'];
    if (scheme.id === 'dark' || scheme.id === 'light') {
      const same =
        Object.keys(scheme.tokens).length === Object.keys(base[scheme.id]).length &&
        Object.entries(base[scheme.id]).every(([k, v]) => scheme.tokens[k] === v);
      if (!same)
        problems.push(
          `${scheme.id}.json differs from styles.css (npm run contrast -- --write-base)`,
        );
      continue;
    }
    for (const [name, value] of Object.entries(scheme.tokens)) {
      const ok = FONT_TOKENS.has(name)
        ? /^[\w\s,'"-]{1,300}$/.test(value)
        : names.has(name) && COLOR.test(value);
      if (!ok) problems.push(`${scheme.id}: ${name} = ${value} is no token or no plain colour`);
    }
    const tokens = { ...own, ...scheme.tokens };
    for (const { fg, bg, min, ratio } of failures(tokens, pairs)) {
      problems.push(
        `${scheme.id}: ${fg} on ${bg} = ${ratio?.toFixed(2) ?? 'missing'} (below ${min})`,
      );
    }
  }
  return problems;
}

function writeBase(css) {
  const base = readBaseBlocks(css);
  for (const id of ['dark', 'light']) {
    const scheme = { id, name: BASE_NAMES[id], dark: id === 'dark', tokens: base[id] };
    writeFileSync(join(THEME_DIR, `${id}.json`), `${JSON.stringify(scheme, null, 2)}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const css = readStyles();
  if (process.argv.includes('--write-base')) writeBase(css);
  const i = process.argv.indexOf('--dir');
  const dir = i >= 0 ? process.argv[i + 1] : THEME_DIR;
  const pairs = readPairs();
  // The base schemes come from styles.css; a fixture folder holds the schemes to check only.
  const schemes = readSchemes(dir);
  const problems = checkAll({ css, schemes, pairs });
  if (problems.length) {
    for (const p of problems) console.error(p);
    process.exit(1);
  }
  const text = pairs.filter((p) => p[2] >= 4.5).length;
  console.log(
    `contrast ok: ${text} text pairs, ${pairs.length - text} graphic pairs in dark, light and ${schemes.filter((s) => s.id !== 'dark' && s.id !== 'light').length} further schemes`,
  );
}
