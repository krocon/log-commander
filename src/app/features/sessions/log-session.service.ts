import { Injectable, computed, inject, signal } from '@angular/core';
import { LogApi } from '../../core/log/log-api';
import { Level, Profile, SearchMode, SearchQuery, SessionUpdate } from '../../core/log/log.models';
import { AppError, describeError, toAppError } from '../../core/errors/app-error';
import { SettingsService } from '../../core/settings/settings.service';
import { SessionState } from './session-state';

const ERROR_VISIBLE_MS = 7000;
const FIND_MESSAGE_MS = 2500;

/** The open files (tabs) and everything that changes a session in the backend. */
@Injectable({ providedIn: 'root' })
export class LogSessionService {
  private readonly api = inject(LogApi);
  private readonly settings = inject(SettingsService);

  readonly sessions = signal<readonly SessionState[]>([]);
  readonly activeId = signal<number | null>(null);
  readonly active = computed(() => this.sessions().find((s) => s.id === this.activeId()) ?? null);
  readonly profiles = signal<readonly Profile[]>([]);
  readonly error = signal<string | null>(null);
  private errorTimer: ReturnType<typeof setTimeout> | null = null;

  async refreshProfiles(): Promise<void> {
    try {
      await this.api.setCustomProfiles(this.settings.settings().customProfiles);
    } catch (e) {
      this.showError(toAppError(e));
    }
    try {
      this.profiles.set(await this.api.listProfiles());
    } catch (e) {
      const err = toAppError(e);
      if (err.code !== 'backend_unavailable') this.showError(err);
    }
  }

  async open(path: string): Promise<void> {
    const error = await this.tryOpen(path);
    if (error) this.showError(error);
  }

  /** Opens or activates a file and hands a failure to the caller instead of showing it. */
  async tryOpen(path: string): Promise<AppError | null> {
    const open = this.sessions().find((s) => s.path === path);
    if (open) {
      this.activate(open.id);
      return null;
    }
    // Updates can overtake the answer of open_log; they wait until the state exists.
    let state: SessionState | null = null;
    const early: SessionUpdate[] = [];
    try {
      const info = await this.api.open(path, this.settings.settings().keepOnRotate, (update) => {
        if (state) state.applyUpdate(update);
        else early.push(update);
      });
      state = new SessionState(info, this.api);
      for (const update of early) state.applyUpdate(update);
      this.sessions.update((all) => [...all, state as SessionState]);
      this.activate(state.id);
      this.settings.addRecentFile(info.path);
      return null;
    } catch (e) {
      const err = toAppError(e);
      if (err.code === 'not_found') this.settings.removeRecentFile(path);
      return err;
    }
  }

  async close(id: number): Promise<void> {
    const all = this.sessions();
    const index = all.findIndex((s) => s.id === id);
    if (index < 0) return;
    const rest = all.filter((s) => s.id !== id);
    this.sessions.set(rest);
    if (this.activeId() === id) {
      const next = rest[Math.min(index, rest.length - 1)];
      this.activate(next ? next.id : null);
    }
    try {
      await this.api.close(id);
    } catch (e) {
      this.showError(toAppError(e));
    }
  }

  activate(id: number | null): void {
    for (const session of this.sessions()) {
      session.active = session.id === id;
      if (session.active) session.markSeen();
    }
    this.activeId.set(id);
  }

  cycle(step: number): void {
    const all = this.sessions();
    if (all.length < 2) return;
    const index = all.findIndex((s) => s.id === this.activeId());
    this.activate(all[(index + step + all.length) % all.length].id);
  }

  async setLevels(session: SessionState, levels: ReadonlySet<Level>): Promise<void> {
    session.levels.set(levels);
    await this.applyFilter(session);
  }

  async setQuery(session: SessionState, query: SearchQuery): Promise<void> {
    session.query.set(query);
    session.currentHitLine.set(null);
    await this.applyFilter(session);
  }

  /**
   * Levels, search and mode at once (saved filter, sidebar): one filter job instead of three. A search
   * still being typed in the toolbar is dropped, it must not overwrite this.
   */
  async applyPreset(
    session: SessionState,
    preset: { levels: Iterable<Level>; query: SearchQuery; mode: SearchMode },
  ): Promise<void> {
    session.levels.set(new Set(preset.levels));
    session.query.set({ ...preset.query });
    session.searchMode.set(preset.mode);
    session.currentHitLine.set(null);
    session.presetRevision.update((r) => r + 1);
    await this.applyFilter(session);
  }

  /** Removes the search (sidebar `×`); like `applyPreset` it wins over a search being typed. */
  async clearSearch(session: SessionState): Promise<void> {
    session.presetRevision.update((r) => r + 1);
    await this.setQuery(session, { ...session.query(), text: '' });
  }

  async setSearchMode(session: SessionState, mode: SearchMode): Promise<void> {
    session.searchMode.set(mode);
    await this.applyFilter(session);
  }

  private async applyFilter(session: SessionState): Promise<void> {
    try {
      await this.api.setFilter(
        session.id,
        [...session.levels()],
        session.query(),
        session.searchMode(),
      );
      session.searchError.set(null);
    } catch (e) {
      const err = toAppError(e);
      if (err.code === 'invalid_search') session.searchError.set(err.message);
      else this.showError(err);
    }
  }

  async setProfile(session: SessionState, profileId: string): Promise<void> {
    try {
      await this.api.setProfile(session.id, profileId);
    } catch (e) {
      this.showError(toAppError(e));
    }
  }

  /** Holds or resumes reading the file of this tab; the next update tells the new state. */
  async toggleFreeze(session: SessionState): Promise<void> {
    if (!session.canFreeze()) return;
    try {
      await this.api.setFrozen(session.id, !session.frozen());
    } catch (e) {
      this.showError(toAppError(e));
    }
  }

  /** Jumps to the next match; the view scrolls because `scroll` and follow change. */
  async find(session: SessionState, forward: boolean): Promise<void> {
    const query = session.query();
    if (!query.text) return;
    const from = session.currentHitLine() ?? session.selection()?.first ?? null;
    try {
      const hit = await this.api.find(session.id, from, query, forward);
      if (!hit) {
        this.showFindMessage(session, 'Keine Treffer');
        return;
      }
      session.setFollow(false);
      session.currentHitLine.set(hit.line);
      session.selection.set({ anchor: hit.line, first: hit.line, last: hit.line });
      session.scroll.set({ top: Math.max(0, hit.position - 5), subPx: 0 });
      this.showFindMessage(session, hit.wrapped ? 'Suche von vorn fortgesetzt' : null);
    } catch (e) {
      const err = toAppError(e);
      if (err.code === 'invalid_search') session.searchError.set(err.message);
      else this.showError(err);
    }
  }

  private showFindMessage(session: SessionState, message: string | null): void {
    session.findMessage.set(message);
    if (message) {
      setTimeout(() => {
        if (session.findMessage() === message) session.findMessage.set(null);
      }, FIND_MESSAGE_MS);
    }
  }

  async selectEntry(session: SessionState, line: number, extend: boolean): Promise<void> {
    try {
      const range = await this.api.getEntryRange(session.id, line);
      const current = session.selection();
      if (extend && current) {
        const anchorStart = Math.min(current.anchor, range.first);
        const end = Math.max(current.anchor, range.last);
        session.selection.set({ anchor: current.anchor, first: anchorStart, last: end });
      } else {
        session.selection.set({ anchor: range.first, first: range.first, last: range.last });
      }
      session.currentHitLine.set(null);
    } catch (e) {
      this.showError(toAppError(e));
    }
  }

  async copySelection(session: SessionState): Promise<void> {
    const selection = session.selection();
    if (!selection) return;
    try {
      const text = await this.api.copyLines(session.id, selection.first, selection.last);
      await writeClipboard(text);
    } catch (e) {
      this.showError(toAppError(e));
    }
  }

  /** The lines of an entry whatever the filter hides (detail panel), complete also beyond its display cut. */
  async copyEntry(session: SessionState, first: number, last: number): Promise<void> {
    try {
      await writeClipboard(await this.api.copyLines(session.id, first, last, 'all'));
    } catch (e) {
      this.showError(toAppError(e));
    }
  }

  showError(error: AppError | string): void {
    this.error.set(typeof error === 'string' ? error : describeError(error));
    if (this.errorTimer) clearTimeout(this.errorTimer);
    this.errorTimer = setTimeout(() => this.error.set(null), ERROR_VISIBLE_MS);
  }
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // WebKit can refuse outside of a user gesture (the text arrives asynchronously).
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}
