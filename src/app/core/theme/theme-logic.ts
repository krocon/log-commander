import { contrastRatio, parseColor, Rgba, WHITE } from './color';
import pairsJson from './contrast-pairs.json';
import { Theme } from './theme.models';
import { TOKEN_NAMES, tokenDef } from './tokens';

/**
 * Pure scheme logic (prompt 020, after files-and-folders): checking values, resolving `var()` chains,
 * completing a scheme from its base, the differences to it and the WCAG contrast pairs.
 */

export const MAX_VALUE_LEN = 200;
export const MAX_TOKENS = 300;

const TOKEN_NAME = /^--[a-z0-9-]{1,78}$/;
const BAD_FUNCS = ['url(', 'expression(', 'image(', 'image-set(', 'element(', 'attr(', 'env('];

/** A harmless CSS value: short, no `; { } < > \ @`, no control characters, nothing that loads resources. */
export function isSafeValue(value: string): boolean {
  const v = value.trim();
  if (!v || [...v].length > MAX_VALUE_LEN) return false;
  // eslint-disable-next-line no-control-regex
  if (/[;{}<>\\@\u0000-\u001f\u007f-\u009f]/.test(v)) return false;
  const lower = v.toLowerCase();
  return !BAD_FUNCS.some((f) => lower.includes(f));
}

/** `var(--name)` of a catalog colour token, without fallback. */
function colorRef(v: string): string | null {
  const m = /^var\(\s*(--[a-z0-9-]+)\s*\)$/.exec(v);
  return m && TOKEN_NAMES.has(m[1]) && tokenDef(m[1])?.kind === 'color' ? m[1] : null;
}

/** One font family name (letters, digits, space, `_`, `-`; quoted or not). */
function fontFamily(raw: string): boolean {
  const f = raw.trim();
  const quoted = f.length >= 2 && /^(['"]).*\1$/su.test(f);
  const name = quoted ? f.slice(1, -1) : f;
  return (
    (quoted ? /^[\p{L}\p{N}]/u : /^\p{L}/u).test(name) &&
    [...name].length <= 60 &&
    /^[\p{L}\p{N} _-]*$/u.test(name)
  );
}

/** A catalog token with a value of its kind: colours as plain colour or `var()` of a colour token, fonts as names. */
export function tokenValueOk(name: string, value: string): boolean {
  const v = value.trim();
  if (!TOKEN_NAME.test(name) || !isSafeValue(v)) return false;
  const def = tokenDef(name);
  if (!def) return false;
  if (def.kind === 'font') {
    const families = v.split(',');
    return families.length <= 12 && families.every(fontFamily);
  }
  return parseColor(v) !== null || colorRef(v) !== null;
}

/** What may be put on `<html>`. */
export const applicableToken = tokenValueOk;

/** The value of a token after following `var(--x)` chains; `null` on cycles or missing tokens. */
export function resolveValue(
  name: string,
  tokens: Readonly<Record<string, string>>,
  seen: ReadonlySet<string> = new Set(),
): string | null {
  const raw = tokens[name];
  if (raw === undefined || seen.has(name)) return null;
  const ref = colorRef(raw.trim());
  return ref ? resolveValue(ref, tokens, new Set(seen).add(name)) : raw.trim();
}

export function resolveColor(name: string, tokens: Readonly<Record<string, string>>): Rgba | null {
  const v = resolveValue(name, tokens);
  return v === null ? null : parseColor(v);
}

/** The base of the same brightness, overlaid with the scheme's own tokens. */
export function completeTokens(
  theme: Pick<Theme, 'tokens' | 'dark'>,
  light: Theme,
  dark: Theme,
): Record<string, string> {
  return { ...(theme.dark ? dark : light).tokens, ...theme.tokens };
}

/** Only the tokens that differ from the base (what a scheme stores). */
export function diffTokens(
  tokens: Readonly<Record<string, string>>,
  base: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tokens)) {
    if (base[k] !== v) out[k] = v;
  }
  return out;
}

/** Keeps catalog tokens with valid values (at most {@link MAX_TOKENS}); returns the names it dropped. */
export function sanitizeTokens(raw: unknown): {
  tokens: Record<string, string>;
  dropped: string[];
} {
  const tokens: Record<string, string> = {};
  const dropped: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { tokens, dropped };
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && tokenValueOk(k, v) && Object.keys(tokens).length < MAX_TOKENS) {
      tokens[k] = v.trim();
    } else {
      dropped.push(k);
    }
  }
  return { tokens, dropped };
}

// ---- contrast ----

export interface ContrastPair {
  readonly fg: string;
  readonly bg: string;
  /** 4.5 for text, 3 for graphics (WCAG 1.4.3 / 1.4.11). */
  readonly min: number;
}

/** The pairs every scheme passes; the same file `scripts/check-contrast.mjs` reads. */
export const CONTRAST_PAIRS: readonly ContrastPair[] = (
  pairsJson.pairs as [string, string, number][]
).map(([fg, bg, min]) => ({ fg, bg, min }));

export interface ContrastResult {
  readonly pair: ContrastPair;
  /** `null` = a colour could not be resolved. */
  readonly ratio: number | null;
  readonly ok: boolean;
}

/** All pairs on the complete tokens of a scheme; translucent colours are painted on `--bg-app`. */
export function checkContrast(tokens: Readonly<Record<string, string>>): ContrastResult[] {
  const app = resolveColor('--bg-app', tokens) ?? WHITE;
  return CONTRAST_PAIRS.map((pair) => {
    const fg = resolveColor(pair.fg, tokens);
    const bg = resolveColor(pair.bg, tokens);
    const ratio = fg && bg ? contrastRatio(fg, bg, app.a < 1 ? WHITE : app) : null;
    return { pair, ratio, ok: ratio !== null && ratio >= pair.min };
  });
}
