#!/usr/bin/env node
// Colour schemes after the schemes of files-and-folders (prompt 020), in two steps:
//
//   node scripts/theme-from-fnf.mjs <fnf-theme.json>   prints a recipe: the palette taken from its tokens
//   node scripts/theme-from-fnf.mjs --all              builds every scheme of scripts/theme-recipes.json
//                                                       into src/app/core/theme/themes/<id>.json
//
// A recipe is the palette of a scheme (surfaces, text, accent and the hues of the original) plus hand-tuned
// tokens (`set`). The palette becomes all tokens of log-commander; a foreground that misses its contrast pair is
// moved towards white or black until it passes (a background where the foreground is the reading colour itself).
// That happens once, when the file is made: the app never corrects contrast at runtime. A scheme file holds only
// what differs from the base of its brightness (dark/light = styles.css).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT,
  THEME_DIR,
  contrast,
  failures,
  luminance,
  mix,
  readBaseBlocks,
  readPairs,
  readStyles,
  resolve,
} from './theme-lib.mjs';

const RECIPES = join(ROOT, 'scripts/theme-recipes.json');
export const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace";

/** files-and-folders token → palette entry (first that resolves wins). */
const FNF_PALETTE = {
  bg: ['--color-list-bg'],
  panel: ['--color-surface', '--color-header-bg'],
  raised: ['--color-surface-raised', '--color-menu-bg'],
  hover: ['--color-row-hover'],
  border: ['--color-border'],
  text: ['--color-list-text', '--color-text'],
  dim: ['--color-muted'],
  accent: ['--color-accent'],
  accentText: ['--color-accent-text'],
  selection: ['--color-cursor-inactive-bg', '--color-selection'],
  hit: ['--color-search-hit'],
  red: ['--color-error-text', '--color-danger-text'],
  redStrong: ['--color-danger', '--color-badge-bg'],
  yellow: ['--color-favorite', '--color-icon-folder'],
  orange: ['--color-icon-archive'],
  green: ['--color-icon-executable', '--color-shell-prompt'],
  cyan: ['--color-symlink-text', '--color-icon-audio'],
  blue: ['--color-icon-code', '--color-shell-info-text'],
  purple: ['--color-icon-image'],
};

/** Resolves `var(--x)` chains of a files-and-folders scheme to `#rrggbb`. */
function fnfColor(tokens, name) {
  const value = resolve(tokens, name);
  return value && /^#[0-9a-f]{6}$/.test(value) ? value : null;
}

/** The palette (recipe) of a files-and-folders scheme file. */
export function recipeFromFnf(fnf) {
  const palette = {};
  for (const [key, names] of Object.entries(FNF_PALETTE)) {
    for (const name of names) {
      const c = fnfColor(fnf.tokens, name);
      if (c) {
        palette[key] = c;
        break;
      }
    }
  }
  const series = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => fnfColor(fnf.tokens, `--color-usage-${i}`));
  if (series.every(Boolean)) palette.series = series;
  const mono = /mono/i.test(fnf.tokens['--font-list'] ?? '');
  return {
    id: fnf.id,
    name: fnf.name,
    dark: fnf.dark,
    palette,
    ...(mono ? { fonts: 'mono' } : {}),
  };
}

/** All tokens of log-commander from a palette (before the contrast fit). */
export function tokensFromPalette(p, dark) {
  const warn = p.warn ?? p.yellow ?? p.orange;
  const redStrong = p.redStrong ?? p.red;
  const series = p.series ?? [
    p.blue,
    p.orange,
    p.green,
    p.purple,
    p.yellow,
    p.cyan,
    p.red,
    p.accent,
  ];
  const t = {
    '--bg-app': p.bg,
    '--bg-panel': p.panel,
    '--bg-raised': p.raised,
    '--bg-hover': p.hover,
    '--bg-gutter': p.gutter ?? p.bg,
    '--border': p.border,
    '--text': p.text,
    '--text-dim': p.dim,
    '--accent': p.accent,
    '--accent-text': p.accentText,
    '--danger': p.red,
    '--ok': p.green,
    '--row-selected': p.selection,
    '--hit-bg': p.hit,
    '--hit-text': p.hitText ?? p.text,
    '--hit-current-bg': p.hitCurrent ?? p.yellow,
    '--hit-current-text': p.hitCurrentText ?? (dark ? p.bg : '#ffffff'),
    '--lv-trace-fg': p.trace ?? p.dim,
    '--lv-trace-bg': p.bg,
    '--lv-debug-fg': p.cyan,
    '--lv-debug-bg': p.bg,
    '--lv-info-fg': p.text,
    '--lv-info-bg': p.bg,
    '--lv-info-badge': p.green,
    '--lv-warn-fg': warn,
    '--lv-warn-bg': mix(p.bg, warn, dark ? 0.12 : 0.1),
    '--lv-error-fg': p.red,
    '--lv-error-bg': mix(p.bg, redStrong, dark ? 0.14 : 0.08),
    '--lv-error-edge': redStrong,
    '--lv-fatal-fg': p.fatalText ?? '#ffffff',
    '--lv-fatal-bg': p.fatal ?? redStrong,
    '--lv-unknown-fg': p.text,
    '--lv-unknown-bg': p.bg,
    '--tok-time': p.time ?? p.dim,
    '--tok-number': p.number ?? p.orange,
    '--tok-string': p.string ?? p.green,
    '--tok-id': p.id ?? p.purple,
    '--tok-url': p.url ?? p.blue,
    '--splitter-bg': p.splitter ?? p.border,
    '--splitter-grip': p.dim,
    '--splitter-hover-bg': mix(p.splitter ?? p.border, p.text, 0.12),
    ...Object.fromEntries(series.map((c, i) => [`--src-${i + 1}`, c])),
    '--ruler-bg': p.panel,
    '--ruler-band': mix(p.panel, p.text, 0.1),
    '--ruler-band-edge': p.dim,
    '--ruler-fatal': p.magenta ?? p.purple,
    '--ruler-error': redStrong,
    '--ruler-warn': warn,
    '--ruler-bookmark': p.accent,
    '--ruler-selection': p.text,
    '--note': p.green,
    '--tl-all': mix(p.dim, p.panel, 0.15),
    '--tl-gap': p.dim,
    ...Object.fromEntries(series.map((c, i) => [`--chart-${i + 1}`, c])),
    '--chart-lv-unknown': p.dim,
    '--chart-lv-trace': p.trace ?? p.dim,
    '--chart-lv-debug': p.cyan,
    '--chart-lv-info': p.accent,
    '--chart-lv-warn': warn,
    '--chart-lv-error': redStrong,
    '--chart-lv-fatal': p.magenta ?? p.purple,
    '--chart-grid': p.border,
  };
  return t;
}

/**
 * Tokens that are the reading colour themselves: when a pair with one of them as foreground fails, the
 * background moves instead (a selection darker, FATAL's area deeper), never the text.
 */
const KEEP = new Set(['--text', '--lv-fatal-fg', '--lv-info-fg', '--lv-unknown-fg']);
const SURFACES = new Set(['--bg-app', '--bg-panel', '--lv-info-bg', '--bg-gutter', '--ruler-bg']);

/** Moves colours until every pair passes; throws when it cannot. `fixed` tokens are never moved. */
export function fit(tokens, pairs, fixed = new Set()) {
  const out = { ...tokens };
  const direction = {};
  const flipped = new Set();
  for (let round = 0; round < 400; round++) {
    const failed = failures(out, pairs);
    if (failed.length === 0) return out;
    for (const { fg, bg, min } of failed) {
      const moveBg = KEEP.has(fg) || fixed.has(fg);
      const name = moveBg ? bg : fg;
      if (fixed.has(name) || (moveBg && SURFACES.has(name))) {
        throw new Error(`cannot fit ${fg} on ${bg}: ${name} is fixed`);
      }
      const value = resolve(out, name);
      const other = resolve(out, moveBg ? fg : bg);
      if (!value || !other) throw new Error(`missing colour for ${fg} on ${bg}`);
      if (contrast(value, other) >= min) continue;
      // away from the other colour: lighter on a dark one, darker on a light one; when that end is
      // reached without success, the other way from the start (white text on a mid-tone turns dark)
      if (!(name in direction)) direction[name] = luminance(other) < luminance(value);
      const target = direction[name] ? '#ffffff' : '#000000';
      if (value === target) {
        if (flipped.has(name)) throw new Error(`cannot fit ${fg} on ${bg} (${value} on ${other})`);
        flipped.add(name);
        direction[name] = !direction[name];
        out[name] = tokens[name];
        continue;
      }
      out[name] = mix(value, target, 0.06);
    }
  }
  throw new Error(`no fit after 400 rounds: ${JSON.stringify(failures(out, pairs))}`);
}

/** A complete scheme file (only what differs from the base) from a recipe. */
export function buildScheme(recipe, base, pairs) {
  const own = base[recipe.dark ? 'dark' : 'light'];
  const raw = { ...tokensFromPalette(recipe.palette, recipe.dark), ...(recipe.set ?? {}) };
  for (const [name, value] of Object.entries(raw)) {
    if (!(name in own)) throw new Error(`${recipe.id}: ${name} is no token`);
    if (!/^#[0-9a-f]{6}$/.test(value ?? '')) throw new Error(`${recipe.id}: ${name} = ${value}`);
  }
  const fitted = fit({ ...own, ...raw }, pairs, new Set(Object.keys(recipe.set ?? {})));
  const tokens = {};
  for (const name of Object.keys(own)) {
    if (fitted[name] !== own[name]) tokens[name] = fitted[name];
  }
  if (recipe.fonts === 'mono') {
    tokens['--font-ui'] = MONO;
    tokens['--font-mono'] = MONO;
  }
  return { id: recipe.id, name: recipe.name, dark: recipe.dark, tokens };
}

/** What the fit changed against the palette (for docs/themes.md). */
export function adjustments(recipe, scheme) {
  const raw = tokensFromPalette(recipe.palette, recipe.dark);
  return Object.entries(raw)
    .filter(([name, value]) => scheme.tokens[name] && scheme.tokens[name] !== value)
    .map(([name, value]) => `${name} ${value} → ${scheme.tokens[name]}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args[0] === '--all') {
    const base = readBaseBlocks(readStyles());
    const pairs = readPairs();
    const only = args.slice(1).find((a) => !a.startsWith('--'));
    for (const recipe of JSON.parse(readFileSync(RECIPES, 'utf8')).recipes) {
      if (only && recipe.id !== only) continue;
      const scheme = buildScheme(recipe, base, pairs);
      writeFileSync(join(THEME_DIR, `${recipe.id}.json`), `${JSON.stringify(scheme, null, 2)}\n`);
      const moved = adjustments(recipe, scheme);
      console.log(
        `${recipe.id}: ${Object.keys(scheme.tokens).length} tokens, ${moved.length} moved`,
      );
      if (args.includes('--verbose')) for (const m of moved) console.log(`  ${m}`);
    }
  } else if (args[0]) {
    console.log(JSON.stringify(recipeFromFnf(JSON.parse(readFileSync(args[0], 'utf8'))), null, 2));
  } else {
    console.error('usage: theme-from-fnf.mjs <fnf-theme.json> | --all [id] [--verbose]');
    process.exit(2);
  }
}
