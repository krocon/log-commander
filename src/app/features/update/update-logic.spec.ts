import { CHECK_INTERVAL_MS, dueAtStart, hintVersion, resultText } from './update-logic';

const NOW = 1_800_000_000_000;

describe('dueAtStart', () => {
  it('never asks while switched off', () => {
    expect(dueAtStart({ checkAtStart: false, lastCheck: 0, dismissed: '' }, NOW)).toBe(false);
  });

  it('asks the first time and again after a day', () => {
    const on = { checkAtStart: true, dismissed: '' };
    expect(dueAtStart({ ...on, lastCheck: 0 }, NOW)).toBe(true);
    expect(dueAtStart({ ...on, lastCheck: NOW - CHECK_INTERVAL_MS + 1 }, NOW)).toBe(false);
    expect(dueAtStart({ ...on, lastCheck: NOW - CHECK_INTERVAL_MS }, NOW)).toBe(true);
  });

  it('asks when the last check lies in the future', () => {
    expect(dueAtStart({ checkAtStart: true, lastCheck: NOW + 1, dismissed: '' }, NOW)).toBe(true);
  });
});

describe('hintVersion', () => {
  const newer = { current: '1.0.0', latest: '1.1.0', newer: true };

  it('points to a newer version', () => {
    expect(hintVersion(newer, '', false)).toBe('1.1.0');
    expect(hintVersion({ ...newer, latest: '1.0.0', newer: false }, '', true)).toBeNull();
  });

  it('stays quiet at start about a dismissed version, not about the one after it', () => {
    expect(hintVersion(newer, '1.1.0', false)).toBeNull();
    expect(hintVersion({ ...newer, latest: '1.2.0' }, '1.1.0', false)).toBe('1.2.0');
  });

  it('shows a dismissed version again when asked by hand', () => {
    expect(hintVersion(newer, '1.1.0', true)).toBe('1.1.0');
  });
});

describe('resultText', () => {
  it('names both versions or says the app is current', () => {
    expect(resultText({ current: '1.0.0', latest: '1.1.0', newer: true })).toBe(
      'Version 1.1.0 ist verfügbar (installiert: 1.0.0)',
    );
    expect(resultText({ current: '1.1.0', latest: '1.1.0', newer: false })).toBe(
      'Log Commander 1.1.0 ist aktuell',
    );
  });
});
