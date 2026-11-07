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
import { PageCache } from './page-cache';

export interface ScrollPos {
  top: number;
  subPx: number;
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
  /** Counts filters set from outside the toolbar (sidebar); a search still being typed yields to them. */
  readonly presetRevision = signal(0);

  readonly scroll = signal<ScrollPos>({ top: 0, subPx: 0 });
  readonly scrollLeft = signal(0);
  readonly follow = signal(true);
  /** Number of lines in the view when follow stopped; the badge counts from here. */
  readonly pausedAtCount = signal(0);

  readonly selection = signal<LineSelection | null>(null);
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
      this.currentHitLine.set(null);
      this.pausedAtCount.set(0);
      this.seenErrors = 0;
    } else if (viewChanged) {
      this.onViewChanged();
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
    if (next.columnsRevision !== prev.columnsRevision) this.loadColumns(next.columnsRevision);
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

  private onViewChanged(): void {
    // Stay on the line that was on top; positions changed but line numbers did not.
    const anchor = this.cache.line(this.scroll().top)?.line;
    this.cache.clear();
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
