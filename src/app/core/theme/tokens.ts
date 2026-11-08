/**
 * The catalog of scheme tokens (prompt 020): every token a scheme may set, with group, German name and kind.
 * The colour tokens are exactly those of the `@theme` blocks in `src/styles.css` (test). Only catalog tokens
 * ever reach `<html>`.
 */
export type TokenKind = 'color' | 'font';

export interface TokenDef {
  readonly name: string;
  readonly group: string;
  readonly label: string;
  readonly kind: TokenKind;
}

const LEVEL_NAMES = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'unknown'] as const;
const EIGHT = [1, 2, 3, 4, 5, 6, 7, 8] as const;

function group(name: string, entries: readonly (readonly [string, string])[]): TokenDef[] {
  return entries.map(([token, label]) => ({
    name: `--${token}`,
    group: name,
    label,
    kind: 'color',
  }));
}

export const TOKENS: readonly TokenDef[] = [
  ...group('Flächen', [
    ['bg-app', 'Hintergrund (Log)'],
    ['bg-panel', 'Leisten und Dialoge'],
    ['bg-raised', 'Eingaben und Menüs'],
    ['bg-hover', 'Hover'],
    ['bg-gutter', 'Zeilennummern'],
    ['border', 'Linien'],
  ]),
  ...group('Text', [
    ['text', 'Text'],
    ['text-dim', 'Gedämpfter Text'],
  ]),
  ...group('Akzent und Status', [
    ['accent', 'Akzent'],
    ['accent-text', 'Text auf Akzent'],
    ['danger', 'Fehler'],
    ['ok', 'Erfolg'],
  ]),
  ...group('Auswahl und Treffer', [
    ['row-selected', 'Gewählte Zeile'],
    ['hit-bg', 'Treffer'],
    ['hit-text', 'Text im Treffer'],
    ['hit-current-bg', 'Aktueller Treffer'],
    ['hit-current-text', 'Text im aktuellen Treffer'],
  ]),
  ...group(
    'Level',
    LEVEL_NAMES.flatMap((l) => {
      const name = l.toUpperCase();
      const own: [string, string][] = [
        [`lv-${l}-fg`, `${name} Text`],
        [`lv-${l}-bg`, `${name} Hintergrund`],
      ];
      if (l === 'info') own.push(['lv-info-badge', 'INFO Badge']);
      if (l === 'error') own.push(['lv-error-edge', 'ERROR Rand']);
      return own;
    }),
  ),
  ...group('Inline-Tokens', [
    ['tok-time', 'Zeit'],
    ['tok-number', 'Zahl'],
    ['tok-string', 'String'],
    ['tok-id', 'ID'],
    ['tok-url', 'URL'],
  ]),
  ...group('Splitter', [
    ['splitter-bg', 'Leiste'],
    ['splitter-grip', 'Griff'],
    ['splitter-hover-bg', 'Leiste beim Ziehen'],
  ]),
  ...group(
    'Quellen',
    EIGHT.map((i) => [`src-${i}`, `Quelle ${i}`] as const),
  ),
  ...group('Overview Ruler', [
    ['ruler-bg', 'Fläche'],
    ['ruler-band', 'Sichtbarer Bereich'],
    ['ruler-band-edge', 'Kante des Bereichs'],
    ['ruler-fatal', 'FATAL'],
    ['ruler-error', 'ERROR'],
    ['ruler-warn', 'WARN'],
    ['ruler-bookmark', 'Lesezeichen'],
    ['ruler-selection', 'Auswahl'],
  ]),
  ...group('Notizen', [['note', 'Notiz']]),
  ...group('Zeitstrahl', [
    ['tl-all', 'Säulen'],
    ['tl-gap', 'Ausfall'],
  ]),
  ...group('Dashboard', [
    ...EIGHT.map((i) => [`chart-${i}`, `Reihe ${i}`] as const),
    ...[...LEVEL_NAMES.slice(0, 6), 'unknown'].map(
      (l) => [`chart-lv-${l}`, `${l.toUpperCase()} (Reihe)`] as const,
    ),
    ['chart-grid', 'Gitterlinien'],
  ]),
  { name: '--font-ui', group: 'Schrift', label: 'Oberfläche', kind: 'font' },
  { name: '--font-mono', group: 'Schrift', label: 'Log (Monospace)', kind: 'font' },
];

export const TOKEN_NAMES: ReadonlySet<string> = new Set(TOKENS.map((t) => t.name));

const BY_NAME = new Map(TOKENS.map((t) => [t.name, t]));

export function tokenDef(name: string): TokenDef | undefined {
  return BY_NAME.get(name);
}
