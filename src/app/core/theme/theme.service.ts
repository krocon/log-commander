import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import { LogApi } from '../log/log-api';
import { SettingsService } from '../settings/settings.service';
import {
  BUILT_IN_DARK,
  Theme,
  ThemeSelection,
  isBaseTheme,
  isColorLiteral,
  sanitizeSelection,
  selectedId,
} from './theme.models';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** What the lazy chunk of the schemes provides. */
export interface ThemeCatalog {
  readonly themes: readonly Theme[];
  /** Whether a token may be put on `<html>` with this value (catalog token, value of its kind). */
  readonly applicable: (name: string, value: string) => boolean;
}

/** dark and light before the schemes are loaded: their tokens are `styles.css` itself. */
const BASE_STUB: Readonly<Record<'dark' | 'light', Theme>> = {
  dark: { id: 'dark', name: 'Dunkel', dark: true, tokens: {} },
  light: { id: 'light', name: 'Hell', dark: false, tokens: {} },
};

/**
 * Colour schemes (prompt 020): the selection (fixed, or following the system with a light and a dark scheme),
 * the live preview of the picker, and putting the scheme on screen: tokens inline on `<html>` (only what
 * differs from `styles.css`), `data-theme`, `color-scheme`, `meta theme-color`, the own level colours
 * (`colorOverrides`) on top, and the native window frame. The schemes themselves load on demand; dark and
 * light need nothing loaded. Canvas parts (ruler, timeline, dashboard) repaint through a MutationObserver on
 * `data-theme` and `style` of `<html>`, which every change here touches.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly settingsService = inject(SettingsService);
  private readonly api = inject(LogApi);

  readonly selection = computed<ThemeSelection>(() =>
    sanitizeSelection(this.settingsService.settings().themeSelection),
  );
  /** `prefers-color-scheme: dark`, live. */
  readonly systemDark = signal(false);
  /** A scheme tried in the picker, shown instead of the active one. */
  readonly preview = signal<Theme | null>(null);
  /** The built-in schemes, once loaded (`loadCatalog`). */
  readonly catalog = signal<ThemeCatalog | null>(null);
  /** The picker dialog (toolbar, menu, `Cmd/Ctrl+Alt+T`). */
  readonly pickerOpen = signal(false);

  readonly activeId = computed(() => selectedId(this.selection(), this.systemDark()));

  /** The active scheme; an unknown id falls back to the base of its brightness. `null` = still loading. */
  readonly active = computed<Theme | null>(() => {
    const id = this.activeId();
    const catalog = this.catalog();
    const dark = BUILT_IN_DARK[id] ?? this.systemDark();
    if (catalog) {
      return catalog.themes.find((t) => t.id === id) ?? this.base(dark);
    }
    return isBaseTheme(id) || this.failed() ? this.base(dark) : null;
  });

  /** What is on screen: the preview or the active scheme (`null` while its colours load). */
  readonly applied = computed<Theme | null>(() => this.preview() ?? this.active());

  private readonly failed = signal(false);
  private loading: Promise<ThemeCatalog | null> | null = null;
  private appliedNames = new Set<string>();
  /** Last frame sent to Rust (`color|dark`). */
  private chrome = '';

  constructor() {
    const media = typeof matchMedia === 'function' ? matchMedia(DARK_QUERY) : null;
    if (media) {
      this.systemDark.set(media.matches);
      const onChange = (e: MediaQueryListEvent) => this.systemDark.set(e.matches);
      media.addEventListener?.('change', onChange);
      inject(DestroyRef).onDestroy(() => media.removeEventListener?.('change', onChange));
    }
    effect(() => {
      const theme = this.applied();
      const overrides = this.settingsService.settings().colorOverrides;
      if (!theme) {
        void this.loadCatalog();
        return;
      }
      this.apply(theme, overrides);
      // The window stays hidden until the stored scheme is on (no flash of the default scheme).
      if (this.settingsService.loaded()) this.applyWindowChrome(theme);
    });
  }

  /** Loads the built-in schemes (once); resolves with them, `null` if the chunk failed. */
  loadCatalog(): Promise<ThemeCatalog | null> {
    this.loading ??= Promise.all([import('./builtin-themes'), import('./theme-logic')])
      .then(([themes, logic]) => {
        const catalog: ThemeCatalog = {
          themes: themes.BUILT_IN_THEMES,
          applicable: logic.applicableToken,
        };
        this.catalog.set(catalog);
        return catalog;
      })
      .catch((e) => {
        console.warn('colour schemes could not be loaded', e);
        this.failed.set(true);
        return null;
      });
    return this.loading;
  }

  find(id: string): Theme | undefined {
    return this.catalog()?.themes.find((t) => t.id === id);
  }

  /** A fixed scheme. */
  select(id: string): void {
    this.setSelection({ ...this.selection(), mode: 'fixed', theme: id });
  }

  /** Follow `prefers-color-scheme`, optionally with another light or dark scheme. */
  followSystem(pair: { light?: string; dark?: string } = {}): void {
    const s = this.selection();
    this.setSelection({
      ...s,
      mode: 'system',
      light: pair.light ?? s.light,
      dark: pair.dark ?? s.dark,
    });
  }

  private setSelection(selection: ThemeSelection): void {
    this.settingsService.update({ themeSelection: sanitizeSelection(selection) });
  }

  private base(dark: boolean): Theme {
    const id = dark ? 'dark' : 'light';
    return this.catalog()?.themes.find((t) => t.id === id) ?? BASE_STUB[id];
  }

  private apply(theme: Theme, overrides: Readonly<Record<string, string>>): void {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const catalog = this.catalog();
    const values = new Map<string, string>();
    // dark and light are styles.css itself; other schemes only differ from it, and only catalog tokens
    // with a value of their kind get through
    if (!isBaseTheme(theme.id) && catalog) {
      for (const [name, value] of Object.entries(theme.tokens)) {
        if (catalog.applicable(name, value)) values.set(name, value.trim());
      }
    }
    // own level colours lie over every scheme, also in the preview
    for (const [token, value] of Object.entries(overrides)) {
      if (/^lv-[a-z-]+$/.test(token) && typeof value === 'string' && isColorLiteral(value)) {
        values.set(`--${token}`, value.trim());
      }
    }
    for (const name of this.appliedNames) {
      if (!values.has(name)) root.style.removeProperty(name);
    }
    for (const [name, value] of values) root.style.setProperty(name, value);
    this.appliedNames = new Set(values.keys());
    root.dataset['theme'] = theme.dark ? 'dark' : 'light';
    root.style.colorScheme = theme.dark ? 'dark' : 'light';
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
    }
    meta.content = this.backgroundHex() ?? (theme.dark ? '#14171c' : '#fbfbfc');
  }

  /** `--bg-app` as painted now (schemes and styles.css hold it as `#rrggbb`). */
  private backgroundHex(): string | null {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim();
    return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
  }

  /**
   * The native frame: background `--bg-app`, appearance of the scheme. Following the system, the appearance is
   * left to the system: it also sets the webview's `prefers-color-scheme`, and a forced one would no longer
   * follow the system (the scheme follows the same system, so frame and scheme still match).
   */
  private applyWindowChrome(theme: Theme): void {
    const color = this.backgroundHex();
    if (!color) return;
    const dark = this.selection().mode === 'system' ? null : theme.dark;
    const key = `${color}|${dark}`;
    if (key === this.chrome) return;
    this.chrome = key;
    // no backend (browser, tests): the frame keeps the system colours
    this.api.setWindowChrome(color, dark).catch(() => undefined);
  }
}
