#!/usr/bin/env node
// Builds what the site takes from the repository (run from the repository root: `node site/build.mjs`):
//   1. site/img/*.webp from docs/screenshots/**/*.png (1600 px wide, needs `cwebp` on the PATH),
//      site/favicon.png and site/img/icon.png from the app icon.
//   2. the shortcut rows in site/keyboard.html from the generated table in README.md.
// `--no-images` skips step 1.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = dirname(fileURLToPath(import.meta.url));
const root = join(site, '..');
const shots = join(root, 'docs', 'screenshots');
const img = join(site, 'img');

function images() {
  mkdirSync(join(img, 'schemes'), { recursive: true });
  let count = 0;
  let bytes = 0;
  for (const sub of ['', 'schemes']) {
    for (const file of readdirSync(join(shots, sub))) {
      if (!file.endsWith('.png')) continue;
      const out = join(img, sub, file.replace(/\.png$/, '.webp'));
      execFileSync('cwebp', ['-quiet', '-q', '82', '-sharp_yuv', '-resize', '1600', '0', join(shots, sub, file), '-o', out]);
      count += 1;
      bytes += statSync(out).size;
    }
  }
  copyFileSync(join(root, 'src-tauri', 'icons', '128x128@2x.png'), join(img, 'icon.png'));
  copyFileSync(join(root, 'src-tauri', 'icons', '64x64.png'), join(site, 'favicon.png'));
  console.log(`images: ${count} files, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Markdown of a table cell: `code` becomes <kbd> in the key column and <code> elsewhere. */
const cell = (s, tag) => esc(s).replace(/`([^`]+)`/g, `<${tag}>$1</${tag}>`);

function rows(markdown) {
  return markdown
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|\s*-+/.test(line) && !/^\|\s*Key\s*\|/.test(line))
    .map((line) => line.slice(1, line.lastIndexOf('|')).split(/(?<!\\)\|/).map((c) => c.trim()));
}

function keyboard() {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const main = readme.match(/<!-- keymap:start[^>]*-->([\s\S]*?)<!-- keymap:end -->/);
  if (!main) throw new Error('README.md: keymap markers not found');
  const html = rows(main[1])
    .map(([key, action]) => `            <tr><td>${cell(key, 'kbd')}</td><td>${cell(action, 'code')}</td></tr>`)
    .join('\n');
  const file = join(site, 'keyboard.html');
  if (!existsSync(file)) return;
  const page = readFileSync(file, 'utf8');
  const next = page.replace(
    /(<!-- keymap:start -->)[\s\S]*?(<!-- keymap:end -->)/,
    (_, a, b) => `${a}\n${html}\n            ${b}`,
  );
  if (next === page && !page.includes('<!-- keymap:start -->')) throw new Error('keyboard.html: markers not found');
  writeFileSync(file, next);
  console.log(`keyboard.html: ${rows(main[1]).length} shortcuts`);
}

if (!process.argv.includes('--no-images')) images();
keyboard();
