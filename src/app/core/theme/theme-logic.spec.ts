import { describe, expect, it } from 'vitest';
import { contrastRatio, parseColor } from './color';
import {
  checkContrast,
  diffTokens,
  isSafeValue,
  resolveColor,
  sanitizeTokens,
  tokenValueOk,
} from './theme-logic';
import { DARK } from './builtin-themes';
import { isColorLiteral } from './theme.models';

describe('theme values', () => {
  it('parses plain colours only', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#14171c')).toEqual({ r: 20, g: 23, b: 28, a: 1 });
    expect(parseColor('rgb(1 2 3 / 50%)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
    expect(parseColor('rgba(1, 2, 3, 0.25)')?.a).toBe(0.25);
    expect(parseColor('hsl(0 100% 50%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    for (const bad of [
      'red',
      '#12',
      'rgb(1 2)',
      'rgb(url(x) 1 2)',
      'hsl(1 2 3)',
      'rgb(1deg 2 3)',
    ]) {
      expect(parseColor(bad), bad).toBeNull();
    }
  });

  it('refuses hostile values for every kind of token', () => {
    const hostile = [
      'red; background: url(https://evil)',
      '#fff}html{display:none',
      'url(https://evil/x.png)',
      'expression(alert(1))',
      'image-set("x.png" 1x)',
      'var(--x, url(y))',
      'var(--not-a-token)',
      'attr(data-x)',
      '<script>',
      '#fff\\9',
      '@import "x"',
      'x'.repeat(300),
      '',
    ];
    for (const value of hostile) {
      expect(tokenValueOk('--bg-app', value), value).toBe(false);
      expect(tokenValueOk('--font-mono', value), value).toBe(false);
      expect(isColorLiteral(value), value).toBe(false);
    }
    expect(isSafeValue('#123456')).toBe(true);
    expect(tokenValueOk('--bg-app', 'var(--bg-panel)')).toBe(true);
    expect(tokenValueOk('--bg-app', 'var(--font-ui)')).toBe(false);
    expect(tokenValueOk('--font-ui', "Menlo, 'DejaVu Sans Mono', monospace")).toBe(true);
    expect(tokenValueOk('--font-ui', '#fff')).toBe(false);
    expect(tokenValueOk('--radius', '5px')).toBe(false);
    expect(tokenValueOk('--ge-table-bg', '#fff')).toBe(false);
  });

  it('keeps valid catalog tokens and says what it dropped', () => {
    const { tokens, dropped } = sanitizeTokens({
      '--bg-app': ' #000000 ',
      '--text': 'url(x)',
      '--unknown': '#fff',
      '--accent': 7,
    });
    expect(tokens).toEqual({ '--bg-app': '#000000' });
    expect(dropped.sort()).toEqual(['--accent', '--text', '--unknown']);
    expect(sanitizeTokens('nope')).toEqual({ tokens: {}, dropped: [] });
  });

  it('resolves var() chains and stops at cycles', () => {
    const tokens = {
      '--bg-app': 'var(--bg-panel)',
      '--bg-panel': '#102030',
      '--text': 'var(--text)',
    };
    expect(resolveColor('--bg-app', tokens)).toEqual({ r: 16, g: 32, b: 48, a: 1 });
    expect(resolveColor('--text', tokens)).toBeNull();
  });

  it('stores only what differs from the base', () => {
    expect(
      diffTokens({ '--bg-app': DARK.tokens['--bg-app'], '--text': '#ffffff' }, DARK.tokens),
    ).toEqual({ '--text': '#ffffff' });
  });

  it('finds failing contrast pairs', () => {
    const bad = { ...DARK.tokens, '--text': '#20232a' };
    const failed = checkContrast(bad).filter((r) => !r.ok);
    expect(failed.some((r) => r.pair.fg === '--text' && r.pair.bg === '--bg-app')).toBe(true);
    expect(contrastRatio(parseColor('#000')!, parseColor('#fff')!)).toBeCloseTo(21);
  });
});
