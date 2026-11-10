import { describe, expect, it } from 'vitest';
import { chartErrorText, isLanguageTag, retryingLoader, withUsableLanguage } from './chart-loader';

describe('isLanguageTag', () => {
  it('accepts language tags', () => {
    expect(isLanguageTag('de-DE')).toBe(true);
    expect(isLanguageTag('en')).toBe(true);
  });

  it('refuses what WebKitGTK reports for LANG=C.UTF-8 and other non-tags', () => {
    expect(isLanguageTag('C')).toBe(false);
    expect(isLanguageTag('C.UTF-8')).toBe(false);
    expect(isLanguageTag('en_US')).toBe(false);
    expect(isLanguageTag('')).toBe(false);
    expect(isLanguageTag(undefined)).toBe(false);
  });
});

describe('withUsableLanguage', () => {
  /** What uPlot does while its module is evaluated. */
  const likeUPlot = (nav: { language: string }) => async () =>
    new Intl.NumberFormat(nav.language).format(1);

  it('fails without the guard on an invalid language (the bug)', async () => {
    const nav = { language: 'C' };
    await expect(likeUPlot(nav)()).rejects.toBeInstanceOf(RangeError);
  });

  it('loads with a fallback and puts the language back', async () => {
    const proto = { language: 'C' };
    const nav = Object.create(proto) as { language: string };
    let seen = '';
    const result = await withUsableLanguage(async () => {
      seen = nav.language;
      return likeUPlot(nav)();
    }, nav);
    expect(result).toBe('1');
    expect(seen).toBe('en-US');
    expect(nav.language).toBe('C');
    expect(Object.hasOwn(nav, 'language')).toBe(false);
  });

  it('leaves a valid language alone', async () => {
    const nav = { language: 'de-DE' };
    let seen = '';
    await withUsableLanguage(async () => {
      seen = nav.language;
    }, nav);
    expect(seen).toBe('de-DE');
  });

  it('puts the language back when the load fails', async () => {
    const nav = Object.create({ language: 'C' }) as { language: string };
    await expect(
      withUsableLanguage(async () => {
        throw new Error('no chunk');
      }, nav),
    ).rejects.toThrow('no chunk');
    expect(nav.language).toBe('C');
  });

  it('still reports the failure where the language cannot be replaced', async () => {
    const nav = Object.freeze({ language: 'C' });
    await expect(withUsableLanguage(likeUPlot(nav), nav)).rejects.toBeInstanceOf(RangeError);
  });
});

describe('retryingLoader', () => {
  it('loads once', async () => {
    let calls = 0;
    const load = retryingLoader(async () => ++calls);
    expect(await load()).toBe(1);
    expect(await load()).toBe(1);
    expect(calls).toBe(1);
  });

  it('tries again after a failure', async () => {
    let calls = 0;
    const load = retryingLoader(async () => {
      if (++calls === 1) throw new Error('first');
      return calls;
    });
    await expect(load()).rejects.toThrow('first');
    expect(await load()).toBe(2);
    expect(await load()).toBe(2);
  });
});

describe('chartErrorText', () => {
  it('names the cause', () => {
    expect(chartErrorText(new RangeError('Incorrect locale'))).toBe(
      'Das Diagramm kann nicht gezeichnet werden: Incorrect locale',
    );
    expect(chartErrorText('x')).toBe('Das Diagramm kann nicht gezeichnet werden: x');
  });
});
