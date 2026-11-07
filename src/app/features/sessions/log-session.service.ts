import { Injectable, computed, inject, signal } from '@angular/core';
import { LogApi } from '../../core/log/log-api';
import {
  ExtractRule,
  FilterCond,
  FilterInfo,
  LEVELS,
  Level,
  MergeSourceSpec,
  Profile,
  SearchMode,
  SearchQuery,
  SessionInfo,
  SessionUpdate,
  SourceConfig,
  RemoteCredentials,
  SftpConfig,
} from '../../core/log/log.models';
import { addSavedSource, sourceKey } from '../sources/source-logic';
import { ALL_SOURCES, mergeKey, maskForBackend } from '../merge/merge-logic';
import { ALL_LEVELS } from './filter-logic';
import { inheritOnClose, insertIndex, viewLimitReason } from './view-chain';
import { AppError, describeError, toAppError } from '../../core/errors/app-error';
import { SettingsService } from '../../core/settings/settings.service';
import { SessionState } from './session-state';
import { fullLogOf, nextBookmark, toggleBookmark } from './navigation-logic';
import { ShareKind, shareText } from '../share/share-format';
import { MAX_NOTE_LENGTH, isWorkspacePath } from '../workspace/workspace-model';
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

/** Marked text of a line to build an extraction rule from (prompt 011): offsets into the source column's text. */
export interface SelectionDraft {
  /** The text of the source column of the line. */
  text: string;
  start: number;
  end: number;
  column: string;
}

/** The dialog „Felder“ is open for this tab, maybe with marked text to start from. */
export interface FieldsRequest {
  session: SessionState;
  draft: SelectionDraft | null;
}

/** Lines of a selection taken for sharing at most; the text is cut at 64 KB anyway. */
const SHARE_MAX_LINES = 20_000;

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
  /** A short message in the status bar (export finished, workspace saved, prompt 015). */
  readonly notice = signal<string | null>(null);
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  /** The dialog „Felder“ (prompt 011). */
  readonly fieldsDialog = signal<FieldsRequest | null>(null);
  /** The note dialog (prompt 015) for a line of a tab. */
  readonly noteRequest = signal<{ session: SessionState; line: number } | null>(null);
  /** The export dialog (prompt 015) for a tab. */
  readonly exportRequest = signal<SessionState | null>(null);
  /** The dialog „Quelle öffnen“ (prompt 016), maybe with a configuration to start from. */
  readonly sourceRequest = signal<{ config: SourceConfig | null } | null>(null);
  /**
   * Prompt 017: the dialog „Remote-Datei“, prefilled (a remembered connection, a workspace) and with the error that
   * made it open (an unknown host key, a missing password), if any.
   */
  readonly remoteRequest = signal<{ config: SftpConfig | null; error?: AppError | null } | null>(
    null,
  );
  /**
   * Opens a workspace (`.lcw`) given as a path, wherever a path is opened (dialog, path field, drop, command line,
   * recent files). Set by the workspace service, which needs this service itself.
   */
  workspaceOpener: ((path: string) => Promise<AppError | null>) | null = null;
  private errorTimer: ReturnType<typeof setTimeout> | null = null;

  async refreshProfiles(): Promise<void> {
    try {
      await this.api.setCustomProfiles(this.settings.settings().customProfiles);
      await this.api.loadExtractRules(this.settings.settings().extractRules);
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
    if (isWorkspacePath(path) && this.workspaceOpener) return this.workspaceOpener(path);
    const open = tabOfFile(this.sessions().filter((s) => s.path === path));
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
    const open = tabOfFile(this.sessions().filter((s) => s.mergeKey === key));
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

  /**
   * Starts a source without a file (prompt 016) and opens its spool as a tab; a source with the same listener
   * open already is activated. Remembered in the settings (configuration only). Hands a failure (port in use …)
   * to the caller.
   */
  async openSource(
    config: SourceConfig,
    keep: boolean,
    credentials: RemoteCredentials | null = null,
  ): Promise<AppError | null> {
    const key = sourceKey(config);
    const open = tabOfFile(
      this.sessions().filter((s) => s.source !== null && sourceKey(s.source.config) === key),
    );
    // Port 0: chosen by the system (syslog), nothing to open again; for SFTP it means „from ~/.ssh/config“.
    const lasting = config.kind === 'sftp' || config.port !== 0;
    if (open && lasting) {
      this.activate(open.id);
      return null;
    }
    try {
      await this.api.setSpoolLimit(this.settings.settings().spoolLimitMb);
      await this.start((onUpdate) => this.api.openSource(config, keep, onUpdate, credentials));
      if (lasting) {
        this.settings.update({
          savedSources: addSavedSource(this.settings.settings().savedSources, { config, keep }),
        });
      }
      return null;
    } catch (e) {
      return toAppError(e);
    }
  }

  /** Keep the spool of a source when its tab closes (prompt 016). */
  async setSpoolKeep(session: SessionState, keep: boolean): Promise<void> {
    if (!session.isSource) return;
    const before = session.keepSpool();
    session.keepSpool.set(keep);
    try {
      await this.api.setSpoolKeep(session.sessionId, keep);
    } catch (e) {
      session.keepSpool.set(before);
      this.showError(toAppError(e));
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
    created.onLoaded = () => void this.suggestOnOpen(created);
    for (const update of early) state.applyUpdate(update);
    created.notifyLoaded();
    this.sessions.update((all) => [...all, state as SessionState]);
    this.activate(state.id);
    return info;
  }

  /** Merges the files of a merge tab again, late lines in their place. */
  async resort(session: SessionState): Promise<void> {
    if (!session.isMerge) return;
    try {
      await this.api.resort(session.sessionId);
    } catch (e) {
      this.showError(toAppError(e));
    }
  }

  /** Visible sources of a merge (source chips). */
  async setSources(session: SessionState, mask: number): Promise<void> {
    session.sourceMask.set(mask);
    await this.applyFilter(session);
  }

  /**
   * Closes a tab. A filter tab closes only its view (prompt 013): the tabs below it keep their result, the backend
   * hands its filter down. The last tab of a file closes the session.
   */
  async close(id: number): Promise<void> {
    const all = this.sessions();
    const index = all.findIndex((s) => s.id === id);
    if (index < 0) return;
    const closing = all[index];
    const rest = all.filter((s) => s.id !== id);
    const others = rest.filter((s) => s.sessionId === closing.sessionId);
    for (const child of others.filter((s) => s.parent() === closing)) {
      const next = inheritOnClose(
        {
          parentId: closing.parent()?.id ?? null,
          inherited: closing.inherited(),
          own: closing.ownLabel(),
        },
        { inherited: child.inherited() },
      );
      child.parent.set(closing.parent());
      child.inherited.set(next.inherited);
    }
    this.cancelTreeTimer(closing);
    this.sessions.set(rest);
    if (this.activeId() === id) {
      const next = rest[Math.min(index, rest.length - 1)];
      this.activate(next ? next.id : null);
    }
    try {
      if (others.length) await this.api.closeView(closing.sessionId, closing.viewId);
      else await this.api.close(closing.sessionId);
    } catch (e) {
      this.showError(toAppError(e));
    }
  }

  /** Why no further filter tab can open for the file of this tab, or null (prompt 013). */
  filterTabLimit(session: SessionState): string | null {
    return viewLimitReason(this.sessions(), session.sessionId);
  }

  /**
   * Opens a filter as a new tab right of `parent` (prompt 013): it shows the result of `parent` and filters further
   * with its own filter, empty or the given start (a condition, levels, sources). Changes above follow live.
   */
  async openFilterTab(
    parent: SessionState,
    start: {
      cond?: FilterCond;
      levels?: ReadonlySet<Level>;
      sourceMask?: number;
      /** A whole filter (a workspace, prompt 015) instead of one condition. */
      tree?: FilterGroupNode;
      query?: SearchQuery;
      mode?: SearchMode;
    } = {},
  ): Promise<SessionState | null> {
    const limit = this.filterTabLimit(parent);
    if (limit) {
      this.showError(limit);
      return null;
    }
    const tree = start.tree
      ? sanitizeTree(structuredClone(start.tree))
      : start.cond
        ? addNode(emptyTree(), ROOT_ID, condNode(start.cond))
        : emptyTree();
    const levels = start.levels ?? ALL_LEVELS;
    const sourceMask = start.sourceMask ?? ALL_SOURCES;
    const query = start.query ?? { text: '', isRegex: false, caseSensitive: false };
    const mode = start.mode ?? 'filter';
    let state: SessionState | null = null;
    const early: SessionUpdate[] = [];
    try {
      const view = await this.api.openView(
        parent.sessionId,
        parent.viewId,
        {
          levels: [...levels],
          query,
          mode,
          sources: maskForBackend(sourceMask, parent.sources.length),
          expr: compileTree(tree),
        },
        (update) => {
          if (state) state.applyUpdate(update);
          else early.push(update);
        },
      );
      state = new SessionState(parent.info, this.api, {
        tabId: nextTabId(),
        viewId: view.viewId,
        parent,
        update: view.update,
      });
    } catch (e) {
      this.showError(toAppError(e));
      return null;
    }
    const created = state;
    created.levels.set(levels);
    created.sourceMask.set(sourceMask);
    created.filterTree.set(tree);
    created.query.set({ ...query });
    created.searchMode.set(mode);
    created.onColumnsChanged = () => void this.applyFilter(created, true);
    for (const update of early) created.applyUpdate(update);
    if (!this.sessions().includes(parent)) {
      // The parent closed while the view opened: nothing to show it under.
      void this.api.closeView(created.sessionId, created.viewId).catch(() => undefined);
      return null;
    }
    this.sessions.update((all) => {
      const next = [...all];
      next.splice(insertIndex(all, parent.id), 0, created);
      return next;
    });
    this.activate(created.id);
    return created;
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
        session.sessionId,
        [...session.levels()],
        session.query(),
        session.searchMode(),
        maskForBackend(session.sourceMask(), session.sources.length),
        expr,
        session.viewId,
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
    const hint = session.revealHint;
    session.revealHint = null;
    // A line the dashboard jumped to and the filter hides goes first, while the view is still there.
    const hinted = hint && session.scroll() === hint.mark.scroll ? hint.line : null;
    const selection = hinted !== null ? { anchor: hinted } : session.selection();
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

  // ---- Dashboard (prompt 012) ----

  /** Log or dashboard for a tab. */
  setMode(session: SessionState, mode: 'log' | 'dashboard'): void {
    session.mode.set(mode);
  }

  toggleDashboard(session: SessionState): void {
    this.setMode(session, session.mode() === 'dashboard' ? 'log' : 'dashboard');
  }

  /**
   * From the dashboard to a line (0-based index): back to the log, scrolled there like `E`/`W`, the selection
   * stays. A line the filter hides: to the next visible one, and `G` shows it in the whole log.
   */
  async showLine(session: SessionState, line: number): Promise<void> {
    try {
      const position = await this.api.getPosition(session.sessionId, line, session.viewId);
      const [there] = await this.api.getLines(
        session.sessionId,
        'filtered',
        position,
        1,
        session.viewId,
      );
      this.setMode(session, 'log');
      session.jumpTo(position, line);
      if (there?.line !== line) {
        session.revealHint = {
          line,
          mark: session.jumpMark as NonNullable<typeof session.jumpMark>,
        };
        this.showFindMessage(
          session,
          `Zeile ${line + 1} ist ausgefiltert – G zeigt sie im Gesamtlog`,
        );
      } else {
        session.revealHint = null;
        this.showFindMessage(session, `Zeile ${line + 1}`);
      }
    } catch (e) {
      this.showError(toAppError(e));
    }
  }

  /**
   * A bar without a time axis (`GROUP BY logger`) as a filter tab (prompt 013, drill-down): level → levels,
   * source → that file of a merge, a field of the log → field condition, below the tab of the dashboard. The
   * dashboard stays as it is; the new tab shows the log.
   */
  async filterFromDashboard(
    session: SessionState,
    column: { sql: string; log: string | null },
    value: string,
  ): Promise<boolean> {
    const name = column.sql.toLowerCase();
    let start: Parameters<LogSessionService['openFilterTab']>[1] | null = null;
    if (name === 'level' && (LEVELS as readonly string[]).includes(value)) {
      start = { levels: new Set([value as Level]) };
    } else if (session.isMerge && (name === 'source' || name === 'quelle')) {
      const index = session.sources.findIndex(
        (s) => String(s.index) === value || s.fileName === value,
      );
      if (index >= 0) start = { sourceMask: 1 << session.sources[index].index };
    }
    if (!start && column.log) {
      start = {
        cond: {
          type: 'field',
          column: column.log,
          op: 'eq',
          value: value.trim().slice(0, 4096),
          value2: null,
          caseSensitive: false,
        },
      };
    }
    if (!start) return false;
    return (await this.openFilterTab(session, start)) !== null;
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
        session.sessionId,
        from,
        forward,
        kind === 'error' ? ERROR_LEVELS : WARN_LEVELS,
        session.viewId,
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
      const hit = await this.api.findLevel(session.sessionId, from, true, levels, session.viewId);
      if (hit) session.jumpTo(hit.position, hit.line);
      else session.jumpTo(fallback, null);
    } catch (e) {
      this.showError(toAppError(e));
    }
  }

  /**
   * Timeline (prompt 014): to the first entry at or after `ts` (microseconds, UTC) in the tab's view; the
   * selection stays, following stops.
   */
  async jumpToTime(session: SessionState, ts: number): Promise<void> {
    try {
      const hit = await this.api.positionAtTime(session.sessionId, ts, session.viewId);
      if (hit) session.jumpTo(hit.position, hit.line);
      else this.showFindMessage(session, 'Keine Zeitstempel im Log');
    } catch (e) {
      this.showError(toAppError(e));
    }
  }

  /** Timeline: a time window as a condition of the tab's own filter tree (texts as the log writes times). */
  filterTimeWindow(session: SessionState, from: string, to: string): void {
    this.addCondition(session, { type: 'time', from, to });
    this.showFindMessage(session, `Gefiltert auf Zeit ${from} – ${to}`);
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

  // ---------------------------------------------------------------- notes and sharing (prompt 015)

  /** `Shift+M`: the note of the selected entry (its head line), to write, change or delete. */
  openNote(session: SessionState, line: number | null = session.selection()?.anchor ?? null): void {
    if (line === null) {
      this.showFindMessage(session, 'Keine Zeile gewählt');
      return;
    }
    this.noteRequest.set({ session, line });
  }

  /** Writes a note; an empty text removes it. */
  setNote(session: SessionState, line: number, text: string): void {
    const clean = text.trim().slice(0, MAX_NOTE_LENGTH);
    const next = new Map(session.notes());
    const had = next.has(line);
    if (clean) next.set(line, clean);
    else next.delete(line);
    session.notes.set(next);
    this.showFindMessage(
      session,
      clean ? (had ? 'Notiz geändert' : 'Notiz gesetzt') : had ? 'Notiz entfernt' : null,
    );
  }

  /**
   * The selection for a ticket (prompt 015): head with file, lines, time and filter, the text as a code block,
   * the notes in it as a list; Markdown or Jira, into the clipboard, at most 64 KB.
   */
  async shareSelection(session: SessionState, kind: ShareKind): Promise<void> {
    const selection = session.selection();
    if (!selection) {
      this.showFindMessage(session, 'Keine Zeile gewählt');
      return;
    }
    const last = Math.min(selection.last, selection.first + SHARE_MAX_LINES - 1);
    try {
      const text = await this.api.copyLines(
        session.sessionId,
        selection.first,
        last,
        'filtered',
        session.viewId,
      );
      const timeIndex = session.columns()?.columns.findIndex((c) => c.kind === 'timestamp') ?? -1;
      const timeOf = async (line: number): Promise<string | null> => {
        if (timeIndex < 0) return null;
        const range = await this.api.getEntryRange(session.sessionId, line);
        const [head] = await this.api.getLines(session.sessionId, 'all', range.first, 1);
        const span = head?.fields[timeIndex];
        return head && span && span[1] > span[0] ? head.text.slice(span[0], span[1]) : null;
      };
      const steps =
        session.viewId === 0 ? (session.ownLabel() ? [session.ownLabel()] : []) : session.steps();
      const notes = [...session.notes()]
        .filter(([line]) => line >= selection.first && line <= last)
        .sort((a, b) => a[0] - b[0])
        .map(([line, note]) => ({ line, text: note }));
      const result = shareText(kind, {
        file: session.fileName,
        first: selection.first,
        last,
        lineCount: text ? text.replace(/\n$/, '').split('\n').length : 0,
        from: await timeOf(selection.first),
        to: await timeOf(last),
        filter: steps.length ? steps.join(' › ') : null,
        text,
        notes,
        more: last < selection.last,
      });
      await writeClipboard(result.text);
      const what = kind === 'markdown' ? 'Markdown' : 'Jira';
      this.showFindMessage(
        session,
        result.truncated
          ? `Als ${what} kopiert, gekürzt auf 64 KB – mehr per Export`
          : `Als ${what} kopiert`,
      );
    } catch (e) {
      this.showError(toAppError(e));
    }
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
      const position = await this.api.getPosition(session.sessionId, next.line, session.viewId);
      session.jumpTo(position, next.line);
      this.showFindMessage(session, next.wrapped ? wrappedText(forward) : null);
    } catch (e) {
      this.showError(toAppError(e));
    }
  }

  async setProfile(session: SessionState, profileId: string): Promise<void> {
    try {
      await this.api.setProfile(session.sessionId, profileId);
    } catch (e) {
      this.showError(toAppError(e));
    }
  }

  /** Holds or resumes reading the file of this tab; the next update tells the new state. */
  async toggleFreeze(session: SessionState): Promise<void> {
    if (!session.canFreeze()) return;
    try {
      await this.api.setFrozen(session.sessionId, !session.frozen());
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
      const hit = await this.api.find(session.sessionId, from, query, forward, session.viewId);
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
      const range = await this.api.getEntryRange(session.sessionId, line);
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
      const text = await this.api.copyLines(
        session.sessionId,
        selection.first,
        selection.last,
        'filtered',
        session.viewId,
      );
      await writeClipboard(text);
    } catch (e) {
      this.showError(toAppError(e));
    }
  }

  /** The lines of an entry whatever the filter hides (detail panel), complete also beyond its display cut. */
  async copyEntry(session: SessionState, first: number, last: number): Promise<void> {
    try {
      await writeClipboard(await this.api.copyLines(session.sessionId, first, last, 'all'));
    } catch (e) {
      this.showError(toAppError(e));
    }
  }

  // ---------------------------------------------------------------- extracted fields (prompt 011)

  /** The rules of the profile of a tab's format, as saved. */
  rulesOf(session: SessionState): ExtractRule[] {
    const profileId = session.columns()?.profileId;
    return profileId ? (this.settings.settings().extractRules[profileId] ?? []) : [];
  }

  openFields(session: SessionState, draft: SelectionDraft | null = null): void {
    this.fieldsDialog.set({ session, draft });
  }

  /**
   * Fields in the background on opening: only for a format without rules, once per profile, never as a dialog
   * (the tail runs). What is found waits as a hint in the status bar.
   */
  private async suggestOnOpen(session: SessionState): Promise<void> {
    try {
      const set = await this.api.getColumns(session.sessionId);
      const { extractRules, fieldHints } = this.settings.settings();
      if (extractRules[set.profileId]?.length || fieldHints.includes(set.profileId)) return;
      if (session.update().totalLines === 0) return;
      const found = await this.api.suggestFields(session.sessionId);
      if (!found.length || !this.sessions().includes(session)) return;
      session.fieldHint.set(found);
      this.settings.update({ fieldHints: [...this.settings.settings().fieldHints, set.profileId] });
    } catch {
      // A hint is a convenience: no backend, a closed tab or an unreadable file just shows none.
    }
  }

  /**
   * New rules for the profile of the tab's format: the backend checks them and applies them to every open tab of
   * the profile, then they are saved. A failure comes back (with the rule in `nodeId`) and changes nothing.
   */
  async setExtractRules(
    session: SessionState,
    rules: readonly ExtractRule[],
  ): Promise<AppError | null> {
    try {
      const set = await this.api.setExtractRules(session.sessionId, rules);
      for (const tab of this.sessions())
        if (tab.sessionId === session.sessionId) tab.acceptColumns(set);
      const all = { ...this.settings.settings().extractRules };
      if (rules.length) all[set.profileId] = rules.map((r) => ({ ...r }));
      else delete all[set.profileId];
      this.settings.update({ extractRules: all });
      return null;
    } catch (e) {
      return toAppError(e);
    }
  }

  showNotice(text: string): void {
    this.notice.set(text);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => this.notice.set(null), ERROR_VISIBLE_MS);
  }

  showError(error: AppError | string): void {
    this.error.set(typeof error === 'string' ? error : describeError(error));
    if (this.errorTimer) clearTimeout(this.errorTimer);
    this.errorTimer = setTimeout(() => this.error.set(null), ERROR_VISIBLE_MS);
  }
}

/** Tab ids of filter tabs: far above the session ids the backend counts up. */
let tabIds = 1 << 30;
function nextTabId(): number {
  return ++tabIds;
}

/** The tab a file opens to again: its own tab (view 0), else its first filter tab. */
function tabOfFile(tabs: readonly SessionState[]): SessionState | undefined {
  return tabs.find((t) => t.viewId === 0) ?? tabs[0];
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
