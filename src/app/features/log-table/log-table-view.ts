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
import { WINEVENT_PROFILE, defaultColumnLayout } from '../winevent/winevent-logic';
import { TableSignalComponent } from '@guiexpert/angular-table';
import {
  ColumnAutoWidthContextIf,
  ColumnDef,
  FalseFn,
  GeColumnMoveEvent,
  GeColumnResizeEvent,
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
  revealRows,
  scrollBy,
  visibleRowCount,
} from './viewport-logic';
import { LogSessionService } from '../sessions/log-session.service';
import { ActionService } from '../../core/actions/action.service';
import { labelWidth } from '../merge/merge-logic';
import { ColumnMenuComponent } from './column-menu';
import { RowMenuAction, RowMenuComponent, RowMenuItem, rowMenuItems } from './row-menu';
import { locateSelection } from '../fields/rule-from-selection';
import { isNumericKind } from '../fields/fields-logic';
import { LogLine } from '../../core/log/log.models';
import { SessionState } from '../sessions/session-state';
import { Direction } from '../sessions/selection-logic';
import { COL_NUMBER, COL_TEXT, ID_NUMBER, ID_TEXT, LogAreaModel } from './log-area-model';
import {
  contentTop,
  contentTopFromScrollbar,
  DrawState,
  drawKey,
  growsOnlyBehindView,
  holdForSelection,
  isDrag,
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

/** The cache's objects of the lines on screen (and one more for a partly shown row). */
function visibleLines(session: SessionState): (LogLine | null)[] {
  const top = session.scroll().top;
  const end = Math.min(session.displayedLines(), top + session.visibleRows());
  const rows: (LogLine | null)[] = [];
  for (let row = top; row < end; row++) rows.push(session.cache.line(row));
  return rows;
}
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
      (mouseDragging)="onTableDragging($event)"
      (mouseDraggingEnded)="onTableDraggingEnded()"
      (contextMenu)="onTableContextMenu($event)"
      (columnResizeEnd)="onColumnDragEnd($event)"
      (columnMoveEnd)="onColumnDragEnd($event)"
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
  private readonly actions = inject(ActionService);
  private offActions: () => void = () => undefined;

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
  /** What the table drew last (`drawKey`) and with which model: an equal picture is not drawn again. */
  private drawnKey = '';
  private drawnModel: unknown = null;
  private drawnState: DrawState | null = null;
  private drawnForcedKey = '';
  private holds = 0;
  /** Draws that went through `rowsAppended` (lines behind the view), for e2e. */
  private appends = 0;
  private resizeObserver: ResizeObserver | null = null;
  /** When a click last selected an entry: the double click that follows shows that one. */
  private clickedAt = -Infinity;
  /**
   * The press running now moved the pointer (the table's `mouseDragging`, before mouseup and click); reset by
   * `mouseDraggingEnded`, which comes after the click. Text may be dragged out right now.
   */
  private dragged = false;
  /** The text selection in the table was dragged by the user: only that one holds the drawing. */
  private dragSelected = false;
  /** Arrow steps run one after the other (each asks the backend); held keys queue at most two. */
  private stepQueue: Promise<void> = Promise.resolve();
  private stepsPending = 0;

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
    // A jump into the last screenful (a ruler mark, `E` near the end) asks for a top below the bottom. Left
    // alone, the browser clamps the table's scroll bar itself, WebKitGTK only after the draw, and that scroll
    // event reads as a drag to the end: following would start again. Once every line is here, clamp it in the
    // model; while lines are still on their way the jump target may become reachable, so it stays.
    effect(() => {
      const session = this.session();
      const pos = session.scroll();
      if (session.follow() || session.displayedLines() < session.filteredLines()) return;
      const clamped = clampToBottom(pos, untracked(this.metrics));
      if (clamped.atBottom && (clamped.pos.top !== pos.top || clamped.pos.subPx !== pos.subPx)) {
        untracked(() => session.settleScroll(clamped.pos));
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
        total: session.update().totalLines,
        marks: `${JSON.stringify(session.selection())}|${session.currentHitLine()}|${session.bookmarks().size}|${session.notes().size}`,
        follow: session.follow(),
        rows: visibleLines(session),
      };
      const forced = [this.viewportW(), this.bodyH(), this.redraw()];
      // Between a new build and the table's answer the api is still the old table's.
      if (api.getTableModel() !== this.config().model) return;
      const key = drawKey(state, forced);
      untracked(() => this.draw(api, state, key, forced.join('|')));
    });
  }

  ngOnInit(): void {
    const host = this.host.nativeElement;
    // Own scroll model: the wheel moves the line position, the table only draws it.
    host.addEventListener('wheel', this.onWheel, { passive: false, capture: true });
    document.addEventListener('mousedown', this.onOutsideMouseDown, { capture: true });
    this.resizeObserver = new ResizeObserver(() => {
      this.viewportH.set(host.clientHeight);
      this.viewportW.set(host.clientWidth);
    });
    this.resizeObserver.observe(host);
    this.viewportH.set(host.clientHeight);
    this.viewportW.set(host.clientWidth);
    this.offActions = this.registerActions();
    document.addEventListener('selectionchange', this.onSelectionChange);
    (window as unknown as { __lcTable: unknown }).__lcTable = {
      drawTimes: this.drawTimes,
      api: () => this.api(),
      holds: () => this.holds,
      appends: () => this.appends,
    };
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    document.removeEventListener('mousedown', this.onOutsideMouseDown, { capture: true });
    this.offActions();
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
      // The gutter is no column to move or resize.
      resizable: false,
      movable: false,
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
      // Prompt 018: Windows events start with time, level, provider, event ID and message.
      this.settings().columnLayouts[set.profileId] ?? defaultColumnLayout(set.profileId),
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
        // Double click on a column's edge: measured on the rows on screen (the default would ask the model for
        // up to 10 000 lines, most of them not loaded).
        columnAutoWidth: { getWidth: (ctx) => this.fitWidth(ctx) },
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

  private draw(api: TableApi, state: DrawState, key: string, forcedKey: string): void {
    // Every backend update re-runs the effect (also in a freeze, where filter jobs report through tick()),
    // but log lines never change: only a new picture is drawn. Each render rebuilds the visible cells, and a
    // render between mousedown and mouseup swallows the table's click.
    const model = api.getTableModel();
    if (key === this.drawnKey && model === this.drawnModel) return;
    // Reading in the middle while lines arrive behind the view: only the scroll bar changes. `rowsAppended`
    // (1.1.108) updates the row count without a render: the cells stay, and with them a click in progress and a
    // marked text, so this needs neither a throttle nor a hold.
    const grows =
      model === this.drawnModel &&
      !this.columnDragging() &&
      growsOnlyBehindView(
        this.drawnState,
        state,
        this.drawnForcedKey,
        forcedKey,
        this.session().visibleRows(),
      );
    if (grows) {
      this.appendBehindView(api, state, key);
      return;
    }
    const dragging = this.dragged || this.dragSelected;
    if (
      this.columnDragging() ||
      holdForSelection(state.follow, this.selectionInTable(), dragging)
    ) {
      this.heldForSelection = true;
      this.holds++;
      return;
    }
    this.heldForSelection = false;
    this.drawnKey = key;
    this.drawnModel = model;
    this.drawnState = state;
    this.drawnForcedKey = forcedKey;
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
   * New lines behind the view, nothing else changed: the table only learns the new row count and keeps the drawn
   * cells and the position (`follow: false` – following is the app's scroll model, not the table's). Should
   * something on screen depend on the count after all, the table falls back to one `repaintHard` at that position.
   */
  private appendBehindView(api: TableApi, state: DrawState, key: string): void {
    const start = performance.now();
    const scrollTop = this.scrollViewport()?.scrollTop ?? 0;
    this.expectedScrollTop = -1;
    api.rowsAppended(state.count - this.drawn.count, { follow: false });
    this.appends++;
    this.expectedScrollTop = this.scrollViewport()?.scrollTop ?? scrollTop;
    this.drawnKey = key;
    this.drawnState = state;
    this.drawn = { ...this.drawn, count: state.count };
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
    // Prompt 015: room for the note symbol next to the bookmark flag.
    const note = session.notes().size > 0 ? 1.2 : 0;
    return Math.ceil((digits + names + note) * this.fontSize() * CHAR_WIDTH_FACTOR + 12 + stripe);
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
    if (this.selectionInTable()) return;
    // A released selection lets the view catch up; the next selection holds only once dragged again.
    if (!this.dragged) this.dragSelected = false;
    if (this.heldForSelection && !this.columnDragging()) this.redraw.update((r) => r + 1);
  };

  /** Drops a text selection (stale, or one the user is done with) so it neither blocks nor holds anything. */
  private clearTextSelection(): void {
    this.dragSelected = false;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) selection.removeAllRanges();
  }

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
    // The gutter is locked in front (`movable: false`); should it ever not be, the state puts it back.
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
    this.applyColumns(
      resolveColumns(set.columns, defaultColumnLayout(profileId), this.charWidth()),
      false,
    );
  }

  /**
   * Double click on a column's edge: as wide as its content in the rows on screen (no file scan). The column that
   * fills the view keeps its width.
   */
  private fitWidth(ctx: ColumnAutoWidthContextIf): number | undefined {
    const index = ctx.columnIndex;
    const area = this.config().area;
    const id = area.columnAt(index).id;
    const current = this.api()?.getTableModel().getColumnWidth(index);
    if (!area.columnView || id === ID_NUMBER || id === this.filled?.id) return current;
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
    return clampWidth(widest + CELL_PADDING);
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
      eventId: line && !line.isContinuation ? this.eventIdOf(line) : null,
      selectedText: text,
      cell: cell ? { label: cellLabel, value: cell.value } : null,
      hasLine: !!line,
      tabLimit: this.sessions.filterTabLimit(session),
      hasNote: !!line && session.notes().has(line.line),
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

  /** Prompt 018: the event ID of a Windows event line (column `eventId` of the profile `winevent`). */
  private eventIdOf(line: LogLine): string | null {
    const set = this.session().columns();
    if (set?.profileId !== WINEVENT_PROFILE) return null;
    const index = set.columns.findIndex((c) => c.id === 'eventId');
    const span = index >= 0 ? line.fields[index] : undefined;
    return span && span[1] > span[0] ? line.text.slice(span[0], span[1]) : null;
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
      case 'same-event-id': {
        const id = menu.logLine ? this.eventIdOf(menu.logLine) : null;
        if (id) this.sessions.filterByValue(session, 'eventId', id);
        break;
      }
      case 'filter-text-tab': {
        // Prompt 013: like `I`, but as a tab below this one.
        const first = menu.text.split(/\r?\n/).find((l) => l.trim()) ?? '';
        const text = first.trim().slice(0, 4096);
        if (text) {
          void this.sessions.openFilterTab(session, {
            cond: { type: 'text', text, isRegex: false, caseSensitive: false },
          });
        }
        break;
      }
      case 'filter-value-tab':
        if (menu.cell) {
          void this.sessions.openFilterTab(session, {
            cond: {
              type: 'field',
              column: menu.cell.column,
              op: 'eq',
              value: menu.cell.value.trim().slice(0, 4096),
              value2: null,
              caseSensitive: false,
            },
          });
        }
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
      // Prompt 015: the entry under the pointer (or the selection it lies in).
      case 'note':
      case 'share-markdown':
      case 'share-jira': {
        const selection = session.selection();
        const inSelection =
          selection &&
          menu.line !== null &&
          menu.line >= selection.first &&
          menu.line <= selection.last;
        if (!inSelection && menu.line !== null) {
          await this.sessions.selectEntry(session, menu.line, false);
        }
        if (action === 'note') this.sessions.openNote(session);
        else
          await this.sessions.shareSelection(
            session,
            action === 'share-markdown' ? 'markdown' : 'jira',
          );
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

  /**
   * The user ended a resize or move in the header (also the double click on an edge): store order and widths.
   * Drawing waited while the table owned the columns (`columnDragging`); a cancel only lets it catch up.
   */
  protected onColumnDragEnd(event: GeColumnResizeEvent | GeColumnMoveEvent): void {
    if (event.type === 'end') this.syncFromTable();
    else if (this.heldForSelection) this.redraw.update((r) => r + 1);
  }

  /** A resize or move in the header is running: drawing would set widths of its own (the filled column). */
  private columnDragging(): boolean {
    return this.api()?.isColumnDragging() ?? false;
  }

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

  /** The table's drag of a press (text being marked in the rows): from 4 px on it is no click any more. */
  protected onTableDragging(event: GeMouseEvent): void {
    if (this.columnDragging() || this.dragged) return;
    this.dragged = isDrag(event.draggingX, event.draggingY);
  }

  /** After the click of the press: marked text that remains is the user's and holds the view until it goes. */
  protected onTableDraggingEnded(): void {
    if (!this.dragged) return;
    this.dragged = false;
    this.dragSelected = this.selectionInTable();
    if (!this.dragSelected && this.heldForSelection) this.redraw.update((r) => r + 1);
  }

  /**
   * The table's click (`mouseClicked`, synchronous with `debounceMouseClickDelay` 0). A plain click selects the
   * entry under the pointer (Shift: extends), whatever text is marked anywhere: the marking goes. A drag marks
   * text instead and keeps the entry (filter on marked text, copy). `clickCount` 2 is the double click.
   */
  protected onTableClick(event: GeMouseEvent): void {
    if (event.areaIdent !== 'body' || event.rowIndex < 0) return;
    if (event.clickCount >= 2) {
      this.onTableDoubleClick(event);
      return;
    }
    if (this.dragged) {
      // The table moved its focus cell and repaints after this event; that would rebuild the rows and drop
      // the text just marked. Our own drawing repaints when it needs to.
      queueMicrotask(() => this.api()?.getTableScope().cancelPendingRepaint());
      return;
    }
    const line = this.session().cache.line(event.rowIndex);
    if (!line) return;
    this.clearTextSelection();
    this.clickedAt = performance.now();
    void this.sessions.selectEntry(this.session(), line.line, !!event.originalEvent?.shiftKey);
  }

  /**
   * Double click opens the detail panel. Its first click already chose the entry (in a running tail another
   * line lies under the pointer by now), so only without a selection does the target count. The word the
   * double click marked goes again: it would hold the view and is no text the user chose.
   */
  private onTableDoubleClick(event: GeMouseEvent): void {
    this.clearTextSelection();
    const session = this.session();
    const clickPending = performance.now() - this.clickedAt < 1000;
    if (!session.selection() && !clickPending) {
      const line = session.cache.line(event.rowIndex);
      if (line) void this.sessions.selectEntry(session, line.line, false);
    }
    if (!this.settings().detailVisible) this.settingsService.update({ detailVisible: true });
  }

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

  /**
   * ↑/↓ with a selection: the previous/next entry of the view becomes the selection (Shift: extends it), and the
   * view scrolls just enough to show it. Up from the end stops following, so the tail does not carry it away.
   */
  private stepSelection(direction: Direction, extend: boolean): void {
    if (this.stepsPending >= 2) return;
    this.stepsPending++;
    this.stepQueue = this.stepQueue
      .then(async () => {
        const session = this.session();
        const rows = await this.sessions.stepSelection(session, direction, extend);
        if (!rows || session !== this.session()) return;
        if (direction < 0) session.setFollow(false);
        const next = revealRows(session.scroll(), rows.first, rows.last, this.metrics());
        if (!next) return;
        session.setFollow(false);
        session.scroll.set(next);
      })
      .finally(() => this.stepsPending--);
  }

  private toggleColumnMode(): void {
    if (!columnsAvailable(this.session().columns())) return;
    this.settingsService.update({
      columnMode: this.settings().columnMode === 'columns' ? 'raw' : 'columns',
    });
  }

  /**
   * Prompt 021: the keys of the log are actions; the dispatcher decides where they act (not in fields, dialogs,
   * menus or the widgets with own keys). The dashboard lies over the log (prompt 012): its keys are its own.
   */
  private registerActions(): () => void {
    const view = () => this.session().mode() !== 'dashboard';
    const page = () => Math.max(this.rowH(), this.bodyH() - this.rowH());
    const s = () => this.session();
    const off = this.actions.registerAll(
      {
        FOLLOW_END: () => this.jumpToEnd(),
        TOGGLE_FOLLOW: () => {
          if (s().follow()) s().setFollow(false);
          else this.jumpToEnd();
        },
        TOGGLE_FREEZE: () => this.sessions.toggleFreeze(s()),
        TOGGLE_COLUMNS: () => this.toggleColumnMode(),
        TOGGLE_DETAIL: () =>
          this.settingsService.update({ detailVisible: !this.settings().detailVisible }),
        // Prompt 014: the timeline above the log.
        TOGGLE_TIMELINE: () =>
          this.settingsService.update({ showTimeline: !this.settings().showTimeline }),
        GO_START: () => {
          s().setFollow(false);
          s().scroll.set({ top: 0, subPx: 0 });
        },
        SCROLL_PAGE_DOWN: () => this.scrollPixels(page()),
        SCROLL_PAGE_UP: () => this.scrollPixels(-page()),
        // With a selection the arrows move it from entry to entry, without one they scroll.
        SCROLL_LINE_DOWN: () => {
          if (s().selection()) this.stepSelection(1, false);
          else this.scrollPixels(this.rowH());
        },
        SCROLL_LINE_UP: () => {
          if (s().selection()) this.stepSelection(-1, false);
          else this.scrollPixels(-this.rowH());
        },
        // Marked text in the table goes first, the selected entry with the next Escape.
        CLEAR_SELECTION: () => {
          if (this.selectionInTable()) this.clearTextSelection();
          else s().selection.set(null);
        },
        // Prompt 007: errors, warnings and bookmarks in the view, the whole log and back.
        NEXT_ERROR: () => this.sessions.jumpToLevel(s(), 'error', true),
        PREV_ERROR: () => this.sessions.jumpToLevel(s(), 'error', false),
        NEXT_WARNING: () => this.sessions.jumpToLevel(s(), 'warn', true),
        PREV_WARNING: () => this.sessions.jumpToLevel(s(), 'warn', false),
        NEXT_BOOKMARK: () => this.sessions.jumpToBookmark(s(), true),
        PREV_BOOKMARK: () => this.sessions.jumpToBookmark(s(), false),
        TOGGLE_BOOKMARK: () => this.sessions.toggleBookmark(s()),
        // Prompt 015: a note on the entry.
        EDIT_NOTE: () => this.sessions.openNote(s()),
        TOGGLE_FULL_LOG: () => this.sessions.toggleFullLog(s()),
        // Prompt 010: marked text into the filter tree (or excluded), sections from the selection.
        FILTER_ON_TEXT: () =>
          this.sessions.filterOnText(s(), window.getSelection()?.toString() ?? '', false),
        FILTER_EXCLUDE_TEXT: () =>
          this.sessions.filterOnText(s(), window.getSelection()?.toString() ?? '', true),
        SECTION_FROM: () => this.sessions.filterSection(s(), 'from'),
        SECTION_TO: () => this.sessions.filterSection(s(), 'to'),
      },
      view,
    );
    // Marked text copies itself (the WebView's own copy); only selected lines are ours.
    const offCopy = this.actions.register(
      'COPY_SELECTION',
      () => this.sessions.copySelection(s()),
      () => view() && !window.getSelection()?.toString() && !!s().selection(),
    );
    const offSteps = this.actions.registerAll(
      {
        EXTEND_SELECTION_DOWN: () => this.stepSelection(1, true),
        EXTEND_SELECTION_UP: () => this.stepSelection(-1, true),
        // Enter: the detail panel for the selection (stays open when it is).
        OPEN_DETAIL: () => {
          if (!this.settings().detailVisible) this.settingsService.update({ detailVisible: true });
        },
      },
      () => view() && !!s().selection(),
    );
    const offMenu = this.actions.register(
      'OPEN_COLUMN_MENU',
      () => this.openMenu(this.lineNumbers() ? this.gutterWidth() : 0, this.headerH()),
      () => view() && this.config().area.columnView,
    );
    return () => {
      off();
      offCopy();
      offSteps();
      offMenu();
    };
  }
}
