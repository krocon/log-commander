import { Injectable, computed, inject, signal } from '@angular/core';
import { LogApi } from '../../core/log/log-api';
import {
  FilterCond,
  FilterInfo,
  Level,
  MergeSourceSpec,
  Profile,
  SearchMode,
  SearchQuery,
  SessionInfo,
  SessionUpdate,
} from '../../core/log/log.models';
import { mergeKey, maskForBackend } from '../merge/merge-logic';
import { AppError, describeError, toAppError } from '../../core/errors/app-error';
import { SettingsService } from '../../core/settings/settings.service';
import { SessionState } from './session-state';
import { fullLogOf, nextBookmark, toggleBookmark } from './navigation-logic';
import {
  FilterGroupNode,
  ROOT_ID,
  addNode,
  compileTree,
  condNode,
  emptyTree,
  sanitizeTree,
} from './filter-tree';

/** Changes of the filter tree in a row are bundled into one filter job. */
export const TREE_DEBOUNCE_MS = 150;

/** Levels `E` and `W` jump to: errors, or warnings and worse. */
const ERROR_LEVELS: readonly Level[] = ['ERROR', 'FATAL'];
const WARN_LEVELS: readonly Level[] = ['WARN', 'ERROR', 'FATAL'];

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
    try {
      const info = await this.start((onUpdate) =>
        this.api.open(path, this.settings.settings().keepOnRotate, onUpdate),
      );
      this.settings.addRecentFile(info.path);
      return null;
    } catch (e) {
      const err = toAppError(e);
      if (err.code === 'not_found') this.settings.removeRecentFile(path);
      return err;
    }
  }

  /**
   * Opens several files as one tab (prompt 006), or activates the merge of the same files. A merge has no
   * path: it is recognised by its sorted paths. It does not go into the recent files.
   */
  async openMerged(sources: readonly MergeSourceSpec[]): Promise<AppError | null> {
    const key = mergeKey(sources.map((s) => s.path));
    const open = this.sessions().find((s) => s.mergeKey === key);
    if (open) {
      this.activate(open.id);
      return null;
    }
    try {
      await this.start((onUpdate) =>
        this.api.openMerged(sources, this.settings.settings().keepOnRotate, onUpdate),
      );
      return null;
    } catch (e) {
      return toAppError(e);
    }
  }

  /** Creates the tab of a session the backend opens; updates may overtake the answer, they wait. */
  private async start(
    open: (onUpdate: (update: SessionUpdate) => void) => Promise<SessionInfo>,
  ): Promise<SessionInfo> {
    let state: SessionState | null = null;
    const early: SessionUpdate[] = [];
    const info = await open((update) => {
      if (state) state.applyUpdate(update);
      else early.push(update);
    });
    state = new SessionState(info, this.api);
    const created = state;
    created.onColumnsChanged = () => void this.applyFilter(created, true);
    for (const update of early) state.applyUpdate(update);
    this.sessions.update((all) => [...all, state as SessionState]);
    this.activate(state.id);
    return info;
  }

  /** Merges the files of a merge tab again, late lines in their place. */
  async resort(session: SessionState): Promise<void> {
    if (!session.isMerge) return;
    try {
      await this.api.resort(session.id);
    } catch (e) {
      this.showError(toAppError(e));
    }
  }

  /** Visible sources of a merge (source chips). */
  async setSources(session: SessionState, mask: number): Promise<void> {
    session.sourceMask.set(mask);
    await this.applyFilter(session);
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
    preset: {
      levels: Iterable<Level>;
      query: SearchQuery;
      mode: SearchMode;
      tree?: FilterGroupNode;
    },
  ): Promise<void> {
    session.levels.set(new Set(preset.levels));
    session.query.set({ ...preset.query });
    session.searchMode.set(preset.mode);
    // A copy: editing the tree of the tab must not change the saved one.
    session.filterTree.set(preset.tree ? sanitizeTree(structuredClone(preset.tree)) : emptyTree());
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

  /**
   * Sends the tab's filter to the backend. A filter set by hand forgets the one `revealInFullLog` kept;
   * `keep` is for that way and back.
   */
  private async applyFilter(session: SessionState, keep = false): Promise<FilterInfo | null> {
    if (!keep) session.keptFilter.set(null);
    this.cancelTreeTimer(session);
    const expr = compileTree(session.filterTree());
    try {
      const info = await this.api.setFilter(
        session.id,
        [...session.levels()],
        session.query(),
        session.searchMode(),
        maskForBackend(session.sourceMask(), session.sources.length),
        expr,
      );
      session.searchError.set(null);
      session.treeError.set(null);
      return info;
    } catch (e) {
      const err = toAppError(e);
      if (err.code === 'invalid_search' && err.nodeId) {
        session.treeError.set({ nodeId: err.nodeId, message: err.message });
      } else if (err.code === 'invalid_search') {
        session.searchError.set(err.message);
      } else {
        this.showError(err);
      }
      return null;
    }
  }

  // ---------------------------------------------------------------- filter tree (prompt 010)

  private readonly treeTimers = new Map<SessionState, ReturnType<typeof setTimeout>>();

  private cancelTreeTimer(session: SessionState): void {
    const timer = this.treeTimers.get(session);
    if (timer !== undefined) clearTimeout(timer);
    this.treeTimers.delete(session);
  }

  /**
   * A new tree for the tab. Changes in a row (typing in the form, several clicks) start one filter job
   * after `TREE_DEBOUNCE_MS`; a running job is cancelled by the backend's generation anyway.
   */
  setTree(session: SessionState, tree: FilterGroupNode): void {
    session.filterTree.set(tree);
    session.keptFilter.set(null);
    this.cancelTreeTimer(session);
    this.treeTimers.set(
      session,
      setTimeout(() => {
        this.treeTimers.delete(session);
        void this.applyFilter(session);
      }, TREE_DEBOUNCE_MS),
    );
  }

  /** Adds a condition to the group `parentId` (default the top) and returns the new node's id. */
  addCondition(
    session: SessionState,
    cond: FilterCond,
    options: { parentId?: string; negate?: boolean } = {},
  ): string {
    const node = condNode(cond, options.negate ?? false);
    this.setTree(session, addNode(session.filterTree(), options.parentId ?? ROOT_ID, node));
    return node.id;
  }

  /** Quick way: text marked in a line (context menu, `I`). Literal, ignoring case. */
  filterOnText(session: SessionState, text: string, negate = false): void {
    // A selection over several rows: the first line of it (a condition looks at one line).
    const first = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
    const trimmed = first.trim().slice(0, 4096);
    if (!trimmed) {
      this.showFindMessage(session, 'Kein Text markiert');
      return;
    }
    this.addCondition(
      session,
      { type: 'text', text: trimmed, isRegex: false, caseSensitive: false },
      { negate },
    );
    this.showFindMessage(session, `Gefiltert auf „${trimmed.slice(0, 40)}“`);
  }

  /** Quick way: the section from the selected entry on, or up to its end (line numbers). */
  filterSection(session: SessionState, edge: 'from' | 'to'): void {
    const selection = session.selection();
    if (!selection) {
      this.showFindMessage(session, 'Keine Zeile gewählt');
      return;
    }
    this.addCondition(
      session,
      edge === 'from'
        ? { type: 'lines', first: selection.first, last: null }
        : { type: 'lines', first: null, last: selection.last },
    );
  }

  /** Quick way with columns (prompt 009): the value of a cell. */
  filterByValue(session: SessionState, column: string, value: string): void {
    this.addCondition(session, {
      type: 'field',
      column,
      op: 'eq',
      value: value.trim().slice(0, 4096),
      value2: null,
      caseSensitive: false,
    });
  }

  /**
   * The selected line in the whole log (prompt 007, `G`): levels, sources and a filtering search are lifted
   * in one filter call (the search stays as highlighting), the filter is kept for `returnToFilter`. The
   * selection stays; the scroll waits for the new view (`pendingReveal`).
   */
  async revealInFullLog(session: SessionState): Promise<void> {
    const selection = session.selection();
    if (!selection) {
      this.showFindMessage(session, 'Keine Zeile gewählt');
      return;
    }
    if (!session.filterActive()) {
      this.showFindMessage(session, 'Kein Filter aktiv');
      return;
    }
    const kept = {
      levels: session.levels(),
      query: session.query(),
      mode: session.searchMode(),
      sourceMask: session.sourceMask(),
      tree: session.filterTree(),
    };
    await this.switchFilter(session, fullLogOf(kept), selection.anchor);
    session.keptFilter.set(kept);
  }

  /** Back to the filter `revealInFullLog` kept, showing the selected line if the filter has it. */
  async returnToFilter(session: SessionState): Promise<void> {
    const kept = session.keptFilter();
    if (!kept) return;
    session.keptFilter.set(null);
    await this.switchFilter(session, kept, session.selection()?.anchor ?? null);
  }

  /** `G`: to the whole log, or back to the kept filter. */
  async toggleFullLog(session: SessionState): Promise<void> {
    if (session.keptFilter()) await this.returnToFilter(session);
    else await this.revealInFullLog(session);
  }

  private async switchFilter(
    session: SessionState,
    filter: {
      levels: ReadonlySet<Level>;
      query: SearchQuery;
      mode: SearchMode;
      sourceMask: number;
      tree: FilterGroupNode;
    },
    reveal: number | null,
  ): Promise<void> {
    session.levels.set(filter.levels);
    session.query.set(filter.query);
    session.searchMode.set(filter.mode);
    session.sourceMask.set(filter.sourceMask);
    session.filterTree.set(filter.tree);
    session.presetRevision.update((r) => r + 1);
    if (reveal !== null) {
      session.setFollow(false);
      session.pendingReveal = reveal;
    }
    const info = await this.applyFilter(session, true);
    // The update with the new view may have come first and shown the line already.
    if (session.pendingReveal === reveal && reveal !== null) {
      if (!info) session.pendingReveal = null;
      else if (session.update().viewGeneration === info.viewGeneration) session.revealPending();
    }
  }

  /** `E`/`W`: next (previous) entry of errors, or of warnings and worse, in the view; the selection stays. */
  async jumpToLevel(
    session: SessionState,
    kind: 'error' | 'warn',
    forward: boolean,
  ): Promise<void> {
    const mark = session.jumpMark;
    const scroll = session.scroll();
    let from: number | null;
    if (mark && mark.scroll === scroll) from = mark.position;
    else if (forward) from = scroll.top > 0 ? scroll.top - 1 : null;
    else from = scroll.top;
    try {
      const hit = await this.api.findLevel(
        session.id,
        from,
        forward,
        kind === 'error' ? ERROR_LEVELS : WARN_LEVELS,
      );
      if (!hit) {
        this.showFindMessage(
          session,
          kind === 'error' ? 'Keine Fehler in der Ansicht' : 'Keine Warnungen in der Ansicht',
        );
        return;
      }
      session.jumpTo(hit.position, hit.line);
      this.showFindMessage(session, hit.wrapped ? wrappedText(forward) : null);
    } catch (e) {
      this.showError(toAppError(e));
    }
  }

  /** A position from the overview ruler (or a mark's entry), the selection stays. */
  async jumpToRulerLevel(
    session: SessionState,
    from: number | null,
    levels: readonly Level[],
    fallback: number,
  ): Promise<void> {
    try {
      const hit = await this.api.findLevel(session.id, from, true, levels);
      if (hit) session.jumpTo(hit.position, hit.line);
      else session.jumpTo(fallback, null);
    } catch (e) {
      this.showError(toAppError(e));
    }
  }

  /** `M`: bookmark on the head of the selected entry, or off again. */
  toggleBookmark(session: SessionState): void {
    const selection = session.selection();
    if (!selection) {
      this.showFindMessage(session, 'Keine Zeile gewählt');
      return;
    }
    const had = session.bookmarks().has(selection.anchor);
    session.bookmarks.set(toggleBookmark(session.bookmarks(), selection.anchor));
    this.showFindMessage(session, had ? 'Lesezeichen entfernt' : 'Lesezeichen gesetzt');
  }

  /** `N`/`Shift+N`: next (previous) bookmark, from the last jump or the top of the view. */
  async jumpToBookmark(session: SessionState, forward: boolean): Promise<void> {
    const mark = session.jumpMark;
    const exact = mark !== null && mark.scroll === session.scroll() && mark.line !== null;
    const from =
      exact && mark ? mark.line : (session.cache.line(session.scroll().top)?.line ?? null);
    const next = nextBookmark(session.bookmarks(), from, forward, !exact && forward);
    if (!next) {
      this.showFindMessage(session, 'Keine Lesezeichen');
      return;
    }
    try {
      const position = await this.api.getPosition(session.id, next.line);
      session.jumpTo(position, next.line);
      this.showFindMessage(session, next.wrapped ? wrappedText(forward) : null);
    } catch (e) {
      this.showError(toAppError(e));
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

  showFindMessage(session: SessionState, message: string | null): void {
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

function wrappedText(forward: boolean): string {
  return forward ? 'Von vorn fortgesetzt' : 'Von hinten fortgesetzt';
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
