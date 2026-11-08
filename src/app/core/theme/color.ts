/**
 * Colour values of schemes and own level colours (prompt 020): parsing, WCAG contrast. Pure functions, no DOM.
 * Only plain colour syntax is a colour: `#rgb`, `#rrggbb` (with alpha), `rgb()`/`rgba()`, `hsl()`/`hsla()`.
 */
export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** 0–1 */
  readonly a: number;
}

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/;
const FUNC = /^(rgba?|hsla?)\(([-+0-9.%\s,/a-z]*)\)$/;
const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)(%|deg)?$/;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The colour of a plain colour value, else `null` (also for anything longer than 64 characters). */
export function parseColor(input: string): Rgba | null {
  const v = input.trim().toLowerCase();
  if (v.length > 64) return null;
  const hex = HEX.exec(v);
  if (hex) {
    let h = hex[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  const fn = FUNC.exec(v);
  if (!fn) return null;
  const [body, alphaPart] = fn[2].includes('/') ? fn[2].split('/') : [fn[2], undefined];
  let parts = body.split(/[\s,]+/).filter(Boolean);
  let alpha = alphaPart?.trim();
  if (alpha === undefined && parts.length === 4) {
    alpha = parts[3];
    parts = parts.slice(0, 3);
  }
  if (parts.length !== 3 || !parts.every((p) => NUMBER.test(p))) return null;
  if (alpha !== undefined && !/^(\d+\.?\d*|\.\d+)%?$/.test(alpha)) return null;
  const a =
    alpha === undefined ? 1 : clamp(parseFloat(alpha) / (alpha.endsWith('%') ? 100 : 1), 0, 1);
  const num = parts.map((p) => parseFloat(p));
  if (fn[1].startsWith('rgb')) {
    if (parts.some((p) => p.endsWith('deg'))) return null;
    const [r, g, b] = parts.map((p, i) => (p.endsWith('%') ? (num[i] * 255) / 100 : num[i]));
    return {
      r: clamp(Math.round(r), 0, 255),
      g: clamp(Math.round(g), 0, 255),
      b: clamp(Math.round(b), 0, 255),
      a,
    };
  }
  if (parts[0].endsWith('%') || !parts[1].endsWith('%') || !parts[2].endsWith('%')) return null;
  return { ...hslToRgb(num[0], clamp(num[1], 0, 100) / 100, clamp(num[2], 0, 100) / 100), a };
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const k = (n: number) => (n + (((h % 360) + 360) % 360) / 30) % 12;
  const f = (n: number) =>
    l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255) };
}

/** `fg` painted over an opaque `bg`. */
export function blend(fg: Rgba, bg: Rgba): Rgba {
  const mix = (f: number, b: number) => Math.round(f * fg.a + b * (1 - fg.a));
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 };
}

/** WCAG 2.x relative luminance of an opaque colour. */
export function luminance(c: Rgba): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** Contrast ratio (1–21); translucent colours are painted on `base` (bg first, then fg on it). */
export function contrastRatio(fg: Rgba, bg: Rgba, base: Rgba = WHITE): number {
  const back = bg.a < 1 ? blend(bg, base) : bg;
  const front = fg.a < 1 ? blend(fg, back) : fg;
  const [l1, l2] = [luminance(front), luminance(back)];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

/** `#rrggbb` (alpha dropped). */
export function toHex(c: Rgba): string {
  const h = (v: number) => v.toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}
