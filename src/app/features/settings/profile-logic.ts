import { LEVELS, Level, Profile } from '../../core/log/log.models';

/** `OOPS=FATAL` per line → mapping. Returns the first bad line instead of guessing. */
export function parseMapping(
  text: string,
): { mapping: Partial<Record<string, Level>> } | { error: string } {
  const mapping: Partial<Record<string, Level>> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const [word, level] = line.split('=').map((part) => part.trim());
    const upper = level?.toUpperCase() as Level | undefined;
    if (!word || !upper || !LEVELS.includes(upper)) {
      return { error: `Zeile „${line}“: erwartet WORT=LEVEL (${LEVELS.join(', ')})` };
    }
    mapping[word] = upper;
  }
  return { mapping };
}

export function formatMapping(mapping: Profile['mapping']): string {
  return Object.entries(mapping ?? {})
    .map(([word, level]) => `${word}=${level}`)
    .join('\n');
}

export function newProfileId(existing: readonly Profile[]): string {
  let n = existing.length + 1;
  while (existing.some((p) => p.id === `custom-${n}`)) n++;
  return `custom-${n}`;
}
