import { ColumnSet, Profile } from '../../core/log/log.models';

/** Below this share of fitting lines the format counts as only partly recognised. */
export const MIN_CONFIDENCE = 0.8;

/** Whether an answer of `getColumns` is newer than what the session has (answers can overtake). */
export function isNewerColumns(current: ColumnSet | null, next: ColumnSet): boolean {
  return !current || next.revision > current.revision;
}

/** „Log4j / Logback / Spring Boot · 97 %“: which format splits the lines, and how well. */
export function formatSummary(
  columns: ColumnSet | null,
  profiles: readonly Profile[],
): string | null {
  if (!columns) return null;
  if (columns.confidence === 0) return 'Format nicht erkannt, nur Nachricht';
  const name = columns.inferredLayout
    ? 'Erkanntes Format'
    : (profiles.find((p) => p.id === columns.profileId)?.name ?? columns.profileId);
  return `${name} · ${Math.round(columns.confidence * 100)} %`;
}

export function partlyRecognised(columns: ColumnSet | null): boolean {
  return !!columns && columns.confidence > 0 && columns.confidence < MIN_CONFIDENCE;
}

/** Layouts one per line in the settings, empty lines left out. */
export function parseLayouts(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * A draft for a custom profile from an inferred layout. Its `level` group, if any, also serves as
 * the level regex, so the levels and the columns come from the same place.
 */
export function draftFromInference(
  layout: string,
  fileName: string,
): { name: string; pattern: string; layouts: string } {
  return {
    name: `Erkannt: ${fileName}`,
    pattern: layout.includes('(?P<level>') ? layout : '',
    layouts: layout,
  };
}
