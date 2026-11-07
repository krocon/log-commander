import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewEncapsulation,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { TableSignalComponent } from '@guiexpert/angular-table';
import {
  ColumnDef,
  GeMouseEvent,
  GeScrollEvent,
  Size,
  TableApi,
  TableFactory,
  TableOptions,
} from '@guiexpert/table';
import { SettingsService } from '../../core/settings/settings.service';
import { formatCount } from '../../shared/format';
import {
  ViewMetrics,
  bottomAnchor,
  clampToBottom,
  scrollBy,
  visibleRowCount,
} from './viewport-logic';
import { LogSessionService } from '../sessions/log-session.service';
import { SessionState } from '../sessions/session-state';
import { COL_NUMBER, COL_TEXT, LogAreaModel } from './log-area-model';
import {
  contentTop,
  contentTopFromScrollbar,
  holdForSelection,
  posFromContentTop,
  textColumnWidth,
} from './table-logic';

const LINE_HEIGHT_FACTOR = 1.5;
const WHEEL_LINE_PX = 40;

/**
 * The log in the GuiExpert Table (prompt 003). Own scroll model (line + pixel offset, `viewport-logic.ts`); the table
 * only draws that position, one render pass per update. Fixed row height, no wrapping.
 */
@Component({
  selector: 'app-log-table-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [TableSignalComponent],
  host: {
    class: 'lt-host',
    '[style.--row-h.px]': 'rowH()',
    '[style.--font-size.px]': 'fontSize()',
  },
  template: `
    <guiexpert-table-signal
      class="lt-table"
      [tableModel]="model"
      [tableOptions]="options"
      [debounceMouseClickDelay]="0"
      [(tableApi)]="api"
      (scroll)="onTableScroll($event)"
      (mouseClicked)="onTableClick($event)"
    />
    @if (session().filteredLines() === 0) {
      <div class="lt-empty">{{ emptyText() }}</div>
    }
    @if (session().newLines() > 0) {
      <button type="button" class="new-lines" (click)="jumpToEnd()">
        ▼ {{ formatCount(session().newLines()) }} neue Zeilen
      </button>
    } @else if (!session().follow()) {
      <button type="button" class="new-lines quiet" (click)="jumpToEnd()">▼ Ans Ende</button>
    }
  `,
  styleUrl: './log-table-view.css',
})
export class LogTableViewComponent implements OnInit, OnDestroy {
  readonly session = input.required<SessionState>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly settings = inject(SettingsService).settings;
  private readonly sessions = inject(LogSessionService);

  protected readonly formatCount = formatCount;
  protected readonly fontSize = computed(() => this.settings().fontSize);
  protected readonly lineNumbers = computed(() => this.settings().showLineNumbers);
  protected readonly rowH = computed(() => Math.round(this.fontSize() * LINE_HEIGHT_FACTOR));

  protected readonly api = signal<TableApi | undefined>(undefined);
  private readonly viewportH = signal(400);
  private readonly viewportW = signal(800);
  /** Bumped to draw again without another input changing (wider text, released selection). */
  private readonly redraw = signal(0);

  protected readonly model = TableFactory.createTableModel({
    bodyAreaModel: new LogAreaModel(
      () => this.session(),
      () => this.rowH(),
    ),
    columnDefs: [
      new ColumnDef('number', '', new Size(60, 'px')),
      new ColumnDef('text', '', new Size(800, 'px')),
    ],
    fixedLeftColumnCount: 1,
  });

  protected readonly options = {
    ...new TableOptions(),
    hoverRowVisible: false,
    hoverColumnVisible: false,
    columnsResizable: false,
    columnsDraggable: false,
    horizontalBorderVisible: false,
    verticalBorderVisible: false,
    headerSeparatorBorderVisible: false,
    fixedWestSeparatorBorderVisible: false,
    tableTopBorderVisible: false,
    tableBottomBorderVisible: false,
    shortcutActionsDisabled: true,
    ariaLabel: 'Logzeilen',
  };

  private readonly metrics = computed<ViewMetrics>(() => ({
    count: this.session().displayedLines(),
    viewportH: this.viewportH(),
    rowH: this.rowH(),
  }));

  protected readonly emptyText = computed(() => {
    const update = this.session().update();
    if (update.filterPending) return 'Filter wird berechnet …';
    if (update.totalLines === 0) return 'Datei ist leer, warte auf neue Zeilen …';
    return `Keine passenden Zeilen (${formatCount(update.totalLines)} ausgeblendet)`;
  });

  /** What the table drew last; a hard repaint only when count or height changed. */
  private drawn = { count: -1, rowH: -1, top: -1, left: -1 };
  private expectedScrollTop = -1;
  private widestText = 0;
  private textWidth = 800;
  private heldForSelection = false;
  private holds = 0;
  private resizeObserver: ResizeObserver | null = null;

  /** Frame times of `draw()`, for measurements (`window.__lcTable`, `scripts/e2e/spike-003.js`). */
  private readonly drawTimes: number[] = [];

  constructor() {
    effect(() => {
      const session = this.session();
      if (session.follow()) session.scroll.set(bottomAnchor(this.metrics()));
    });
    effect(() => {
      const session = this.session();
      const metrics = this.metrics();
      const pos = untracked(session.scroll);
      if (!untracked(session.follow)) {
        const clamped = clampToBottom(pos, metrics);
        if (clamped.atBottom && (clamped.pos.top !== pos.top || clamped.pos.subPx !== pos.subPx)) {
          session.scroll.set(clamped.pos);
        }
      }
    });
    effect(() => {
      this.session().visibleRows.set(visibleRowCount(this.viewportH(), this.rowH()));
    });
    effect(() => {
      const session = this.session();
      session.cache.revision();
      const top = session.scroll().top;
      session.cache.ensure(top, top + session.visibleRows());
      const wanted = session.wantedRange();
      session.cache.ensure(wanted.start, wanted.end);
    });
    effect(() => {
      this.session();
      this.widestText = 0;
    });
    effect(() => {
      const api = this.api();
      const lineNumbers = this.lineNumbers();
      if (!api) return;
      // The table renders right away and reads the area model, whose signals must not become
      // dependencies of this effect (every update would repaint, a text selection would be lost).
      untracked(() => {
        api.setHeaderVisible(false);
        api.setColumnVisible(COL_NUMBER, lineNumbers);
        this.redraw.update((r) => r + 1);
      });
    });
    effect(() => {
      const api = this.api();
      if (!api) return;
      // Everything the picture depends on.
      const session = this.session();
      const state = {
        count: session.displayedLines(),
        rowH: this.rowH(),
        pos: session.scroll(),
        left: session.scrollLeft(),
        revision: session.cache.revision(),
        marks: `${JSON.stringify(session.selection())}|${session.currentHitLine()}|${session.update().totalLines}`,
        follow: session.follow(),
      };
      void [this.viewportW(), this.redraw()];
      untracked(() => this.draw(api, state));
    });
  }

  ngOnInit(): void {
    const host = this.host.nativeElement;
    // Own scroll model: the wheel moves the line position, the table only draws it.
    host.addEventListener('wheel', this.onWheel, { passive: false, capture: true });
    this.resizeObserver = new ResizeObserver(() => {
      this.viewportH.set(host.clientHeight);
      this.viewportW.set(host.clientWidth);
    });
    this.resizeObserver.observe(host);
    this.viewportH.set(host.clientHeight);
    this.viewportW.set(host.clientWidth);
    document.addEventListener('keydown', this.onKey);
    document.addEventListener('selectionchange', this.onSelectionChange);
    (window as unknown as { __lcTable: unknown }).__lcTable = {
      drawTimes: this.drawTimes,
      api: () => this.api(),
      holds: () => this.holds,
    };
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    document.removeEventListener('keydown', this.onKey);
    document.removeEventListener('selectionchange', this.onSelectionChange);
  }

  protected jumpToEnd(): void {
    const session = this.session();
    session.setFollow(true);
    session.scroll.set(bottomAnchor(this.metrics()));
  }

  private draw(
    api: TableApi,
    state: {
      count: number;
      rowH: number;
      pos: { top: number; subPx: number };
      left: number;
      revision: number;
      marks: string;
      follow: boolean;
    },
  ): void {
    if (holdForSelection(state.follow, this.selectionInTable())) {
      this.heldForSelection = true;
      this.holds++;
      return;
    }
    this.heldForSelection = false;
    const start = performance.now();
    const hard = state.count !== this.drawn.count || state.rowH !== this.drawn.rowH;
    const free = Math.max(0, this.viewportW() - (this.lineNumbers() ? this.gutterWidth() : 0));
    const wantedText = textColumnWidth(this.widestText, free);
    // Always place the content exactly: a growing, capped scroll bar would move it otherwise.
    const top = contentTop(state.pos, state.rowH);
    const scrollTop = this.scrollViewport()?.scrollTop ?? 0;
    this.expectedScrollTop = -1;
    if (hard || wantedText !== this.textWidth) {
      if (wantedText !== this.textWidth) {
        this.textWidth = wantedText;
        api.setColumnWidth(COL_TEXT, wantedText);
      }
      if (this.lineNumbers()) api.setColumnWidth(COL_NUMBER, this.gutterWidth());
      // New row count or height and the position in one render pass (1.1.107).
      api.repaintHard({ px: state.left, py: top });
    } else if (top !== this.drawn.top || state.left !== this.drawn.left) {
      api.scrollToPixel(state.left, top);
    } else {
      // Same position, new content (a page arrived, filter, marks): scrollToPixel would render nothing.
      api.repaint();
    }
    this.expectedScrollTop = this.scrollViewport()?.scrollTop ?? scrollTop;
    this.drawn = { count: state.count, rowH: state.rowH, top, left: state.left };
    this.measureText();
    this.drawTimes.push(performance.now() - start);
    if (this.drawTimes.length > 5000) this.drawTimes.splice(0, 1000);
  }

  private gutterWidth(): number {
    const digits = Math.max(4, String(this.session().update().totalLines).length + 1);
    return Math.ceil(digits * this.fontSize() * 0.62 + 12);
  }

  private measureText(): void {
    let widest = this.widestText;
    for (const el of Array.from(
      this.host.nativeElement.querySelectorAll<HTMLElement>('.lt-text'),
    )) {
      if (el.offsetWidth > widest) widest = el.offsetWidth;
    }
    if (widest > this.widestText) {
      this.widestText = widest;
      // Next draw widens the column.
      queueMicrotask(() => this.redraw.update((r) => r + 1));
    }
  }

  private scrollViewport(): HTMLElement | null {
    return this.host.nativeElement.querySelector<HTMLElement>('.ge-table-scroll-viewport');
  }

  private selectionInTable(): boolean {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.anchorNode) return false;
    return this.host.nativeElement.contains(selection.anchorNode);
  }

  private readonly onSelectionChange = (): void => {
    // A released selection lets the view catch up.
    if (this.heldForSelection && !this.selectionInTable()) {
      this.redraw.update((r) => r + 1);
    }
  };

  protected onTableScroll(event: GeScrollEvent): void {
    const session = this.session();
    if (event.scrollLeft !== session.scrollLeft()) session.scrollLeft.set(event.scrollLeft);
    if (this.expectedScrollTop < 0 || Math.abs(event.scrollTop - this.expectedScrollTop) < 2) {
      return;
    }
    // The scroll bar was dragged.
    this.expectedScrollTop = event.scrollTop;
    const range = event.scrollHeight - event.clientHeight;
    const count = session.displayedLines();
    if (event.scrollTop >= range - 1) {
      this.jumpToEnd();
      return;
    }
    const px = contentTopFromScrollbar(
      event.scrollTop,
      range,
      count * this.rowH(),
      this.viewportH(),
    );
    session.setFollow(false);
    session.scroll.set(posFromContentTop(px, this.rowH()));
  }

  protected onTableClick(event: GeMouseEvent): void {
    if (event.areaIdent !== 'body' || event.rowIndex < 0) return;
    if (window.getSelection()?.toString()) return;
    const line = this.session().cache.line(event.rowIndex);
    if (!line) return;
    void this.sessions.selectEntry(this.session(), line.line, !!event.originalEvent?.shiftKey);
  }

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_LINE_PX : 1;
    const dx = event.shiftKey ? event.deltaX + event.deltaY : event.deltaX;
    const dy = event.shiftKey ? 0 : event.deltaY;
    if (dx !== 0) {
      const session = this.session();
      const max = Math.max(0, this.textWidth - this.viewportW() + this.gutterWidth());
      session.scrollLeft.set(Math.min(max, Math.max(0, session.scrollLeft() + dx * unit)));
    }
    if (dy !== 0) this.scrollPixels(dy * unit);
  };

  private scrollPixels(dy: number): void {
    const session = this.session();
    const result = scrollBy(session.scroll(), dy, this.metrics());
    if (result.atBottom) {
      if (dy > 0) session.setFollow(true);
    } else if (dy < 0 || !session.follow()) {
      session.setFollow(false);
    }
    session.scroll.set(result.pos);
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement;
    if (target.closest?.('input, textarea, select, dialog')) return;
    const session = this.session();
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === 'c') {
      if (!window.getSelection()?.toString() && session.selection()) {
        event.preventDefault();
        void this.sessions.copySelection(session);
      }
      return;
    }
    if (mod || event.altKey) return;
    const page = Math.max(this.rowH(), this.viewportH() - this.rowH());
    switch (event.key) {
      case 'End':
      case 'f':
      case 'F':
        this.jumpToEnd();
        break;
      case ' ':
        if (target.closest('button')) return;
        if (session.follow()) session.setFollow(false);
        else this.jumpToEnd();
        break;
      case 'p':
      case 'P':
        void this.sessions.toggleFreeze(session);
        break;
      case 'Home':
        session.setFollow(false);
        session.scroll.set({ top: 0, subPx: 0 });
        break;
      case 'PageDown':
        this.scrollPixels(page);
        break;
      case 'PageUp':
        this.scrollPixels(-page);
        break;
      case 'ArrowDown':
        this.scrollPixels(this.rowH());
        break;
      case 'ArrowUp':
        this.scrollPixels(-this.rowH());
        break;
      case 'Escape':
        session.selection.set(null);
        break;
      default:
        return;
    }
    event.preventDefault();
  };
}
