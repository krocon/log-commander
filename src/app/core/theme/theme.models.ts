/**
 * Colour schemes (prompt 020). A scheme is `{ id, name, dark, tokens }`: CSS values per token (`--bg-app` →
 * `#14171c`). Built-in schemes besides dark and light hold only what differs from the base of their brightness,
 * which `src/styles.css` defines.
 */
export interface Theme {
  /** `[a-z0-9-]`, e.g. `dark`, `one-dark`. */
  readonly id: string;
  readonly name: string;
  /** Dark scheme: `data-theme`, `color-scheme`, the base it is completed from. */
  readonly dark: boolean;
  readonly tokens: Readonly<Record<string, string>>;
}

export type ThemeMode = 'system' | 'fixed';

/** Which scheme is on: a fixed one, or one light and one dark scheme following the system. */
export interface ThemeSelection {
  readonly mode: ThemeMode;
  /** Scheme for `fixed`. */
  readonly theme: string;
  /** Schemes `system` uses on a light / dark system. */
  readonly light: string;
  readonly dark: string;
}

export const DEFAULT_SELECTION: ThemeSelection = {
  mode: 'system',
  theme: 'dark',
  light: 'light',
  dark: 'dark',
};

/**
 * The built-in schemes and whether each is dark, known without loading them (the schemes themselves are a lazy
 * chunk): the base and `data-theme` are right from the first frame. `builtin-themes.spec.ts` keeps it equal
 * to the scheme files.
 */
export const BUILT_IN_DARK: Readonly<Record<string, boolean>> = {
  dark: true,
  light: false,
  'one-dark': true,
  'one-dark-vivid': true,
  'true-dark': true,
  'true-black': true,
  'true-light': false,
  matrix: true,
  amber: true,
  'solarized-light': false,
  'mystico-c64': true,
  crimson: true,
  'rainglow-bold': true,
  'rainglow-earthsong': true,
  'rainglow-legacy': true,
  'rainglow-heroku': true,
  'rainglow-piggy': true,
};

/** The base schemes: their tokens are `styles.css` itself, nothing is set inline. */
export function isBaseTheme(id: string): boolean {
  return id === 'dark' || id === 'light';
}

const THEME_ID = /^[a-z0-9-]{1,64}$/;

/**
 * The stored selection, forgiving: a broken value falls back to the default, the old setting `theme`
 * (`system`/`dark`/`light`, before prompt 020) becomes following the system or a fixed base scheme.
 */
export function sanitizeSelection(saved: unknown, legacyTheme?: unknown): ThemeSelection {
  if (saved === undefined || saved === null) {
    if (legacyTheme === 'dark' || legacyTheme === 'light') {
      return { ...DEFAULT_SELECTION, mode: 'fixed', theme: legacyTheme };
    }
    return DEFAULT_SELECTION;
  }
  if (typeof saved !== 'object' || Array.isArray(saved)) return DEFAULT_SELECTION;
  const s = saved as Record<string, unknown>;
  const id = (value: unknown, fallback: string) =>
    typeof value === 'string' && THEME_ID.test(value) ? value : fallback;
  return {
    mode: s['mode'] === 'fixed' ? 'fixed' : 'system',
    theme: id(s['theme'], DEFAULT_SELECTION.theme),
    light: id(s['light'], DEFAULT_SELECTION.light),
    dark: id(s['dark'], DEFAULT_SELECTION.dark),
  };
}

/**
 * A plain colour as an own level colour may be: `#hex`, `rgb()`/`rgba()`, `hsl()`/`hsla()` with numbers only
 * (eager and small; the full parser of the schemes is `color.ts`).
 */
export function isColorLiteral(value: string): boolean {
  return /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(rgb|hsl)a?\([\d\s.,%/+-]{1,60}\))$/i.test(
    value.trim(),
  );
}

/** The scheme a selection shows on a light or dark system. */
export function selectedId(selection: ThemeSelection, systemDark: boolean): string {
  if (selection.mode === 'fixed') return selection.theme;
  return systemDark ? selection.dark : selection.light;
}
