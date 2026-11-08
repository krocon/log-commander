import { ACTION_IDS, ActionId, ActionScope, actionDef, isActionId } from './action-catalog';
import linux from './keymaps/linux.json';
import macos from './keymaps/macos.json';
import windows from './keymaps/windows.json';
import { Platform } from './platform';
import { canonicalShortcut, formatShortcut, parseShortcut, typesText } from './shortcut';

/** Action id → shortcuts (canonical strings). */
export type Bindings = Readonly<Record<ActionId, readonly string[]>>;
/** As stored: any keys, any values (checked here). */
export type RawBindings = Readonly<Record<string, unknown>>;

export const DEFAULT_KEYMAPS: Readonly<Record<Platform, RawBindings>> = { macos, windows, linux };

/** Taken by the system or the native application menu on this OS: never bound. */
const RESERVED: Readonly<Record<Platform, Readonly<Record<string, string>>>> = {
  macos: {
    'Mod+Q': 'Beenden im macOS-Menü',
    'Mod+H': 'Ausblenden im macOS-Menü',
    'Mod+Alt+H': 'Andere ausblenden im macOS-Menü',
    'Mod+M': 'Im Dock ablegen im macOS-Menü',
    'Mod+Ctrl+F': 'Vollbild im macOS-Menü',
    'Mod+Tab': 'Programmwechsel von macOS',
    'Mod+Shift+Tab': 'Programmwechsel von macOS',
    'Mod+Space': 'Spotlight von macOS',
  },
  windows: { 'Alt+F4': 'Fenster schließen', 'Alt+Tab': 'Programmwechsel' },
  linux: { 'Alt+F4': 'Fenster schließen', 'Alt+Tab': 'Programmwechsel' },
};

/** Edit keys of text fields: an action acting in text fields must not take them. */
const TEXT_FIELD_KEYS: readonly string[] = [
  'Mod+C',
  'Mod+V',
  'Mod+X',
  'Mod+A',
  'Mod+Z',
  'Mod+Shift+Z',
];

/** Why a shortcut cannot be given to an action of this scope, `null` if it can. */
export function reservedReason(
  shortcut: string,
  scope: ActionScope,
  platform: Platform,
): string | null {
  const own = RESERVED[platform][shortcut];
  if (own) return own;
  if (scope !== 'view' && TEXT_FIELD_KEYS.includes(shortcut)) {
    return 'Bearbeiten in Eingabefeldern';
  }
  const strokes = parseShortcut(shortcut, platform);
  if (scope === 'field' && strokes?.some(typesText))
    return 'würde im Suchfeld das Tippen verhindern';
  return null;
}

/** Two actions can share a shortcut only when they never act in the same place. */
export function scopesOverlap(a: ActionScope, b: ActionScope): boolean {
  return !((a === 'view' && b === 'field') || (a === 'field' && b === 'view'));
}

export interface ResolvedKeymap {
  readonly bindings: Bindings;
  /** Canonical shortcut → the actions that own it (at most one per place). */
  readonly lookup: ReadonlyMap<string, readonly ActionId[]>;
  /** Problems found while merging, in German, for the notice list. */
  readonly problems: readonly string[];
}

const label = (id: ActionId) => actionDef(id).label;

/**
 * Defaults + user override: an override entry replaces the list of that action (`[]` = no shortcut), so new
 * defaults of later versions arrive. Unknown ids, invalid and reserved shortcuts are reported and skipped; on a
 * conflict the override wins and the other action loses that shortcut (reported).
 */
export function resolveKeymap(
  platform: Platform,
  override: RawBindings = {},
  defaults: RawBindings = DEFAULT_KEYMAPS[platform],
): ResolvedKeymap {
  const problems: string[] = [];
  const show = (s: string) => formatShortcut(s, platform);
  const normalise = (id: ActionId, list: unknown, own: boolean): string[] => {
    const out: string[] = [];
    const where = own ? 'eigene Belegung' : 'Vorgabe';
    if (!Array.isArray(list)) {
      problems.push(`„${label(id)}“ (${where}): keine Liste von Kürzeln, übergangen.`);
      return out;
    }
    for (const raw of list.slice(0, 8)) {
      const c = typeof raw === 'string' ? canonicalShortcut(raw, platform) : null;
      if (c === null) {
        problems.push(
          `„${String(raw).slice(0, 40)}“ ist kein gültiges Kürzel (${label(id)}, ${where}).`,
        );
        continue;
      }
      const why = reservedReason(c, actionDef(id).scope, platform);
      if (why) problems.push(`${show(c)} für „${label(id)}“ ist reserviert: ${why}.`);
      else if (!out.includes(c)) out.push(c);
    }
    return out;
  };

  const merged = new Map<ActionId, string[]>(ACTION_IDS.map((id) => [id, []]));
  for (const [id, list] of Object.entries(defaults)) {
    if (isActionId(id)) merged.set(id, normalise(id, list, false));
    else problems.push(`Unbekannte Aktion „${id}“ in der Vorgabe.`);
  }
  const overridden = new Set<ActionId>();
  for (const [id, list] of Object.entries(override)) {
    if (!isActionId(id)) {
      problems.push(`Unbekannte Aktion „${id.slice(0, 64)}“ in der eigenen Belegung, übergangen.`);
      continue;
    }
    merged.set(id, normalise(id, list, true));
    overridden.add(id);
  }

  // Overridden actions first: they win a conflict.
  const order = [...merged.keys()].sort(
    (a, b) => Number(overridden.has(b)) - Number(overridden.has(a)),
  );
  const lookup = new Map<string, ActionId[]>();
  for (const id of order) {
    const scope = actionDef(id).scope;
    const kept: string[] = [];
    for (const s of merged.get(id) ?? []) {
      const owners = lookup.get(s) ?? [];
      const rival = owners.find((o) => scopesOverlap(actionDef(o).scope, scope));
      if (rival) {
        problems.push(`${show(s)} gehört „${label(rival)}“, „${label(id)}“ verliert es.`);
        continue;
      }
      lookup.set(s, [...owners, id]);
      kept.push(s);
    }
    merged.set(id, kept);
  }
  // A chord hides a single stroke that is its first part.
  for (const s of [...lookup.keys()]) {
    const first = s.split(' ')[0];
    if (s.includes(' ') && lookup.has(first)) {
      problems.push(`${show(first)} allein verdeckt den Akkord ${show(s)}.`);
    }
  }
  return { bindings: Object.fromEntries(merged) as unknown as Bindings, lookup, problems };
}

/** What recording a shortcut for an action would do (the editor asks before replacing). */
export type Candidate =
  | { readonly kind: 'ok'; readonly shortcut: string }
  | { readonly kind: 'same'; readonly shortcut: string }
  | { readonly kind: 'reserved'; readonly shortcut: string; readonly reason: string }
  | { readonly kind: 'conflict'; readonly shortcut: string; readonly owner: ActionId };

export function checkCandidate(
  id: ActionId,
  shortcut: string,
  keymap: ResolvedKeymap,
  platform: Platform,
): Candidate {
  const scope = actionDef(id).scope;
  const reason = reservedReason(shortcut, scope, platform);
  if (reason) return { kind: 'reserved', shortcut, reason };
  const owners = keymap.lookup.get(shortcut) ?? [];
  if (owners.includes(id)) return { kind: 'same', shortcut };
  const owner = owners.find((o) => scopesOverlap(actionDef(o).scope, scope));
  return owner ? { kind: 'conflict', shortcut, owner } : { kind: 'ok', shortcut };
}

/**
 * The override after giving `shortcut` to `id` (instead of its shortcuts, or in addition), taking it from
 * `loser` if there is one. Only actions that differ from their default stay in the override.
 */
export function assignShortcut(
  override: Readonly<Record<string, readonly string[]>>,
  keymap: ResolvedKeymap,
  id: ActionId,
  shortcut: string,
  platform: Platform,
  loser: ActionId | null,
  mode: 'replace' | 'add' = 'replace',
): Record<string, readonly string[]> {
  const next: Record<string, readonly string[]> = { ...override };
  const kept = mode === 'add' ? keymap.bindings[id].filter((s) => s !== shortcut) : [];
  next[id] = [...kept, shortcut];
  if (loser) next[loser] = keymap.bindings[loser].filter((s) => s !== shortcut);
  return pruneOverride(next, platform);
}

/** Drops entries equal to the default (order does not matter). */
export function pruneOverride(
  override: Readonly<Record<string, readonly string[]>>,
  platform: Platform,
): Record<string, readonly string[]> {
  const defaults = resolveKeymap(platform, {}).bindings;
  const out: Record<string, readonly string[]> = {};
  for (const [id, list] of Object.entries(override)) {
    if (!isActionId(id)) continue;
    const def = defaults[id];
    const same = list.length === def.length && list.every((s) => def.includes(s));
    if (!same) out[id] = list;
  }
  return out;
}
