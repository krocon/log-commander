// Shared helpers of the colour scheme scripts (prompt 020): the @theme blocks of src/styles.css, the
// scheme files in src/app/core/theme/themes/, the contrast pairs and WCAG contrast. No dependencies.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT = new URL('..', import.meta.url).pathname;
export const THEME_DIR = join(ROOT, 'src/app/core/theme/themes');
const PAIRS_FILE = join(ROOT, 'src/app/core/theme/contrast-pairs.json');

/** `{ dark: {--token: #hex}, light: {...} }` from the marked blocks of a stylesheet. */
export function readBaseBlocks(css) {
  const blocks = [...css.matchAll(/\/\* @theme (\w+) \*\/([\s\S]*?)\/\* @end \*\//g)];
  const out = {};
  for (const [, name, body] of blocks) {
    out[name] = Object.fromEntries(
      [...body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [
        m[1],
        m[2].toLowerCase(),
      ]),
    );
  }
  return out;
}

export function readStyles() {
  return readFileSync(join(ROOT, 'src/styles.css'), 'utf8');
}

/** The contrast pairs `[fg, bg, min]` (text 4.5, graphics 3). */
export function readPairs() {
  return JSON.parse(readFileSync(PAIRS_FILE, 'utf8')).pairs;
}

/** All scheme files (`id` → parsed JSON). */
export function readSchemes(dir = THEME_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

/** Tokens of a scheme completed from the base of the same brightness. */
export function complete(scheme, base) {
  return { ...(scheme.dark ? base.dark : base.light), ...scheme.tokens };
}

/** `#rrggbb` or `var(--token)` resolved against `tokens`; `null` when it is no plain colour. */
export function resolve(tokens, name, seen = new Set()) {
  const raw = tokens[name];
  if (raw === undefined || seen.has(name)) return null;
  const ref = /^var\(\s*(--[a-z0-9-]+)\s*\)$/.exec(raw.trim());
  if (ref) return resolve(tokens, ref[1], new Set(seen).add(name));
  return /^#[0-9a-f]{6}$/i.test(raw.trim()) ? raw.trim().toLowerCase() : null;
}

export function rgb(hex) {
  const v = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
}

export function hex([r, g, b]) {
  return `#${[r, g, b]
    .map((c) =>
      Math.round(Math.min(255, Math.max(0, c)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

export function luminance(color) {
  const [r, g, b] = rgb(color).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `a` mixed with `b`, `t` = share of `b` (0–1). */
export function mix(a, b, t) {
  const [x, y] = [rgb(a), rgb(b)];
  return hex(x.map((c, i) => c + (y[i] - c) * t));
}

/** The failing pairs of complete tokens: `{ fg, bg, min, ratio }`; a missing colour has ratio `null`. */
export function failures(tokens, pairs) {
  const out = [];
  for (const [fg, bg, min] of pairs) {
    const a = resolve(tokens, fg);
    const b = resolve(tokens, bg);
    const ratio = a && b ? contrast(a, b) : null;
    if (ratio === null || ratio < min) out.push({ fg, bg, min, ratio });
  }
  return out;
}
