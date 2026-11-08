export type Platform = 'macos' | 'windows' | 'linux';

/** The OS the WebView runs on (navigator only, no backend call needed). */
export function detectPlatform(
  nav: Pick<Navigator, 'platform' | 'userAgent'> | undefined = globalThis.navigator,
): Platform {
  const text = `${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`;
  if (/Mac|iPhone|iPad/i.test(text)) return 'macos';
  if (/Win/i.test(text)) return 'windows';
  return 'linux';
}
