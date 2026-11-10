import type uPlot from 'uplot';

export type UPlotCtor = typeof uPlot;

/** Whether `Intl` accepts the tag. WebKitGTK reports `C` for `LANG=C.UTF-8`, which is no language tag. */
export function isLanguageTag(language: unknown): boolean {
  if (typeof language !== 'string' || language === '') return false;
  try {
    return Intl.NumberFormat.supportedLocalesOf(language) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Runs `load` with a `navigator.language` that `Intl` accepts. uPlot builds a number format from it while its
 * module is evaluated and throws a RangeError on an invalid tag: then no chart would ever be drawn. The app
 * formats all numbers itself, so the fallback only has to be valid. The property is put back afterwards.
 */
export async function withUsableLanguage<T>(
  load: () => Promise<T>,
  nav: object = navigator,
  fallback = 'en-US',
): Promise<T> {
  if (isLanguageTag((nav as { language?: unknown }).language)) return load();
  let patched = false;
  try {
    Object.defineProperty(nav, 'language', { value: fallback, configurable: true });
    patched = true;
  } catch {
    // Not overridable here: the import fails and the chart shows the error.
  }
  try {
    return await load();
  } finally {
    // Removing the own property brings back the getter of the prototype.
    if (patched) delete (nav as { language?: unknown }).language;
  }
}

/** Loads once and keeps the result; a failed load is forgotten, so the next chart tries again. */
export function retryingLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let loading: Promise<T> | null = null;
  return () => {
    loading ??= load().catch((error: unknown) => {
      loading = null;
      throw error;
    });
    return loading;
  };
}

/** uPlot is loaded on first use, in its own chunk: the start of the app does not pay for it. */
export const loadUPlot: () => Promise<UPlotCtor> = retryingLoader(() =>
  withUsableLanguage(() => import('uplot').then((m) => m.default)),
);

/** Text for the panel when a chart cannot be drawn. */
export function chartErrorText(error: unknown): string {
  const detail = error instanceof Error ? error.message || error.name : String(error);
  return `Das Diagramm kann nicht gezeichnet werden: ${detail}`;
}
