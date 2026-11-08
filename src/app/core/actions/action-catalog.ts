/**
 * All actions with a keyboard shortcut (prompt 021). The ids are stored in user settings: stable, never rename.
 * This file has no imports on purpose: `scripts/keymap-table.mjs` reads it with Node to write the README table.
 *
 * Scope (where a shortcut acts, see `KeyboardDispatcher`):
 * - `global`: everywhere outside dialogs, in text fields too when the shortcut has Mod/Ctrl/Alt or is an F-key;
 *   a plain key of a global action acts like `view`.
 * - `view`: only while no text field, dialog, menu or own widget (tree, panel, timeline …) has the focus.
 * - `field`: only in the search field of the toolbar.
 */
export type ActionScope = 'global' | 'view' | 'field';

export const ACTION_GROUPS = [
  'Datei',
  'Tabs',
  'Ansicht',
  'Navigation',
  'Auswahl',
  'Filter',
  'Suche',
  'Hilfe',
] as const;
export type ActionGroup = (typeof ACTION_GROUPS)[number];

export interface ActionDef {
  readonly id: string;
  /** German name in the editor. */
  readonly label: string;
  readonly group: ActionGroup;
  readonly scope: ActionScope;
  /** Runs again while the key is held (auto-repeat). */
  readonly repeat?: boolean;
  /** A `view` action that also acts in the detail panel, tree, statistics and timeline (only `D`). */
  readonly panels?: boolean;
  /** Has an entry in the native menu: its accelerator follows the keymap (`set_menu_accelerators`). */
  readonly menu?: boolean;
}

export const ACTIONS = [
  // Datei
  { id: 'OPEN_FILE', label: 'Datei öffnen', group: 'Datei', scope: 'global', menu: true },
  {
    id: 'OPEN_PATH',
    label: 'Pfad eingeben und öffnen',
    group: 'Datei',
    scope: 'global',
    menu: true,
  },
  {
    id: 'OPEN_SOURCE',
    label: 'Quelle öffnen (Syslog, Datenbank …)',
    group: 'Datei',
    scope: 'global',
    menu: true,
  },
  { id: 'OPEN_REMOTE', label: 'Remote-Datei öffnen', group: 'Datei', scope: 'global', menu: true },
  {
    id: 'MERGE_FILES',
    label: 'Dateien zusammenführen',
    group: 'Datei',
    scope: 'global',
    menu: true,
  },
  { id: 'EXPORT', label: 'Exportieren', group: 'Datei', scope: 'global', menu: true },
  {
    id: 'OPEN_WORKSPACE',
    label: 'Arbeitsstand öffnen',
    group: 'Datei',
    scope: 'global',
    menu: true,
  },
  {
    id: 'SAVE_WORKSPACE',
    label: 'Arbeitsstand speichern',
    group: 'Datei',
    scope: 'global',
    menu: true,
  },
  { id: 'OPEN_SETTINGS', label: 'Einstellungen', group: 'Datei', scope: 'global' },
  // Tabs
  { id: 'CLOSE_TAB', label: 'Tab schließen', group: 'Tabs', scope: 'global', menu: true },
  { id: 'NEXT_TAB', label: 'Nächster Tab', group: 'Tabs', scope: 'global', repeat: true },
  { id: 'PREV_TAB', label: 'Vorheriger Tab', group: 'Tabs', scope: 'global', repeat: true },
  {
    id: 'NEW_FILTER_TAB',
    label: 'Ergebnis als neuer Filter-Tab',
    group: 'Tabs',
    scope: 'global',
  },
  // Ansicht
  { id: 'TOGGLE_SIDEBAR', label: 'Seitenleiste ein/aus', group: 'Ansicht', scope: 'global' },
  { id: 'TOGGLE_DASHBOARD', label: 'Dashboard oder Log', group: 'Ansicht', scope: 'global' },
  { id: 'TOGGLE_COLUMNS', label: 'Spalten oder Rohzeilen', group: 'Ansicht', scope: 'view' },
  {
    id: 'TOGGLE_DETAIL',
    label: 'Detail-Panel ein/aus',
    group: 'Ansicht',
    scope: 'view',
    panels: true,
  },
  { id: 'TOGGLE_TIMELINE', label: 'Zeitstrahl ein/aus', group: 'Ansicht', scope: 'view' },
  { id: 'OPEN_COLUMN_MENU', label: 'Spaltenmenü', group: 'Ansicht', scope: 'view' },
  {
    id: 'COLOR_SCHEME',
    label: 'Farbschema wählen',
    group: 'Ansicht',
    scope: 'global',
    menu: true,
  },
  // Navigation
  {
    id: 'FOLLOW_END',
    label: 'Ans Ende und folgen',
    group: 'Navigation',
    scope: 'view',
    repeat: true,
  },
  { id: 'TOGGLE_FOLLOW', label: 'Folgen an/aus', group: 'Navigation', scope: 'view' },
  {
    id: 'TOGGLE_FREEZE',
    label: 'Einfrieren (Freeze) an/aus',
    group: 'Navigation',
    scope: 'view',
  },
  { id: 'GO_START', label: 'An den Anfang', group: 'Navigation', scope: 'view', repeat: true },
  {
    id: 'SCROLL_PAGE_UP',
    label: 'Eine Seite hoch',
    group: 'Navigation',
    scope: 'view',
    repeat: true,
  },
  {
    id: 'SCROLL_PAGE_DOWN',
    label: 'Eine Seite runter',
    group: 'Navigation',
    scope: 'view',
    repeat: true,
  },
  {
    id: 'SCROLL_LINE_UP',
    label: 'Eine Zeile hoch',
    group: 'Navigation',
    scope: 'view',
    repeat: true,
  },
  {
    id: 'SCROLL_LINE_DOWN',
    label: 'Eine Zeile runter',
    group: 'Navigation',
    scope: 'view',
    repeat: true,
  },
  { id: 'NEXT_ERROR', label: 'Nächster Fehler', group: 'Navigation', scope: 'view', repeat: true },
  {
    id: 'PREV_ERROR',
    label: 'Vorheriger Fehler',
    group: 'Navigation',
    scope: 'view',
    repeat: true,
  },
  {
    id: 'NEXT_WARNING',
    label: 'Nächste Warnung',
    group: 'Navigation',
    scope: 'view',
    repeat: true,
  },
  {
    id: 'PREV_WARNING',
    label: 'Vorherige Warnung',
    group: 'Navigation',
    scope: 'view',
    repeat: true,
  },
  {
    id: 'NEXT_BOOKMARK',
    label: 'Nächstes Lesezeichen',
    group: 'Navigation',
    scope: 'view',
    repeat: true,
  },
  {
    id: 'PREV_BOOKMARK',
    label: 'Vorheriges Lesezeichen',
    group: 'Navigation',
    scope: 'view',
    repeat: true,
  },
  // Auswahl
  { id: 'COPY_SELECTION', label: 'Auswahl kopieren', group: 'Auswahl', scope: 'view' },
  { id: 'CLEAR_SELECTION', label: 'Auswahl aufheben', group: 'Auswahl', scope: 'view' },
  { id: 'TOGGLE_BOOKMARK', label: 'Lesezeichen an/aus', group: 'Auswahl', scope: 'view' },
  { id: 'EDIT_NOTE', label: 'Notiz zum Eintrag', group: 'Auswahl', scope: 'view' },
  // Filter
  {
    id: 'TOGGLE_FULL_LOG',
    label: 'Zeile im ganzen Log, wieder: zurück zum Filter',
    group: 'Filter',
    scope: 'view',
  },
  { id: 'FILTER_ON_TEXT', label: 'Auf markierten Text filtern', group: 'Filter', scope: 'view' },
  {
    id: 'FILTER_EXCLUDE_TEXT',
    label: 'Markierten Text ausschließen',
    group: 'Filter',
    scope: 'view',
  },
  { id: 'SECTION_FROM', label: 'Abschnitt ab diesem Eintrag', group: 'Filter', scope: 'view' },
  { id: 'SECTION_TO', label: 'Abschnitt bis zu diesem Eintrag', group: 'Filter', scope: 'view' },
  // Suche
  { id: 'FOCUS_SEARCH', label: 'Suchfeld', group: 'Suche', scope: 'global' },
  { id: 'FIND_NEXT', label: 'Nächster Treffer', group: 'Suche', scope: 'field' },
  { id: 'FIND_PREV', label: 'Vorheriger Treffer', group: 'Suche', scope: 'field' },
  { id: 'CLEAR_SEARCH', label: 'Suche leeren', group: 'Suche', scope: 'field' },
  // Hilfe
  {
    id: 'OPEN_SHORTCUTS',
    label: 'Tastenkürzel bearbeiten',
    group: 'Hilfe',
    scope: 'global',
    menu: true,
  },
  { id: 'SHOW_SHORTCUTS', label: 'Tastenkürzel anzeigen', group: 'Hilfe', scope: 'view' },
] as const satisfies readonly ActionDef[];

export type ActionId = (typeof ACTIONS)[number]['id'];

export const ACTION_IDS: readonly ActionId[] = ACTIONS.map((a) => a.id);

const BY_ID = new Map<string, ActionDef>(ACTIONS.map((a) => [a.id, a]));

export function isActionId(id: string): id is ActionId {
  return BY_ID.has(id);
}

export function actionDef(id: ActionId): ActionDef {
  return BY_ID.get(id)!;
}
