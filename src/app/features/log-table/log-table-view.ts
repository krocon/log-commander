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
  FalseFn,
  GeMouseEvent,
  GeScrollEvent,
  Size,
  TableApi,
  TableFactory,
  TableModelIf,
  TableOptions,
  TableOptionsIf,
  TrueFn,
} from '@guiexpert/table';
import { SettingsService } from '../../core/settings/settings.service';
import { formatCount } from '../../shared/format';
import {
  ViewMetrics,
  bottomAnchor,
  clampToBottom,
  revealBelow,
  scrollBy,
  visibleRowCount,
} from './viewport-logic';
import { LogSessionService } from '../sessions/log-session.service';
import { labelWidth } from '../merge/merge-logic';
import { ColumnMenuComponent } from './column-menu';
import { RowMenuAction, RowMenuComponent, RowMenuItem, rowMenuItems } from './row-menu';
import { locateSelection } from '../fields/rule-from-selection';
import { isNumericKind } from '../fields/fields-logic';
import { LogLine } from '../../core/log/log.models';
import { SessionState } from '../sessions/session-state';
import { COL_NUMBER, COL_TEXT, ID_NUMBER, ID_TEXT, LogAreaModel } from './log-area-model';
import {
  contentTop,
  contentTopFromScrollbar,
  holdForSelection,
  posFromContentTop,
  textColumnWidth,
} from './table-logic';
import {
  CELL_PADDING,
  MESSAGE_ID,
  ViewColumn,
  WIDTH_STEP,
  clampWidth,
  columnsActive,
  columnsAvailable,
  fillWidth,
  layoutFromTable,
  layoutOf,
  moveColumn,
  resolveColumns,
  setHidden,
  setWidth,
  spanStart,
} from './columns-logic';

const LINE_HEIGHT_FACTOR = 1.5;
const WHEEL_LINE_PX = 40;
/** Width of a digit of the monospaced font relative to its size, roughly. */
const CHAR_WIDTH_FACTOR = 0.62;

/** One build of the table: a new value re-creates it (raw ↔ columns, other columns, header height). */
interface TableConfig {
  model: TableModelIf;
  options: TableOptionsIf;
  area: LogAreaModel;
  /** Column view: the profile its layout is stored under. */
  profileId: string | null;
  /** Column view: the layout the table was built with. */
  columns: ViewColumn[];
}

interface RowMenu {
  x: number;
  y: number;
  items: RowMenuItem[];
  line: number | null;
  /** The line under the pointer, for a column from marked text (prompt 011). */
  logLine: LogLine | null;
  /** Column view: the column under the pointer. */
  columnId: string | null;
  text: string;
  cell: { column: string; value: string } | null;
  returnTo: HTMLElement | null;
}

interface ColumnMenu {
  x: number;
  y: number;
  focusId: string;
  /** Where the focus goes back to. */
  returnTo: HTMLElement | null;
}

const BASE_OPTIONS: TableOptionsIf = {
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

/**
 * The log in the GuiExpert Table (prompt 003). Own scroll model (line + pixel offset, `viewport-logic.ts`); the table
 * only draws that position, one render pass per update. Fixed row height, no wrapping.
 *
 * Column view (prompt 009): one table column per field of the `ColumnSet`, the table's header with resizing and
 * dragging; widths, order and hidden columns per profile in the settings. The raw view is the one of 003.
 */
@Component({
  selector: 'app-log-table-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [TableSignalComponent, ColumnMenuComponent, RowMenuComponent],
  host: {
    class: 'lt-host',
    '[class.lt-columns]': 'columnView()',
    '[style.--row-h.px]': 'rowH()',
    '[style.--header-h.px]': 'headerH()',
    '[style.--font-size.px]': 'fontSize()',
  },
  template: `
    <guiexpert-table-signal
      class="lt-table"
      [tableModel]="config().model"
      [tableOptions]="config().options"
      [debounceMouseClickDelay]="0"
      [(tableApi)]="api"
      (scroll)="onTableScroll($event)"
      (mouseClicked)="onTableClick($event)"
      (contextMenu)="onTableContextMenu($event)"
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
    @if (menu(); as m) {
      <app-column-menu
        [columns]="menuColumns()"
        [x]="m.x"
        [y]="m.y"
        [focusId]="m.focusId"
        (hide)="setColumnHidden($event.id, $event.hidden)"
        (move)="moveColumnBy($event.id, $event.direction)"
        (widthChange)="resizeColumnBy($event.id, $event.direction)"
        (resetLayout)="resetColumns()"
        (closed)="closeMenu()"
      />
    }
    @if (rowMenu(); as m) {
      <app-row-menu
        [items]="m.items"
        [x]="m.x"
        [y]="m.y"
        (choose)="onRowMenu($event)"
        (closed)="closeRowMenu()"
      />
    }
  `,
  styleUrls: ['./log-table-view.css', './log-table-columns.css', './log-table-marks.css'],
})
export class LogTableViewComponent implements OnInit, OnDestroy {
  readonly session = input.required<SessionState>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly settingsService = inject(SettingsService);
  private readonly settings = this.settingsService.settings;
  private readonly sessions = inject(LogSessionService);

  protected readonly formatCount = formatCount;
  protected readonly fontSize = computed(() => this.settings().fontSize);
  /** The gutter is shown: line numbers on, or a merge (it carries the source of each line). */
  protected readonly lineNumbers = computed(
    () => this.settings().showLineNumbers || this.session().isMerge,
  );
  protected readonly rowH = computed(() => Math.round(this.fontSize() * LINE_HEIGHT_FACTOR));
  protected readonly headerH = computed(() => this.rowH() + 8);

  protected readonly columnView = computed(() =>
    columnsActive(this.settings().columnMode, this.session().columns()),
  );
  /** What the table is built from; equal keys keep the table (a new revision with the same columns, too). */
  private readonly structure = computed(() => {
    const set = this.session().columns();
    if (!this.columnView() || !set) return 'raw';
    return `${set.profileId}\n${set.columns.map((c) => `${c.id}:${c.label}`).join('\n')}\n${this.headerH()}`;
  });
  protected readonly config = computed<TableConfig>(() => {
    this.structure();
    return untracked(() => this.build());
  });

  protected readonly api = signal<TableApi | undefined>(undefined);
  private readonly viewportH = signal(400);
  private readonly viewportW = signal(800);
  /** Height of the rows area: the header takes its part of the host. */
  private readonly bodyH = computed(() =>
    Math.max(0, this.viewportH() - (this.columnView() ? this.headerH() : 0)),
  );
  /** Bumped to draw again without another input changing (wider text, released selection). */
  private readonly redraw = signal(0);

  /** Column view: the layout as the user set it (the last shown column is widened to fill on top). */
  private columns: ViewColumn[] = [];
  protected readonly menuColumns = signal<ViewColumn[]>([]);
  protected readonly menu = signal<ColumnMenu | null>(null);
  protected readonly rowMenu = signal<RowMenu | null>(null);

  private readonly metrics = computed<ViewMetrics>(() => ({
    count: this.session().displayedLines(),
    viewportH: this.bodyH(),
    rowH: this.rowH(),
  }));

  protected readonly emptyText = computed(() => {
    const update = this.session().update();
    if (update.filterPending) return 'Filter wird berechnet …';
    if (update.totalLines === 0) return 'Datei ist leer, warte auf neue Zeilen …';
    return `Keine passenden Zeilen (${formatCount(update.totalLines)} ausgeblendet)`;
  });

  /** What the table drew last; a hard repaint only when count or height changed. */
  private drawn = { count: -1, rowH: -1, top: -1, left: -1, height: -1, width: -1 };
  private expectedScrollTop = -1;
  /** The table `draw()` placed last; a new one reports its first scroll position before it is drawn. */
  private drawnConfig: TableConfig | null = null;
  /** Raw view: widest text seen; column view: what the last shown column needs. */
  private widestText = 0;
  private textWidth = 800;
  /** Width of all data columns, for the horizontal scroll range. */
  private contentWidth = 800;
  /** The width the last shown column got to fill the view (not the user's). */
  private filled: { id: string; width: number } | null = null;
  private heldForSelection = false;
  /** A mouse drag in the header (resize or move) is running: drawing waits, the table owns the columns. */
  private headerBusy = false;
  private holds = 0;
  private resizeObserver: ResizeObserver | null = null;
  /** When a click last selected an entry: the double click that follows shows that one. */
  private clickedAt = -Infinity;

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
      this.session().visibleRows.set(visibleRowCount(this.bodyH(), this.rowH()));
    });
    // A panel that opens (or grows) below must not hide the selected line; following takes care of itself.
    let lastBodyH = 0;
    effect(() => {
      const bodyH = this.bodyH();
      const shrunk = bodyH < lastBodyH;
      lastBodyH = bodyH;
      if (shrunk) untracked(() => this.keepSelectionVisible());
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
      const config = this.config();
      untracked(() => {
        this.columns = config.columns;
        this.menuColumns.set(config.columns);
        this.menu.set(null);
        this.widestText = 0;
        this.filled = null;
      });
    });
    effect(() => {
      const api = this.api();
      const lineNumbers = this.lineNumbers();
      if (!api) return;
      // The table renders right away and reads the area model, whose signals must not become
      // dependencies of this effect (every update would repaint, a text selection would be lost).
      untracked(() => {
        api.setHeaderVisible(this.config().area.columnView);
        api.setColumnVisible(COL_NUMBER, lineNumbers);
        // A new table (or gutter) draws everything at its place again.
        this.drawn = { count: -1, rowH: -1, top: -1, left: -1, height: -1, width: -1 };
        this.filled = null;
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
        marks: `${JSON.stringify(session.selection())}|${session.currentHitLine()}|${session.update().totalLines}|${session.bookmarks().size}`,
        follow: session.follow(),
      };
      void [this.viewportW(), this.bodyH(), this.redraw()];
      // Between a new build and the table's answer the api is still the old table's.
      if (api.getTableModel() !== this.config().model) return;
      untracked(() => this.draw(api, state));
    });
  }

  ngOnInit(): void {
    const host = this.host.nativeElement;
    // Own scroll model: the wheel moves the line position, the table only draws it.
    host.addEventListener('wheel', this.onWheel, { passive: false, capture: true });
    host.addEventListener('mousedown', this.onHeaderMouseDown, { capture: true });
    host.addEventListener('dblclick', this.onHeaderDblClick, { capture: true });
    host.addEventListener('dblclick', this.onBodyDblClick);
    window.addEventListener('mouseup', this.onMouseUp, { capture: true });
    document.addEventListener('mousedown', this.onOutsideMouseDown, { capture: true });
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
    window.removeEventListener('mouseup', this.onMouseUp, { capture: true });
    document.removeEventListener('mousedown', this.onOutsideMouseDown, { capture: true });
    document.removeEventListener('keydown', this.onKey);
    document.removeEventListener('selectionchange', this.onSelectionChange);
  }

  private keepSelectionVisible(): void {
    const session = this.session();
    const anchor = session.selection()?.anchor;
    if (anchor === undefined || session.follow()) return;
    const pos = session.scroll();
    const end = pos.top + visibleRowCount(this.viewportH(), this.rowH());
    for (let row = pos.top; row < end; row++) {
      if (session.cache.line(row)?.line !== anchor) continue;
      const next = revealBelow(pos, row, this.metrics());
      if (next) session.scroll.set(next);
      return;
    }
  }

  protected jumpToEnd(): void {
    const session = this.session();
    session.setFollow(true);
    session.scroll.set(bottomAnchor(this.metrics()));
  }

  // ---------------------------------------------------------------- building

  private charWidth(): number {
    return this.fontSize() * CHAR_WIDTH_FACTOR;
  }

  private build(): TableConfig {
    const set = this.session().columns();
    const gutter = ColumnDef.create({
      property: ID_NUMBER,
      headerLabel: '',
      width: new Size(60, 'px'),
      sortable: FalseFn,
      headerClasses: ['lt-head', 'lt-head-gutter'],
    });
    if (!this.columnView() || !set) {
      const area = new LogAreaModel(
        () => this.session(),
        () => this.rowH(),
      );
      area.showNumbers = () => this.settings().showLineNumbers;
      return {
        area,
        profileId: null,
        columns: [],
        options: BASE_OPTIONS,
        model: TableFactory.createTableModel({
          bodyAreaModel: area,
          columnDefs: [gutter, new ColumnDef(ID_TEXT, '', new Size(800, 'px'))],
          fixedLeftColumnCount: 1,
        }),
      };
    }
    const columns = resolveColumns(
      set.columns,
      this.settings().columnLayouts[set.profileId],
      this.charWidth(),
    );
    const area = new LogAreaModel(
      () => this.session(),
      () => this.rowH(),
      [
        { id: ID_NUMBER, field: -1 },
        ...columns.map((c) => ({ id: c.id, field: c.field, numeric: isNumericKind(c.kind) })),
      ],
    );
    area.showNumbers = () => this.settings().showLineNumbers;
    const message = set.columns.findIndex((c) => c.id === MESSAGE_ID);
    area.messageField = message >= 0 ? message : set.columns.length - 1;
    return {
      area,
      profileId: set.profileId,
      columns,
      options: {
        ...BASE_OPTIONS,
        columnsResizable: true,
        columnsDraggable: true,
        columnResizeHandleWidthInPx: 6,
      },
      model: TableFactory.createTableModel({
        bodyAreaModel: area,
        columnDefs: [
          gutter,
          ...columns.map((c) =>
            ColumnDef.create({
              property: c.id,
              headerLabel: c.label,
              width: new Size(c.width, 'px'),
              sortable: FalseFn,
              isVisible: c.hidden ? FalseFn : TrueFn,
              headerClasses: ['lt-head'],
            }),
          ),
        ],
        fixedLeftColumnCount: 1,
        defaultRowHeights: { header: this.headerH(), body: this.rowH(), footer: 0 },
      }),
    };
  }

  // ---------------------------------------------------------------- drawing

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
    if (this.headerBusy || holdForSelection(state.follow, this.selectionInTable())) {
      this.heldForSelection = true;
      this.holds++;
      return;
    }
    this.heldForSelection = false;
    const start = performance.now();
    const area = this.config().area;
    // A new height or width (window, detail panel, sidebar) as well: the table follows its host only
    // after a 500 ms debounce.
    let hard =
      state.count !== this.drawn.count ||
      state.rowH !== this.drawn.rowH ||
      this.viewportH() !== this.drawn.height ||
      this.viewportW() !== this.drawn.width;
    const gutter = this.lineNumbers() ? this.gutterWidth() : 0;
    const free = Math.max(0, this.viewportW() - gutter);
    let spanMoved = false;
    if (area.columnView) {
      const widths = this.fitLastColumn(api, area, free);
      hard ||= widths.changed;
      const span = spanStart(widths.data, state.left);
      spanMoved = area.spanFrom !== span.index + 1 || area.spanOffset !== span.offset;
      area.spanFrom = span.index + 1;
      area.spanOffset = span.offset;
    } else {
      const wantedText = textColumnWidth(this.widestText, free);
      if (wantedText !== this.textWidth) {
        this.textWidth = wantedText;
        api.setColumnWidth(COL_TEXT, wantedText);
        hard = true;
      }
      this.contentWidth = this.textWidth;
    }
    // Always place the content exactly: a growing, capped scroll bar would move it otherwise.
    const top = contentTop(state.pos, state.rowH);
    const scrollTop = this.scrollViewport()?.scrollTop ?? 0;
    this.expectedScrollTop = -1;
    if (hard) {
      if (this.lineNumbers()) api.setColumnWidth(COL_NUMBER, this.gutterWidth());
      // New row count or height and the position in one render pass (1.1.107).
      api.repaintHard({ px: state.left, py: top });
    } else if (top !== this.drawn.top || state.left !== this.drawn.left) {
      api.scrollToPixel(state.left, top);
      // The table may be there already (its own scroll bar): then it renders nothing, but a span moved.
      if (spanMoved) api.repaint();
    } else {
      // Same position, new content (a page arrived, filter, marks): scrollToPixel would render nothing.
      api.repaint();
    }
    this.expectedScrollTop = this.scrollViewport()?.scrollTop ?? scrollTop;
    this.drawnConfig = this.config();
    this.drawn = {
      count: state.count,
      rowH: state.rowH,
      top,
      left: state.left,
      height: this.viewportH(),
      width: this.viewportW(),
    };
    this.measureText(area);
    this.drawTimes.push(performance.now() - start);
    if (this.drawTimes.length > 5000) this.drawTimes.splice(0, 1000);
  }

  /**
   * Column view: the last shown column fills the view and is at least as wide as its content. Returns the
   * widths of the data columns in table order (hidden = 0) and whether a width changed.
   */
  private fitLastColumn(
    api: TableApi,
    area: LogAreaModel,
    free: number,
  ): { data: number[]; changed: boolean } {
    const model = api.getTableModel();
    const count = model.getColumnCount();
    const data: number[] = [];
    let last = -1;
    let lead = -1;
    for (let i = 1; i < count; i++) {
      const shown = api.isColumnVisible(i);
      data.push(shown ? model.getColumnWidth(i) : 0);
      if (shown) {
        last = i;
        if (lead < 0) lead = i;
      }
    }
    area.leadColumn = lead;
    area.fillColumn = last;
    let changed = false;
    if (last > 0) {
      const others = data.reduce((sum, w, i) => (i === last - 1 ? sum : sum + w), 0);
      const wanted = fillWidth(this.widestText, free, others);
      if (wanted !== data[last - 1]) {
        api.setColumnWidth(last, wanted);
        data[last - 1] = wanted;
        changed = true;
      }
      this.filled = { id: area.columnAt(last).id, width: wanted };
    }
    this.contentWidth = data.reduce((sum, w) => sum + w, 0);
    return { data, changed };
  }

  private gutterWidth(): number {
    const session = this.session();
    const numbers = this.settings().showLineNumbers;
    const digits = numbers ? Math.max(4, String(session.update().totalLines).length + 1) : 0;
    // A merge: the short file name in front, plus the colour stripe.
    const names = session.isMerge ? labelWidth(session.sourceLabels) + (numbers ? 1 : 0) : 0;
    const stripe = session.isMerge ? 6 : 0;
    return Math.ceil((digits + names) * this.fontSize() * CHAR_WIDTH_FACTOR + 12 + stripe);
  }

  private measureText(area: LogAreaModel): void {
    const root = this.host.nativeElement;
    let widest = this.widestText;
    if (area.columnView) {
      const last = this.filled?.id;
      if (!last) return;
      const others = this.contentWidth - (this.filled?.width ?? 0);
      for (const el of Array.from(
        root.querySelectorAll<HTMLElement>(
          `.lt-cell[data-col="${CSS.escape(last)}"]:not(.lt-span) .lt-text`,
        ),
      )) {
        widest = Math.max(widest, el.offsetWidth + CELL_PADDING);
      }
      for (const el of Array.from(root.querySelectorAll<HTMLElement>('.lt-span .lt-text'))) {
        widest = Math.max(widest, el.offsetWidth + CELL_PADDING - others);
      }
    } else {
      for (const el of Array.from(root.querySelectorAll<HTMLElement>('.lt-text'))) {
        if (el.offsetWidth > widest) widest = el.offsetWidth;
      }
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
    if (this.heldForSelection && !this.headerBusy && !this.selectionInTable()) {
      this.redraw.update((r) => r + 1);
    }
  };

  // ---------------------------------------------------------------- columns

  /** Applies `columns` to the table (order, widths, visibility) and stores them for the profile. */
  private applyColumns(columns: ViewColumn[], store = true): void {
    this.columns = columns;
    this.menuColumns.set(columns);
    const api = this.api();
    if (api) {
      api.applyState(
        {
          version: 1,
          columns: [
            { property: ID_NUMBER, width: this.gutterWidth(), visible: this.lineNumbers() },
            ...columns.map((c) => ({ property: c.id, width: c.width, visible: !c.hidden })),
          ],
        },
        ['columns'],
      );
    }
    this.afterLayoutChange();
    if (store) this.storeLayout();
  }

  private afterLayoutChange(): void {
    this.filled = null;
    this.widestText = 0;
    this.drawn = { ...this.drawn, count: -1 };
    this.redraw.update((r) => r + 1);
  }

  private storeLayout(): void {
    const profileId = this.config().profileId;
    if (!profileId) return;
    const layouts = this.settings().columnLayouts;
    this.settingsService.update({
      columnLayouts: { ...layouts, [profileId]: layoutOf(this.columns) },
    });
  }

  /** After the user dragged or resized in the header: take order and widths from the table. */
  private syncFromTable(): void {
    const api = this.api();
    const area = this.config().area;
    if (!api || !area.columnView) return;
    const ids = area.columnIds();
    const model = api.getTableModel();
    const widths: Record<string, number> = {};
    ids.forEach((id, i) => {
      if (id === ID_NUMBER || !api.isColumnVisible(i)) return;
      const width = model.getColumnWidth(i);
      // The fill width is the view's, not the user's.
      if (this.filled?.id === id && this.filled.width === width) return;
      widths[id] = width;
    });
    const next = layoutFromTable(
      this.columns,
      ids.filter((id) => id !== ID_NUMBER),
      widths,
    );
    // The gutter stays in front (the table lets a column be dropped before it): the state puts it back.
    if (ids[0] !== ID_NUMBER) this.applyColumns(next);
    else {
      this.columns = next;
      this.menuColumns.set(next);
      this.afterLayoutChange();
      this.storeLayout();
    }
  }

  protected setColumnHidden(id: string, hidden: boolean): void {
    this.applyColumns(setHidden(this.columns, id, hidden));
  }

  protected moveColumnBy(id: string, direction: -1 | 1): void {
    this.applyColumns(moveColumn(this.columns, id, direction));
  }

  protected resizeColumnBy(id: string, direction: -1 | 1): void {
    const column = this.columns.find((c) => c.id === id);
    if (!column) return;
    this.applyColumns(setWidth(this.columns, id, column.width + direction * WIDTH_STEP));
  }

  protected resetColumns(): void {
    const set = this.session().columns();
    const profileId = this.config().profileId;
    if (!set || !profileId) return;
    const layouts = { ...this.settings().columnLayouts };
    delete layouts[profileId];
    this.settingsService.update({ columnLayouts: layouts });
    this.applyColumns(resolveColumns(set.columns, undefined, this.charWidth()), false);
  }

  /** Double click on a column's edge: as wide as its content in the rows on screen (no file scan). */
  private fitColumn(index: number): void {
    const area = this.config().area;
    const id = area.columnAt(index).id;
    if (!area.columnView || id === ID_NUMBER || id === this.filled?.id) return;
    const root = this.host.nativeElement;
    let widest = 0;
    for (const el of Array.from(
      root.querySelectorAll<HTMLElement>(
        `.lt-cell[data-col="${CSS.escape(id)}"]:not(.lt-span) .lt-text`,
      ),
    )) {
      widest = Math.max(widest, el.offsetWidth);
    }
    const head = root.querySelector<HTMLElement>(
      `.ge-table-header [data-col-index="${index}"].lt-head`,
    );
    // The title's text, not its block (the label fills the cell).
    const title = head && document.createTreeWalker(head, NodeFilter.SHOW_TEXT).nextNode();
    if (title) {
      const range = document.createRange();
      range.selectNodeContents(title);
      widest = Math.max(widest, range.getBoundingClientRect().width);
    }
    this.applyColumns(setWidth(this.columns, id, clampWidth(widest + CELL_PADDING)));
  }

  // ---------------------------------------------------------------- menu

  protected openMenu(x: number, y: number, focusId?: string): void {
    if (!this.config().area.columnView) return;
    const host = this.host.nativeElement;
    const id = focusId ?? this.columns.find((c) => !c.hidden)?.id ?? MESSAGE_ID;
    this.menu.set({
      x: Math.max(0, Math.min(x, host.clientWidth - 330)),
      y: Math.max(0, Math.min(y, host.clientHeight - 60)),
      focusId: id,
      returnTo:
        document.activeElement instanceof HTMLElement && document.activeElement !== document.body
          ? document.activeElement
          : null,
    });
  }

  protected closeMenu(): void {
    const menu = this.menu();
    if (!menu) return;
    this.menu.set(null);
    menu.returnTo?.focus();
  }

  private readonly onOutsideMouseDown = (event: MouseEvent): void => {
    const target = event.target as HTMLElement;
    if (this.menu() && !target.closest?.('.lt-colmenu')) this.menu.set(null);
    if (this.rowMenu() && !target.closest?.('.lt-rowmenu')) this.rowMenu.set(null);
  };

  /** Prompt 010: right click on a line, the quick ways into the filter tree. */
  private openRowMenu(event: GeMouseEvent): void {
    const original = event.originalEvent;
    original?.preventDefault();
    const session = this.session();
    const line = event.rowIndex >= 0 ? session.cache.line(event.rowIndex) : null;
    const text = window.getSelection()?.toString() ?? '';
    let cell: RowMenu['cell'] = null;
    let cellLabel = '';
    const area = this.config().area;
    const columnId =
      area.columnView && event.columnIndex > 0 ? area.columnAt(event.columnIndex).id : null;
    if (line && !line.isContinuation && area.columnView && event.columnIndex >= 0) {
      const id = area.columnAt(event.columnIndex).id;
      const columns = session.columns()?.columns ?? [];
      const index = columns.findIndex((c) => c.id === id);
      const span = index >= 0 ? line.fields[index] : undefined;
      if (span && span[1] > span[0]) {
        cell = { column: id, value: line.text.slice(span[0], span[1]) };
        cellLabel = columns[index].label;
      }
    }
    const items = rowMenuItems({
      selectedText: text,
      cell: cell ? { label: cellLabel, value: cell.value } : null,
      hasLine: !!line,
    });
    if (!items.length) return;
    const host = this.host.nativeElement;
    const box = host.getBoundingClientRect();
    this.rowMenu.set({
      x: Math.max(0, Math.min((original?.clientX ?? box.left) - box.left, host.clientWidth - 240)),
      y: Math.max(0, Math.min((original?.clientY ?? box.top) - box.top, host.clientHeight - 140)),
      items,
      line: line?.line ?? null,
      logLine: line,
      columnId,
      text,
      cell,
      returnTo:
        document.activeElement instanceof HTMLElement && document.activeElement !== document.body
          ? document.activeElement
          : null,
    });
  }

  protected closeRowMenu(): void {
    const menu = this.rowMenu();
    if (!menu) return;
    this.rowMenu.set(null);
    menu.returnTo?.focus();
  }

  protected async onRowMenu(action: RowMenuAction): Promise<void> {
    const menu = this.rowMenu();
    this.closeRowMenu();
    if (!menu) return;
    const session = this.session();
    switch (action) {
      case 'filter-text':
      case 'exclude-text':
        this.sessions.filterOnText(session, menu.text, action === 'exclude-text');
        break;
      case 'filter-value':
        if (menu.cell) this.sessions.filterByValue(session, menu.cell.column, menu.cell.value);
        break;
      case 'column-from-selection':
        if (menu.logLine) this.columnFromSelection(menu.logLine, menu.text, menu.columnId);
        break;
      case 'from-here':
      case 'to-here': {
        // The line under the pointer: its entry becomes the selection, the section starts or ends there.
        const selection = session.selection();
        const inSelection =
          selection &&
          menu.line !== null &&
          menu.line >= selection.first &&
          menu.line <= selection.last;
        if (!inSelection && menu.line !== null) {
          await this.sessions.selectEntry(session, menu.line, false);
        }
        this.sessions.filterSection(session, action === 'from-here' ? 'from' : 'to');
        break;
      }
    }
  }

  /**
   * Prompt 011: marked text of a line as the start of a rule. The source is the column of the format the marked
   * text lies in (the cell under the pointer first, then the message); the dialog shows the rule and its hits.
   */
  private columnFromSelection(line: LogLine, marked: string, columnId: string | null): void {
    const session = this.session();
    const columns = session.columns()?.columns ?? [];
    const base = columns
      .map((column, index) => ({ column, span: line.fields[index] }))
      .filter((c) => !c.column.rule && c.span && c.span[1] > c.span[0]);
    const cell = base.find((c) => c.column.id === columnId);
    const at = locateSelection(line.text, marked, cell?.span ?? null);
    if (!at) {
      this.sessions.showFindMessage(session, 'Markierung nicht in der Zeile gefunden');
      return;
    }
    const inside = (c: (typeof base)[number]) => c.span[0] <= at[0] && at[1] <= c.span[1];
    const source =
      (cell && inside(cell) ? cell : null) ??
      base.find((c) => c.column.id === MESSAGE_ID && inside(c)) ??
      base.find(inside);
    const [from, to] = source ? source.span : [0, line.text.length];
    this.sessions.openFields(session, {
      text: line.text.slice(from, to),
      start: at[0] - from,
      end: at[1] - from,
      column: source?.column.id ?? MESSAGE_ID,
    });
  }

  protected onTableContextMenu(event: GeMouseEvent): void {
    if (event.areaIdent === 'body') {
      this.openRowMenu(event);
      return;
    }
    if (event.areaIdent !== 'header' || !this.config().area.columnView) return;
    const original = event.originalEvent;
    original?.preventDefault();
    const box = this.host.nativeElement.getBoundingClientRect();
    const id = this.config().area.columnAt(event.columnIndex).id;
    this.openMenu(
      (original?.clientX ?? box.left) - box.left,
      (original?.clientY ?? box.top) - box.top,
      id === ID_NUMBER ? undefined : id,
    );
  }

  private readonly onHeaderMouseDown = (event: MouseEvent): void => {
    const target = event.target as HTMLElement;
    const head = target.closest?.('[data-area="header"]');
    if (!head || event.button !== 0) return;
    // The gutter is no column to move or resize.
    if (head.getAttribute('data-col-index') === String(COL_NUMBER)) {
      event.stopPropagation();
      return;
    }
    this.headerBusy = true;
  };

  private readonly onMouseUp = (): void => {
    if (!this.headerBusy) return;
    // The table handles the end of the drag in this event, the result is read afterwards.
    setTimeout(() => {
      this.headerBusy = false;
      this.syncFromTable();
    });
  };

  private readonly onHeaderDblClick = (event: MouseEvent): void => {
    const handle = (event.target as HTMLElement).closest?.('[data-ge-action="resize-column"]');
    if (!handle) return;
    event.stopPropagation();
    this.fitColumn(Number(handle.getAttribute('data-col-index')));
  };

  // ---------------------------------------------------------------- input

  protected onTableScroll(event: GeScrollEvent): void {
    // A table that was just built (raw ↔ columns) reports its start position while it is created: no
    // drag of the scroll bar, which would stop following and jump to the top.
    const config = this.config();
    if (this.drawnConfig !== config || this.api()?.getTableModel() !== config.model) return;
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
    const px = contentTopFromScrollbar(event.scrollTop, range, count * this.rowH(), this.bodyH());
    session.setFollow(false);
    session.scroll.set(posFromContentTop(px, this.rowH()));
  }

  protected onTableClick(event: GeMouseEvent): void {
    if (event.areaIdent !== 'body' || event.rowIndex < 0) return;
    if (window.getSelection()?.toString()) return;
    const line = this.session().cache.line(event.rowIndex);
    if (!line) return;
    this.clickedAt = performance.now();
    void this.sessions.selectEntry(this.session(), line.line, !!event.originalEvent?.shiftKey);
  }

  /**
   * Double click opens the detail panel. Its first click already chose the entry (in a running tail another
   * line may lie under the pointer by now), so only without a selection does the target count. The second
   * click marks a word and `onTableClick` returns early on it, which is right here.
   */
  private readonly onBodyDblClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement;
    if (!target.closest?.('[data-area="body"]') && !target.closest?.('.lt-cell, .lt-gutter'))
      return;
    const session = this.session();
    const clickPending = performance.now() - this.clickedAt < 1000;
    if (!session.selection() && !clickPending) {
      const line = Number(target.closest?.<HTMLElement>('[data-line]')?.dataset['line']);
      if (Number.isFinite(line)) void this.sessions.selectEntry(session, line, false);
    }
    if (!this.settings().detailVisible) this.settingsService.update({ detailVisible: true });
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if ((event.target as HTMLElement).closest?.('.lt-colmenu, .lt-rowmenu')) return;
    event.preventDefault();
    event.stopPropagation();
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_LINE_PX : 1;
    const dx = event.shiftKey ? event.deltaX + event.deltaY : event.deltaX;
    const dy = event.shiftKey ? 0 : event.deltaY;
    if (dx !== 0) {
      const session = this.session();
      const max = Math.max(0, this.contentWidth - this.viewportW() + this.gutterWidth());
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

  private toggleColumnMode(): void {
    if (!columnsAvailable(this.session().columns())) return;
    this.settingsService.update({
      columnMode: this.settings().columnMode === 'columns' ? 'raw' : 'columns',
    });
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement;
    if (target.closest?.('input, textarea, select, dialog, .lt-colmenu, .lt-rowmenu')) return;
    // The detail panel, splitters, sidebar tree and statistics have their own keys; only D closes the panel there.
    const inPanel = !!target.closest?.('.detail, [role=separator], [role=tree], .stats');
    if (inPanel && event.key !== 'd' && event.key !== 'D') return;
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
    if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
      if (!this.config().area.columnView) return;
      event.preventDefault();
      this.openMenu(this.lineNumbers() ? this.gutterWidth() : 0, this.headerH());
      return;
    }
    const page = Math.max(this.rowH(), this.bodyH() - this.rowH());
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
      case 't':
      case 'T':
        this.toggleColumnMode();
        break;
      case 'd':
      case 'D':
        this.settingsService.update({ detailVisible: !this.settings().detailVisible });
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
      // Prompt 007: errors, warnings and bookmarks in the view, the whole log and back.
      case 'e':
      case 'E':
        void this.sessions.jumpToLevel(session, 'error', !event.shiftKey);
        break;
      case 'w':
      case 'W':
        void this.sessions.jumpToLevel(session, 'warn', !event.shiftKey);
        break;
      case 'n':
      case 'N':
        void this.sessions.jumpToBookmark(session, !event.shiftKey);
        break;
      case 'm':
      case 'M':
        this.sessions.toggleBookmark(session);
        break;
      case 'g':
      case 'G':
        void this.sessions.toggleFullLog(session);
        break;
      // Prompt 010: marked text into the filter tree (Shift: exclude it), sections from the selection.
      case 'i':
      case 'I':
        this.sessions.filterOnText(
          session,
          window.getSelection()?.toString() ?? '',
          event.shiftKey,
        );
        break;
      case '>':
        this.sessions.filterSection(session, 'from');
        break;
      case '<':
        this.sessions.filterSection(session, 'to');
        break;
      default:
        return;
    }
    event.preventDefault();
  };
}
