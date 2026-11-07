import { Signal, computed, linkedSignal, signal } from '@angular/core';
import { LogApi } from '../../core/log/log-api';
import {
  ColumnSet,
  Level,
  SearchMode,
  SearchQuery,
  SessionInfo,
  SessionUpdate,
  SourceInfo,
  Status,
} from '../../core/log/log.models';
import { ALL_SOURCES, mergeKey, mergeTitle, sourceLabels } from '../merge/merge-logic';
import { nextDisplayedLines } from './displayed-lines';
import { ALL_LEVELS } from './filter-logic';
import { isNewerColumns } from './format-logic';
import { KeptFilter, filterActive, jumpScroll } from './navigation-logic';
import { FilterGroupNode, emptyTree, hasFieldConditions } from './filter-tree';
import { PageCache } from './page-cache';

export interface ScrollPos {
  top: number;
  subPx: number;
}

/** Where the last jump (ruler, `E`, `N`, …) went; the next one goes on from there while the view stays. */
export interface JumpMark {
  position: number;
  line: number | null;
  /** The scroll position the jump set: once it changes, the reader moved on by himself. */
  scroll: ScrollPos;
}

export interface LineSelection {
  anchor: number;
  first: number;
  last: number;
}

const TRANSIENT_STATUS_MS = 4000;

/** Everything one tab knows; a single viewport component renders the active one. */
export class SessionState {
  readonly id: number;
  /** Empty for a merge. */
  readonly path: string;
  readonly fileName: string;
  readonly suggestedProfileId: string;
  /** The files of a merge (prompt 006), empty for a single file. */
  readonly sources: readonly SourceInfo[];
  readonly isMerge: boolean;
  /** Same files in any order: the merge is open already. Null for a single file. */
  readonly mergeKey: string | null;
  /** Short names of the sources for the gutter. */
  readonly sourceLabels: readonly string[];
  /** Tooltip of the tab: the path, or the files of a merge. */
  readonly title: string;
  /** Visible sources of a merge (bit = source index). */
  readonly sourceMask = signal(ALL_SOURCES);

  readonly update = signal<SessionUpdate>(null as unknown as SessionUpdate);
  /** How lines split into fields; reloaded when `columnsRevision` changes. */
  readonly columns = signal<ColumnSet | null>(null);
  private columnsRequested = -1;
  readonly cache: PageCache;

  readonly levels = signal<ReadonlySet<Level>>(ALL_LEVELS);
  readonly query = signal<SearchQuery>({ text: '', isRegex: false, caseSensitive: false });
  readonly searchMode = signal<SearchMode>('filter');
  readonly searchError = signal<string | null>(null);
  /** The filter tree of the sidebar (prompt 010); an AND below levels and search. */
  readonly filterTree = signal<FilterGroupNode>(emptyTree());
  /** What the backend said about the tree: the node it is about, if it names one. */
  readonly treeError = signal<{ nodeId: string | null; message: string } | null>(null);
  /** Field conditions are compiled against the columns: a new format needs the filter again. */
  onColumnsChanged: (() => void) | null = null;
  /** Counts filters set from outside the toolbar (sidebar); a search still being typed yields to them. */
  readonly presetRevision = signal(0);

  readonly scroll = signal<ScrollPos>({ top: 0, subPx: 0 });
  readonly scrollLeft = signal(0);
  readonly follow = signal(true);
  /** Number of lines in the view when follow stopped; the badge counts from here. */
  readonly pausedAtCount = signal(0);

  readonly selection = signal<LineSelection | null>(null);
  /** Bookmarks of this tab (line numbers, prompt 007), kept in memory only; a new epoch clears them. */
  readonly bookmarks = signal<ReadonlySet<number>>(new Set());
  /** The filter `revealInFullLog` lifted, for the way back; changing the filter by hand forgets it. */
  readonly keptFilter = signal<KeptFilter | null>(null);
  /** The view hides lines (levels, filtering search, sources of a merge). */
  readonly filterActive = computed(() =>
    filterActive(
      {
        levels: this.levels(),
        query: this.query(),
        mode: this.searchMode(),
        sourceMask: this.sourceMask(),
        tree: this.filterTree(),
      },
      this.sources.length,
    ),
  );
  /**
   * A line to show once the next view is there (`G`). Until the swap `getPosition` answers for the old view,
   * so this waits for the new view generation instead of scrolling right away.
   */
  pendingReveal: number | null = null;
  jumpMark: JumpMark | null = null;
  readonly currentHitLine = signal<number | null>(null);
  readonly findMessage = signal<string | null>(null);

  readonly hasNewErrors = signal(false);
  private seenErrors = 0;
  active = false;

  /** "File rotated" and the like stay visible for a moment. */
  readonly transient = signal<Status | null>(null);
  private transientTimer: ReturnType<typeof setTimeout> | null = null;

  readonly status = computed<Status>(() => this.transient() ?? this.update().status);
  /** The line count of the backend; what the view draws is `displayedLines`. */
  readonly filteredLines = computed(() => this.update().filteredLines);
  readonly frozen = computed(() => this.update().frozen);
  /** A file still loading has no state worth holding on to yet. */
  readonly canFreeze = computed(() => this.update().status.kind !== 'loading');
  readonly newLines = computed(() =>
    this.follow() ? 0 : Math.max(0, this.filteredLines() - this.pausedAtCount()),
  );

  /** Rows the view can show at once; it reports them. */
  readonly visibleRows = signal(40);

  /** The range the view needs next: following, that is the new end before it is drawn. */
  readonly wantedRange = computed(() => {
    const rows = this.visibleRows();
    if (this.follow()) {
      const end = this.filteredLines();
      return { start: Math.max(0, end - rows), end };
    }
    const top = this.scroll().top;
    return { start: top, end: top + rows };
  });

  /** The line count the view draws: it only moves on once the new lines are here. */
  readonly displayedLines: Signal<number> = linkedSignal({
    source: () => {
      const { filteredLines, epoch, viewGeneration } = this.update();
      this.cache.revision();
      return {
        filteredLines,
        epoch,
        viewGeneration,
        follow: this.follow(),
        top: this.scroll().top,
        rows: this.visibleRows(),
      };
    },
    computation: (source, previous) => {
      // Another view: positions start over, there is nothing to hold on to.
      if (
        !previous ||
        previous.source.epoch !== source.epoch ||
        previous.source.viewGeneration !== source.viewGeneration
      ) {
        return source.filteredLines;
      }
      return nextDisplayedLines({
        displayed: previous.value,
        target: source.filteredLines,
        follow: source.follow,
        top: source.top,
        rows: source.rows,
        loaded: this.cache,
      });
    },
  });

  constructor(
    info: SessionInfo,
    private readonly api: LogApi,
  ) {
    this.id = info.sessionId;
    this.path = info.path;
    this.sources = info.sources ?? [];
    this.isMerge = this.sources.length > 0;
    this.fileName = this.isMerge ? mergeTitle(this.sources.length) : info.fileName;
    this.mergeKey = this.isMerge ? mergeKey(this.sources.map((s) => s.path)) : null;
    this.sourceLabels = sourceLabels(this.sources.map((s) => s.fileName));
    this.title = this.isMerge ? this.sources.map((s) => s.path).join('\n') : info.path;
    this.suggestedProfileId = info.suggestedProfileId;
    this.cache = new PageCache((start, count) =>
      this.api.getLines(this.id, 'filtered', start, count),
    );
    this.update.set(info.update);
    this.seenErrors = errorCount(info.update);
    this.loadColumns(info.update.columnsRevision);
  }

  applyUpdate(next: SessionUpdate): void {
    const prev = this.update();
    const viewChanged = next.viewGeneration !== prev.viewGeneration;
    if (next.epoch !== prev.epoch) {
      this.cache.clear();
      this.scroll.set({ top: 0, subPx: 0 });
      this.selection.set(null);
      this.bookmarks.set(new Set());
      this.currentHitLine.set(null);
      this.pausedAtCount.set(0);
      this.seenErrors = 0;
      this.jumpMark = null;
      this.pendingReveal = null;
    } else if (viewChanged) {
      this.onViewChanged();
    } else if (next.retractedFrom !== null && next.retractedFrom !== undefined) {
      // A filter expression took lines out of the end (prompt 010): from there on the view may hold other
      // lines even if the count is the same again.
      this.cache.invalidateTail(Math.min(prev.filteredLines, next.retractedFrom + 1));
    } else if (next.filteredLines !== prev.filteredLines || next.fileSize !== prev.fileSize) {
      this.cache.invalidateTail(prev.filteredLines);
    }
    const errors = errorCount(next);
    if (this.active) {
      this.seenErrors = errors;
    } else if (errors > this.seenErrors) {
      this.hasNewErrors.set(true);
    }
    if (next.status.kind === 'truncated' || next.status.kind === 'rotated') {
      this.showTransient(next.status);
    }
    this.update.set(next);
    if (next.columnsRevision !== prev.columnsRevision) {
      this.loadColumns(next.columnsRevision);
      if (hasFieldConditions(this.filterTree())) this.onColumnsChanged?.();
    }
    if (viewChanged && !this.follow()) this.pausedAtCount.set(next.filteredLines);
  }

  /** The tab comes to the front: what happened is seen now. */
  markSeen(): void {
    this.seenErrors = errorCount(this.update());
    this.hasNewErrors.set(false);
  }

  setFollow(follow: boolean): void {
    if (!follow && this.follow()) this.pausedAtCount.set(this.filteredLines());
    this.follow.set(follow);
  }

  /** Scrolls to a position as a jump: follow off, the next jump goes on from here. */
  jumpTo(position: number, line: number | null): void {
    this.setFollow(false);
    const scroll = jumpScroll(position);
    this.scroll.set(scroll);
    this.jumpMark = { position, line, scroll };
  }

  private onViewChanged(): void {
    // Stay on the line that was on top; positions changed but line numbers did not.
    const anchor = this.cache.line(this.scroll().top)?.line;
    this.cache.clear();
    this.jumpMark = null;
    if (this.pendingReveal !== null) {
      this.revealPending();
      return;
    }
    if (this.follow() || anchor === undefined) {
      if (!this.follow()) this.scroll.set({ top: 0, subPx: 0 });
    } else {
      // If the user scrolled in the meantime, that wins.
      const requestedAt = this.scroll();
      void this.api
        .getPosition(this.id, anchor)
        .catch(() => 0)
        .then((top) => {
          if (this.scroll() === requestedAt) this.scroll.set({ top, subPx: 0 });
        });
    }
  }

  /**
   * Shows `pendingReveal` in the current view (the new one, or the same when the filter did not change it).
   * If the user scrolled in the meantime, that wins.
   */
  revealPending(): void {
    const line = this.pendingReveal;
    if (line === null) return;
    this.pendingReveal = null;
    const requestedAt = this.scroll();
    void this.api
      .getPosition(this.id, line)
      .catch(() => null)
      .then((position) => {
        if (position === null || this.scroll() !== requestedAt) return;
        this.jumpTo(position, line);
      });
  }

  private loadColumns(revision: number): void {
    if (revision <= this.columnsRequested) return;
    this.columnsRequested = revision;
    this.api
      .getColumns(this.id)
      .then((set) => {
        if (isNewerColumns(this.columns(), set)) this.columns.set(set);
      })
      .catch(() => {
        // Without columns the view stays as it is; the next revision asks again.
        if (this.columnsRequested === revision) this.columnsRequested = revision - 1;
      });
  }

  private showTransient(status: Status): void {
    this.transient.set(status);
    if (this.transientTimer) clearTimeout(this.transientTimer);
    this.transientTimer = setTimeout(() => this.transient.set(null), TRANSIENT_STATUS_MS);
  }
}

function errorCount(update: SessionUpdate): number {
  return update.counts.ERROR + update.counts.FATAL;
}
