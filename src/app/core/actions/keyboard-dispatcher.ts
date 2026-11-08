import { ActionId, actionDef } from './action-catalog';
import type { RunSource } from './action.service';
import { ResolvedKeymap } from './keymap';
import { Platform } from './platform';
import {
  KeyEventLike,
  hasCommandModifier,
  isFunctionKey,
  strokeFromEvent,
  strokeToString,
} from './shortcut';

export const CHORD_TIMEOUT_MS = 1500;

/** Widgets with their own keys (arrows, Enter, Space, letters): view actions stay out (prompts 004, 005, 007, 014). */
const OWN_KEYS = '.detail, [role=separator], [role=tree], .stats, .timeline';
/** Menus of the table (column and row menu): their keys are theirs. */
const MENUS = '.lt-colmenu, .lt-rowmenu, [role=menu]';
/** Controls that act on Space and Enter themselves. */
const CONTROLS =
  'button, input, a[href], summary, [role=button], [role=checkbox], [role=tab], [role=option]';

export interface DispatchEvent extends KeyEventLike {
  readonly target: EventTarget | null;
  readonly repeat: boolean;
  readonly isComposing?: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

/** What the dispatcher needs of the `ActionService`. */
export interface DispatchHost {
  recording(): boolean;
  platform(): Platform;
  keymap(): ResolvedKeymap;
  canRun(id: ActionId): boolean;
  run(id: ActionId, source: RunSource): boolean;
}

/** Where the focus is, as far as shortcuts care. */
export type Place = 'dialog' | 'menu' | 'field' | 'input' | 'widget' | 'control' | 'view';

export function placeOf(target: EventTarget | null): Place {
  const el = target instanceof Element ? target : null;
  if (!el) return 'view';
  if (el.closest('dialog')) return 'dialog';
  if (el.closest(MENUS)) return 'menu';
  if (el.closest('[data-action-field=search]')) return 'field';
  if (isTextInput(el)) return 'input';
  if (el.closest(OWN_KEYS)) return 'widget';
  if (el.closest(CONTROLS)) return 'control';
  return 'view';
}

/**
 * The one keyboard handler of the app (prompt 021, capture phase on `document`):
 *
 * ```
 * key is being recorded       → nothing (the editor takes it)
 * focus in a dialog           → nothing, the dialog owns its keys
 * focus in a text field       → only global actions with Mod/Ctrl/Alt or an F-key; field actions in the search field
 * focus in tree, panel, ruler → their keys stay there; global shortcuts with a modifier act, and `D` (panels: true)
 * Space/Enter on a button     → the button's
 * chord open                  → second stroke within 1.5 s
 * hit                         → preventDefault, stopPropagation, ActionService.run
 * ```
 * A hit whose handler is disabled passes on untouched, e.g. `Mod+C` with marked text copies the text.
 */
export class KeyboardDispatcher {
  private chord: { first: string; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(private readonly actions: DispatchHost) {}

  /** Returns the action that ran (for tests), or null. */
  handle(evt: DispatchEvent): ActionId | null {
    if (this.actions.recording() || evt.isComposing) {
      this.clearChord();
      return null;
    }
    const platform = this.actions.platform();
    const stroke = strokeFromEvent(evt, platform);
    if (!stroke) return null;
    const place = placeOf(evt.target);
    if (place === 'dialog') {
      this.clearChord();
      return null;
    }
    const command = hasCommandModifier(stroke) || isFunctionKey(stroke.key);
    const lookup = this.actions.keymap().lookup;
    let text = strokeToString(stroke);
    if (this.chord) {
      text = `${this.chord.first} ${text}`;
      this.clearChord();
    } else if ([...lookup.keys()].some((k) => k.startsWith(`${text} `))) {
      evt.preventDefault();
      evt.stopPropagation();
      this.chord = { first: text, timer: setTimeout(() => this.clearChord(), CHORD_TIMEOUT_MS) };
      return null;
    }
    const id = (lookup.get(text) ?? []).find((a) => acts(a, place, command, stroke.key));
    if (!id || !this.actions.canRun(id)) return null;
    evt.preventDefault();
    evt.stopPropagation();
    if (evt.repeat && !actionDef(id).repeat) return null;
    return this.actions.run(id, 'key') ? id : null;
  }

  private clearChord(): void {
    if (this.chord) {
      clearTimeout(this.chord.timer);
      this.chord = null;
    }
  }
}

/** Whether an action acts at this place for a shortcut with (`command`) or without a modifier. */
function acts(id: ActionId, place: Place, command: boolean, key: string): boolean {
  const def = actionDef(id);
  if (def.scope === 'field') return place === 'field';
  if (def.scope === 'global' && command) return true;
  // view actions, and global actions on a plain key
  switch (place) {
    case 'view':
      return true;
    case 'control':
      return key !== 'Space' && key !== 'Enter';
    case 'widget':
      return !!def.panels;
    default:
      return false;
  }
}

function isTextInput(el: Element): boolean {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) {
    // Radio groups and sliders use the arrows, so only plain buttons and checkboxes are no field.
    return !['button', 'checkbox', 'submit', 'reset', 'color', 'file', 'image'].includes(el.type);
  }
  return (el as HTMLElement).isContentEditable === true;
}
