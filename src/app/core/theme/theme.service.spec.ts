import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LogApi } from '../log/log-api';
import { SettingsService } from '../settings/settings.service';
import { BUILT_IN_THEMES } from './builtin-themes';
import { ThemeService } from './theme.service';

/** A controllable `prefers-color-scheme: dark`. */
function fakeMedia(dark: boolean) {
  const listeners: ((e: { matches: boolean }) => void)[] = [];
  const media = {
    matches: dark,
    addEventListener: (_: string, l: (e: { matches: boolean }) => void) => listeners.push(l),
    removeEventListener: () => undefined,
  };
  (globalThis as unknown as { matchMedia: unknown }).matchMedia = () => media;
  return (next: boolean) => {
    media.matches = next;
    for (const l of listeners) l({ matches: next });
  };
}

const root = () => document.documentElement;
const inline = (name: string) => root().style.getPropertyValue(name);
const scheme = (id: string) => BUILT_IN_THEMES.find((t) => t.id === id)!;

describe('ThemeService', () => {
  let chrome: ReturnType<typeof vi.fn>;
  let setSystem: (dark: boolean) => void;

  async function create(dark = true) {
    setSystem = fakeMedia(dark);
    chrome = vi.fn(() => Promise.resolve());
    TestBed.configureTestingModule({
      providers: [{ provide: LogApi, useValue: { setWindowChrome: chrome } }],
    });
    const settings = TestBed.inject(SettingsService);
    const theme = TestBed.inject(ThemeService);
    await theme.loadCatalog();
    TestBed.tick();
    return { settings, theme };
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
    root().removeAttribute('style');
    delete root().dataset['theme'];
  });

  it('follows the system by default: dark and light from styles.css, nothing inline', async () => {
    const { theme } = await create(true);
    expect(theme.activeId()).toBe('dark');
    expect(root().dataset['theme']).toBe('dark');
    expect(root().style.length).toBe(1); // color-scheme only
    setSystem(false);
    TestBed.tick();
    expect(theme.activeId()).toBe('light');
    expect(root().dataset['theme']).toBe('light');
    expect(root().style.colorScheme).toBe('light');
  });

  it('follows the system with an own pair of schemes', async () => {
    const { theme } = await create(true);
    theme.followSystem({ light: 'solarized-light', dark: 'matrix' });
    TestBed.tick();
    expect(inline('--bg-app')).toBe(scheme('matrix').tokens['--bg-app']);
    expect(inline('--font-mono')).toContain('monospace');
    setSystem(false);
    TestBed.tick();
    expect(root().dataset['theme']).toBe('light');
    expect(inline('--bg-app')).toBe(scheme('solarized-light').tokens['--bg-app']);
    // Matrix's own fonts are gone again
    expect(inline('--font-mono')).toBe('');
  });

  it('puts a fixed scheme inline and removes the tokens of the scheme before', async () => {
    const { theme, settings } = await create(false);
    theme.select('one-dark');
    TestBed.tick();
    expect(settings.settings().themeSelection.mode).toBe('fixed');
    expect(root().dataset['theme']).toBe('dark');
    for (const [name, value] of Object.entries(scheme('one-dark').tokens)) {
      expect(inline(name), name).toBe(value);
    }
    theme.select('dark');
    TestBed.tick();
    expect(root().style.length).toBe(1);
  });

  it('shows a preview and goes back to the active scheme', async () => {
    const { theme } = await create(true);
    theme.preview.set(scheme('true-light'));
    TestBed.tick();
    expect(root().dataset['theme']).toBe('light');
    expect(inline('--bg-app')).toBe(scheme('true-light').tokens['--bg-app']);
    theme.preview.set(null);
    TestBed.tick();
    expect(root().dataset['theme']).toBe('dark');
    expect(inline('--bg-app')).toBe('');
  });

  it('lays own level colours over every scheme, also the preview; unsafe values never get in', async () => {
    const { theme, settings } = await create(true);
    settings.update({ colorOverrides: { 'lv-error-fg': '#00ff00' } });
    theme.select('one-dark');
    TestBed.tick();
    expect(inline('--lv-error-fg')).toBe('#00ff00');
    theme.preview.set(scheme('amber'));
    TestBed.tick();
    expect(inline('--lv-error-fg')).toBe('#00ff00');
    settings.settings.update((s) => ({
      ...s,
      colorOverrides: { 'lv-error-fg': 'red;x:url(y)', 'bg-app': '#000000' },
    }));
    TestBed.tick();
    expect(inline('--lv-error-fg')).toBe(scheme('amber').tokens['--lv-error-fg']);
    expect(inline('--bg-app')).toBe(scheme('amber').tokens['--bg-app']);
  });

  it('falls back to the base for an unknown scheme', async () => {
    const { theme } = await create(false);
    theme.select('gone-away');
    TestBed.tick();
    expect(theme.active()?.id).toBe('light');
  });

  it('sets the window frame once the settings are loaded, forced only for a fixed scheme', async () => {
    const { theme, settings } = await create(true);
    theme.select('one-dark');
    TestBed.tick();
    expect(chrome).not.toHaveBeenCalled();
    await settings.load();
    TestBed.tick();
    theme.select('true-light');
    TestBed.tick();
    expect(chrome).toHaveBeenLastCalledWith(scheme('true-light').tokens['--bg-app'], false);
    theme.followSystem({ dark: 'one-dark' });
    TestBed.tick();
    expect(chrome).toHaveBeenLastCalledWith(scheme('one-dark').tokens['--bg-app'], null);
  });
});
