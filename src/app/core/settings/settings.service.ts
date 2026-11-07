import { Injectable, effect, signal } from '@angular/core';
import { isTauri } from '@tauri-apps/api/core';
import { LazyStore } from '@tauri-apps/plugin-store';
import { DEFAULT_SETTINGS, Settings, addRecent, mergeSettings } from './settings.models';

const STORE_KEY = 'settings';
const SAVE_DELAY_MS = 300;

/** Settings as a signal, persisted with tauri-plugin-store; applies theme and colours. */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly store = isTauri() ? new LazyStore('settings.json', { autoSave: false }) : null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private loaded = false;
  readonly settings = signal<Settings>(DEFAULT_SETTINGS);

  constructor() {
    effect(() => this.applyToDocument(this.settings()));
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', () =>
      this.applyToDocument(this.settings()),
    );
    effect(() => {
      const settings = this.settings();
      if (this.loaded) this.scheduleSave(settings);
    });
  }

  async load(): Promise<void> {
    try {
      const saved = await this.store?.get<Partial<Settings>>(STORE_KEY);
      this.settings.set(mergeSettings(saved));
    } catch (e) {
      console.warn('settings could not be loaded, using defaults', e);
    }
    this.loaded = true;
  }

  update(change: Partial<Settings>): void {
    this.settings.update((s) => mergeSettings({ ...s, ...change }));
  }

  addRecentFile(path: string): void {
    this.update({ recentFiles: addRecent(this.settings().recentFiles, path) });
  }

  removeRecentFile(path: string): void {
    this.update({ recentFiles: this.settings().recentFiles.filter((p) => p !== path) });
  }

  private scheduleSave(settings: Settings): void {
    if (!this.store) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    const store = this.store;
    this.saveTimer = setTimeout(() => {
      void store
        .set(STORE_KEY, settings)
        .then(() => store.save())
        .catch((e) => console.warn('settings could not be saved', e));
    }, SAVE_DELAY_MS);
  }

  private applyToDocument(settings: Settings): void {
    const root = document.documentElement;
    const dark =
      settings.theme === 'dark' ||
      (settings.theme === 'system' && !matchMedia('(prefers-color-scheme: light)').matches);
    root.dataset['theme'] = dark ? 'dark' : 'light';
    for (const name of [...root.style]) {
      if (name.startsWith('--lv-')) root.style.removeProperty(name);
    }
    for (const [token, value] of Object.entries(settings.colorOverrides)) {
      if (token.startsWith('lv-')) root.style.setProperty(`--${token}`, value);
    }
  }
}
