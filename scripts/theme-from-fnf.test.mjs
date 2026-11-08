import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkAll } from './check-contrast.mjs';
import { buildScheme, fit, recipeFromFnf, tokensFromPalette } from './theme-from-fnf.mjs';
import {
  ROOT,
  contrast,
  failures,
  readBaseBlocks,
  readPairs,
  readSchemes,
  readStyles,
} from './theme-lib.mjs';

const base = readBaseBlocks(readStyles());
const pairs = readPairs();

const FNF = {
  id: 'demo',
  name: 'Demo',
  dark: true,
  tokens: {
    '--color-list-bg': '#202020',
    '--color-surface': '#181818',
    '--color-surface-raised': '#2a2a2a',
    '--color-row-hover': '#2c2c2c',
    '--color-border': '#333333',
    '--color-text': '#d0d0d0',
    '--color-list-text': 'var(--color-text)',
    '--color-muted': '#909090',
    '--color-accent': '#5a9cf8',
    '--color-accent-text': '#101010',
    '--color-cursor-inactive-bg': '#303848',
    '--color-search-hit': '#5a4a10',
    '--color-error-text': '#ff8080',
    '--color-danger': '#e05050',
    '--color-favorite': '#e0c060',
    '--color-icon-archive': '#d09060',
    '--color-icon-executable': '#80c060',
    '--color-symlink-text': '#60c0c8',
    '--color-icon-code': '#60a8f0',
    '--color-icon-image': '#c080e0',
    '--font-list': 'ui-monospace, monospace',
    ...Object.fromEntries(
      [1, 2, 3, 4, 5, 6, 7, 8].map((i) => [`--color-usage-${i}`, `#8${i}8${i}8${i}`]),
    ),
  },
};

test('a files-and-folders scheme becomes a recipe (var() resolved, series, monospace)', () => {
  const recipe = recipeFromFnf(FNF);
  assert.equal(recipe.palette.bg, '#202020');
  assert.equal(recipe.palette.text, '#d0d0d0');
  assert.equal(recipe.palette.red, '#ff8080');
  assert.equal(recipe.palette.selection, '#303848');
  assert.equal(recipe.palette.series.length, 8);
  assert.equal(recipe.fonts, 'mono');
});

test('the palette covers every colour token of styles.css', () => {
  const tokens = tokensFromPalette(recipeFromFnf(FNF).palette, true);
  assert.deepEqual(Object.keys(tokens).sort(), Object.keys(base.dark).sort());
});

test('a built scheme passes every pair and holds only what differs from its base', () => {
  const scheme = buildScheme(recipeFromFnf(FNF), base, pairs);
  assert.deepEqual(failures({ ...base.dark, ...scheme.tokens }, pairs), []);
  for (const [name, value] of Object.entries(scheme.tokens)) {
    if (!name.startsWith('--font-')) assert.notEqual(value, base.dark[name], name);
  }
  assert.match(scheme.tokens['--font-mono'], /monospace/);
});

test('the fit moves a weak foreground, and the background where the text is the reading colour', () => {
  const tokens = { ...base.dark, '--text-dim': '#3a3f47', '--row-selected': '#9aa8bf' };
  const fitted = fit(tokens, pairs);
  assert.ok(contrast(fitted['--text-dim'], fitted['--bg-panel']) >= 4.5);
  assert.equal(fitted['--text'], base.dark['--text']);
  assert.ok(contrast(fitted['--text'], fitted['--row-selected']) >= 4.5);
});

test('hand-set tokens are never moved: a failing one is an error', () => {
  const recipe = { ...recipeFromFnf(FNF), set: { '--text-dim': '#303030' } };
  assert.throws(() => buildScheme(recipe, base, pairs), /cannot fit/);
});

test('the scheme files are what the recipes make', () => {
  const recipes = JSON.parse(
    readFileSync(join(ROOT, 'scripts/theme-recipes.json'), 'utf8'),
  ).recipes;
  const files = new Map(readSchemes().map((s) => [s.id, s]));
  assert.equal(recipes.length, 15);
  for (const recipe of recipes) {
    assert.deepEqual(files.get(recipe.id), buildScheme(recipe, base, pairs), recipe.id);
  }
});

test('the contrast check names scheme, pair and value of a bad scheme', () => {
  const problems = checkAll({
    css: readStyles(),
    schemes: readSchemes(join(ROOT, 'scripts/fixtures/bad-scheme')),
    pairs,
  });
  assert.ok(
    problems.some((p) => /^bad: --text on --bg-app = 1\.\d\d \(below 4\.5\)$/.test(p)),
    problems.join('\n'),
  );
  assert.ok(problems.some((p) => p.startsWith('bad: --accent = url(')));
  assert.ok(problems.some((p) => p.startsWith('bad: --ge-table-bg')));
  assert.throws(() =>
    execFileSync(
      'node',
      [
        join(ROOT, 'scripts/check-contrast.mjs'),
        '--dir',
        join(ROOT, 'scripts/fixtures/bad-scheme'),
      ],
      {
        stdio: 'pipe',
      },
    ),
  );
});

test('all shipped schemes and styles.css pass', () => {
  assert.deepEqual(checkAll({ css: readStyles(), schemes: readSchemes(), pairs }), []);
});

test('the GuiExpert Table takes its colours from the scheme tokens only', () => {
  const css = readFileSync(join(ROOT, 'src/app/features/log-table/log-table-view.css'), 'utf8');
  const vars = [...css.matchAll(/(--ge-table-[\w-]+):\s*([^;]+);/g)];
  assert.ok(vars.length >= 10);
  for (const [, name, value] of vars) {
    assert.match(value.trim(), /^(var\(--[a-z0-9-]+\)|transparent)$/, name);
  }
});
