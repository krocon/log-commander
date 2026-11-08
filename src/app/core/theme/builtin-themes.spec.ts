import { describe, expect, it } from 'vitest';
import { BUILT_IN_THEMES, DARK, LIGHT } from './builtin-themes';
import { checkContrast, completeTokens, tokenValueOk } from './theme-logic';
import { BUILT_IN_DARK } from './theme.models';
import { TOKENS, tokenDef } from './tokens';

describe('built-in colour schemes', () => {
  it('has the 15 schemes after files-and-folders besides dark and light, ids unique', () => {
    const ids = BUILT_IN_THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(17);
  });

  it('knows each scheme and its brightness without loading them', () => {
    expect(Object.fromEntries(BUILT_IN_THEMES.map((t) => [t.id, t.dark]))).toEqual(BUILT_IN_DARK);
  });

  it('catalogs exactly the colour tokens of styles.css (dark.json = styles.css: npm run contrast)', () => {
    const colors = TOKENS.filter((t) => t.kind === 'color').map((t) => t.name);
    expect([...colors].sort()).toEqual(Object.keys(DARK.tokens).sort());
    expect([...colors].sort()).toEqual(Object.keys(LIGHT.tokens).sort());
    expect(new Set(TOKENS.map((t) => t.name)).size).toBe(TOKENS.length);
  });

  for (const theme of BUILT_IN_THEMES) {
    it(`${theme.id}: catalog tokens only, valid values, complete, every contrast pair`, () => {
      for (const [name, value] of Object.entries(theme.tokens)) {
        expect(tokenDef(name), name).toBeDefined();
        expect(tokenValueOk(name, value), `${name}: ${value}`).toBe(true);
      }
      const tokens = completeTokens(theme, LIGHT, DARK);
      for (const def of TOKENS.filter((t) => t.kind === 'color')) {
        expect(tokens[def.name], def.name).toMatch(/^#[0-9a-f]{6}$/);
      }
      const failed = checkContrast(tokens)
        .filter((r) => !r.ok)
        .map((r) => `${r.pair.fg} on ${r.pair.bg} = ${r.ratio?.toFixed(2)}`);
      expect(failed).toEqual([]);
    });
  }
});
