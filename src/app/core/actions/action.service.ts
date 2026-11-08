import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { call } from '../backend/call';
import { SettingsService } from '../settings/settings.service';
import type { ActionId } from './action-catalog';
import type { DispatchEvent, KeyboardDispatcher } from './keyboard-dispatcher';
import type { ResolvedKeymap } from './keymap';
import { Platform, detectPlatform } from './platform';

type Engine = typeof import('./engine');

export interface ActionHandler {
  run(): void | Promise<unknown>;
  /** Absent = always. When false the key passes on (e.g. `Mod+C` with marked text copies the text). */
  enabled?(): boolean;
}

/** Where a run came from: a key and a native menu accelerator for the same press must not both act. */
export type RunSource = 'key' | 'menu' | 'other';

/** A key and its menu event arrive within this time when both see the same press. */
const DOUBLE_MS = 300;

/** One menu entry and its shortcut in the keymap notation (`null` = none), for `set_menu_accelerators`. */
export interface MenuAccelerator {
  id: string;
  shortcut: string | null;
}

const NO_KEYMAP: ResolvedKeymap = {
  bindings: {} as ResolvedKeymap['bindings'],
  lookup: new Map(),
  problems: [],
};

/**
 * The actions of the app (prompt 021): handlers registered by the features under stable ids, the effective
 * keymap (defaults of this OS + the user's override from the settings) and running an action by id. Only the
 * registry is in the initial bundle; catalogue, keymaps and dispatcher come with `load()` (`engine.ts`).
 */
@Injectable({ providedIn: 'root' })
export class ActionService {
  private readonly settings = inject(SettingsService);
  private readonly handlers = new Map<ActionId, ActionHandler>();
  private readonly version = signal(0);
  private readonly lastRun = new Map<ActionId, { source: RunSource; at: number }>();
  private dispatcher: KeyboardDispatcher | null = null;
  private loading: Promise<Engine> | null = null;

  readonly engine = signal<Engine | null>(null);
  readonly platform = signal<Platform>(detectPlatform());
  /** The user's entries: only actions that differ from the default. */
  readonly override = computed(() => this.settings.settings().keymap.bindings);
  readonly keymap = computed<ResolvedKeymap>(() => {
    const engine = this.engine();
    return engine ? engine.resolveKeymap(this.platform(), this.override()) : NO_KEYMAP;
  });
  /** The editor records a shortcut: no action runs, the menu accelerators are off. */
  readonly recording = signal(false);
  /** Where failures go (the error banner, set by the app). */
  reportError: (message: string) => void = (m) => console.warn(m);
  /** Sends the menu accelerators to the backend (replaced in tests). */
  sendMenu: (items: MenuAccelerator[]) => Promise<unknown> = (items) =>
    call('set_menu_accelerators', { items });

  constructor() {
    effect(() => {
      const engine = this.engine();
      if (!engine || !this.settings.loaded()) return;
      const items = engine.menuAccelerators(this.keymap(), this.recording());
      untracked(() => void this.sendMenu(items).catch(() => undefined));
    });
  }

  /** Loads the engine (once); keys act from then on. */
  load(): Promise<Engine> {
    this.loading ??= import('./engine').then((engine) => {
      this.dispatcher = new engine.KeyboardDispatcher(this);
      this.engine.set(engine);
      return engine;
    });
    return this.loading;
  }

  /** The one keyboard handler of the app, in the capture phase (see `KeyboardDispatcher`). */
  attach(doc: Document): () => void {
    const down = (e: KeyboardEvent) => void this.dispatcher?.handle(e as DispatchEvent);
    doc.addEventListener('keydown', down, true);
    return () => doc.removeEventListener('keydown', down, true);
  }

  /** Registers a handler; returns a function that removes it again. */
  register(
    id: ActionId,
    run: ActionHandler['run'],
    enabled?: ActionHandler['enabled'],
  ): () => void {
    const handler: ActionHandler = { run, enabled };
    this.handlers.set(id, handler);
    this.version.update((n) => n + 1);
    return () => {
      if (this.handlers.get(id) === handler) {
        this.handlers.delete(id);
        this.version.update((n) => n + 1);
      }
    };
  }

  /** Registers several handlers with one enabled rule; returns a function that removes them. */
  registerAll(
    map: Partial<Record<ActionId, ActionHandler['run']>>,
    enabled?: ActionHandler['enabled'],
  ): () => void {
    const offs = Object.entries(map).map(([id, run]) =>
      this.register(id as ActionId, run as ActionHandler['run'], enabled),
    );
    return () => offs.forEach((off) => off());
  }

  /** A feature has a handler for it right now (the editor dims the others). */
  isRegistered(id: ActionId): boolean {
    this.version();
    return this.handlers.has(id);
  }

  /** It would run now: registered and enabled. */
  canRun(id: ActionId): boolean {
    const handler = this.handlers.get(id);
    return !!handler && (handler.enabled?.() ?? true);
  }

  /** Runs an action. Returns false when it did not run (no handler, disabled, recording, double). */
  run(id: ActionId, source: RunSource = 'other'): boolean {
    if (this.recording() || !this.canRun(id)) return false;
    const now = Date.now();
    const last = this.lastRun.get(id);
    if (
      last &&
      source !== 'other' &&
      last.source !== 'other' &&
      last.source !== source &&
      now - last.at < DOUBLE_MS
    ) {
      return false;
    }
    this.lastRun.set(id, { source, at: now });
    const fail = (e: unknown) => this.reportError(`${id}: ${errorText(e)}`);
    try {
      const result = this.handlers.get(id)!.run();
      if (result instanceof Promise) result.catch(fail);
    } catch (e) {
      fail(e);
    }
    return true;
  }

  shortcuts(id: ActionId): readonly string[] {
    return this.keymap().bindings[id] ?? [];
  }

  /** ` (⌘O)` for a tooltip, `''` without a shortcut. */
  hint(id: ActionId): string {
    const first = this.shortcuts(id)[0];
    const engine = this.engine();
    return first && engine ? ` (${engine.formatShortcut(first, this.platform())})` : '';
  }

  /** Stores the override (only the differences from the default). */
  setOverride(bindings: Readonly<Record<string, readonly string[]>>): void {
    const copy: Record<string, string[]> = {};
    for (const [id, list] of Object.entries(bindings)) copy[id] = [...list];
    this.settings.update({ keymap: { version: 1, bindings: copy } });
  }

  /** A notice for the start: an unreadable store, or problems with the own shortcuts. */
  startNotice(): string | null {
    const own = this.settings.keymapNotice();
    const mine = Object.keys(this.override()).length ? this.keymap().problems.length : 0;
    const more = mine ? `Tastenkürzel: ${mine} Hinweis(e), siehe Hilfe ▸ Tastenkürzel.` : null;
    return [own, more].filter((p) => p).join(' ') || null;
  }
}

function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e)
    return String((e as { message: unknown }).message);
  return String(e);
}
