import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ACTIONS } from '../src/app/core/actions/action-catalog.ts';
import { README_TEXT, keymapTable, withTable } from './keymap-table.mjs';

test('the README table is the one the keymaps give', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.equal(
    withTable(readme),
    readme,
    'README.md differs from the keymaps: run node scripts/keymap-table.mjs',
  );
});

test('every action has a README text, and no text is left over', () => {
  assert.deepEqual(Object.keys(README_TEXT).sort(), ACTIONS.map((a) => a.id).sort());
});

test('shortcuts the same on every OS are written once, others per OS', () => {
  const table = keymapTable({
    macos: { OPEN_FILE: ['Mod+O'], NEXT_TAB: ['Ctrl+Tab'], CLOSE_TAB: ['Mod+W'] },
    windows: { OPEN_FILE: ['Mod+O'], NEXT_TAB: ['Mod+Tab'], CLOSE_TAB: ['Alt+W'] },
    linux: { OPEN_FILE: ['Mod+O'], NEXT_TAB: ['Mod+Tab'], CLOSE_TAB: ['Alt+W'] },
  });
  assert.match(table, /\| `Cmd\/Ctrl\+O` \| Open a file \|/);
  assert.match(table, /\| `Ctrl\+Tab` \| Next tab \|/);
  assert.match(table, /\| macOS `Cmd\+W`, Windows\/Linux `Alt\+W` \| Close the tab \|/);
  assert.match(table, /\| – \| Settings \|/);
});

test('a README without markers is an error, not a silent pass', () => {
  assert.throws(() => withTable('# no table'), /markers/);
});
