import { LEVELS, Level } from '../../core/log/log.models';

/** The six real levels from least to most severe. */
export const SEVERITIES: readonly Level[] = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

export const ALL_LEVELS: ReadonlySet<Level> = new Set(LEVELS);

export function toggleLevel(active: ReadonlySet<Level>, level: Level): Set<Level> {
  const next = new Set(active);
  if (!next.delete(level)) next.add(level);
  return next;
}

export function onlyLevel(level: Level): Set<Level> {
  return new Set([level]);
}

/** `WARN` → WARN, ERROR, FATAL. */
export function levelAndSevere(level: Level): Set<Level> {
  const from = SEVERITIES.indexOf(level);
  return from < 0 ? new Set([level]) : new Set(SEVERITIES.slice(from));
}

export function sameLevels(a: ReadonlySet<Level>, b: ReadonlySet<Level>): boolean {
  return a.size === b.size && [...a].every((level) => b.has(level));
}

const UNKNOWN_LABEL = 'Ohne Level';

/** Severity order, unknown last: `WARN, ERROR, FATAL`. */
export function describeLevels(levels: ReadonlySet<Level>): string {
  if (levels.size === 0) return 'Keine Level';
  const names: string[] = SEVERITIES.filter((level) => levels.has(level));
  if (levels.has('UNKNOWN')) names.push(UNKNOWN_LABEL);
  return names.join(', ');
}
