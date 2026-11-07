import { Injectable, signal } from '@angular/core';
import { isTauri } from '@tauri-apps/api/core';
import { LazyStore } from '@tauri-apps/plugin-store';
import { DashboardDef, mergeDashboards } from './dashboard-model';

const STORE_KEY = 'dashboards';
const SAVE_DELAY_MS = 500;

/**
 * Dashboards per profile id (prompt 012), in their own store file next to the settings: panels with SQL
 * grow beyond a few KB, the settings stay small.
 */
@Injectable({ providedIn: 'root' })
export class DashboardStore {
  private readonly store = isTauri() ? new LazyStore('dashboards.json', { autoSave: false }) : null;
  private loading: Promise<void> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  readonly all = signal<Record<string, DashboardDef>>({});

  /** Loads once; later calls wait for the same load. */
  load(): Promise<void> {
    this.loading ??= (async () => {
      try {
        this.all.set(mergeDashboards(await this.store?.get<unknown>(STORE_KEY)));
      } catch (e) {
        console.warn('dashboards could not be loaded', e);
      }
    })();
    return this.loading;
  }

  get(profileId: string): DashboardDef | null {
    return this.all()[profileId] ?? null;
  }

  set(profileId: string, dashboard: DashboardDef): void {
    this.all.update((all) => ({ ...all, [profileId]: dashboard }));
    this.scheduleSave();
  }

  private scheduleSave(): void {
    const store = this.store;
    if (!store) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void store
        .set(STORE_KEY, this.all())
        .then(() => store.save())
        .catch((e) => console.warn('dashboards could not be saved', e));
    }, SAVE_DELAY_MS);
  }
}
