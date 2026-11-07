import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { LogLine } from '../../core/log/log.models';
import { SettingsService } from '../../core/settings/settings.service';
import { formatCount } from '../../shared/format';
import { LogSessionService } from '../sessions/log-session.service';
import { SessionState } from '../sessions/session-state';
import { TextSegment, lineSegments } from './highlight';
import {
  ViewMetrics,
  bottomAnchor,
  clampToBottom,
  scrollBy,
  scrollRange,
  scrollTopToTop,
  topToScrollTop,
  visibleRowCount,
} from './viewport-logic';

interface Row {
  position: number;
  line: LogLine | null;
  segments: readonly TextSegment[];
  cls: string;
  number: string;
}

const LINE_HEIGHT_FACTOR = 1.5;
const WHEEL_LINE_PX = 40;

/**
 * The virtual log list. Own implementation instead of a table or the CDK viewport: both make one
 * element as high as all rows together, which ends at about 1.5 million lines (browser limit of
 * ~33 million px) and rules out variable heights. See viewport-logic.ts.
 */
@Component({
  selector: 'app-log-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scroller" #scroller (scroll)="onScrollbar()">
      <div
        class="view"
        #view
        [class.wrap]="wrap()"
        [style.--row-h.px]="rowH()"
        [style.--font-size.px]="fontSize()"
        [style.--gutter.ch]="gutterChars()"
        [style.--sx.px]="session().scrollLeft()"
      >
        <div
          class="rows"
          [style.transform]="'translate3d(0,' + -session().scroll().subPx + 'px,0)'"
        >
          @for (row of rows(); track row.position) {
            <div
              [class]="row.cls"
              [attr.data-line]="row.line?.line"
              [attr.data-position]="row.position"
            >
              @if (lineNumbers()) {
                <span class="gutter">{{ row.number }}</span>
              }
              <span class="mark"></span>
              <span class="text">
                @for (seg of row.segments; track $index) {
                  <span [class]="seg.cls">{{ seg.text }}</span>
                }
                @if (row.line?.truncated) {
                  <span class="cut"> … (gekürzt)</span>
                }
              </span>
            </div>
          }
        </div>
        @if (session().filteredLines() === 0) {
          <div class="empty">{{ emptyText() }}</div>
        }
      </div>
      <div class="spacer" [style.height.px]="spacerH()" [style.width.px]="spacerW()"></div>
    </div>
    @if (session().newLines() > 0) {
      <button type="button" class="new-lines" (click)="jumpToEnd()">
        ▼ {{ formatCount(session().newLines()) }} neue Zeilen
      </button>
    } @else if (!session().follow()) {
      <button type="button" class="new-lines quiet" (click)="jumpToEnd()">▼ Ans Ende</button>
    }
  `,
  styleUrl: './log-view.css',
})
export class LogViewComponent implements OnInit, OnDestroy {
  readonly session = input.required<SessionState>();

  private readonly settings = inject(SettingsService).settings;
  private readonly sessions = inject(LogSessionService);
  private readonly scroller = viewChild.required<ElementRef<HTMLElement>>('scroller');
  private readonly view = viewChild.required<ElementRef<HTMLElement>>('view');

  protected readonly formatCount = formatCount;
  protected readonly fontSize = computed(() => this.settings().fontSize);
  protected readonly wrap = computed(() => this.settings().wrapLines);
  protected readonly lineNumbers = computed(() => this.settings().showLineNumbers);
  protected readonly rowH = computed(() => Math.round(this.fontSize() * LINE_HEIGHT_FACTOR));

  private readonly viewportH = signal(400);
  private readonly viewportW = signal(800);
  private readonly contentW = signal(0);
  /** Bumped when measured heights change, so positions are computed again. */
  private readonly heightsRevision = signal(0);
  private readonly heights = new Map<number, number>();

  private expectedScrollTop = 0;
  private resizeObserver: ResizeObserver | null = null;
  private dragging = false;

  private readonly metrics = computed<ViewMetrics>(() => {
    this.heightsRevision();
    const wrapped = this.wrap();
    return {
      count: this.session().displayedLines(),
      viewportH: this.viewportH(),
      rowH: this.rowH(),
      heightOf: wrapped ? (p) => this.heights.get(p) ?? this.rowH() : undefined,
    };
  });

  protected readonly gutterChars = computed(() =>
    Math.max(4, String(this.session().update().totalLines).length + 1),
  );

  protected readonly rows = computed<Row[]>(() => {
    const session = this.session();
    const cache = session.cache;
    cache.revision();
    const top = session.scroll().top;
    const count = session.displayedLines();
    const end = Math.min(count, top + visibleRowCount(this.viewportH(), this.rowH()));
    const selection = session.selection();
    const hitLine = session.currentHitLine();
    const rows: Row[] = [];
    for (let position = top; position < end; position++) {
      const line = cache.line(position);
      const selected =
        !!line && !!selection && line.line >= selection.first && line.line <= selection.last;
      let cls = line ? `row lv-${line.level}` : 'row loading';
      if (line?.isContinuation) cls += ' cont';
      if (selected) cls += ' selected';
      if (line && line.line === hitLine) cls += ' current-hit';
      rows.push({
        position,
        line,
        segments: line ? lineSegments(line) : [],
        cls,
        number: line ? String(line.line + 1) : '',
      });
    }
    return rows;
  });

  protected readonly spacerH = computed(() =>
    scrollRange(this.session().displayedLines(), this.viewportH(), this.rowH()),
  );
  protected readonly spacerW = computed(() =>
    this.wrap() ? 0 : Math.max(0, this.contentW() - this.viewportW()) + this.viewportW(),
  );

  protected readonly emptyText = computed(() => {
    const update = this.session().update();
    if (update.filterPending) return 'Filter wird berechnet …';
    if (update.totalLines === 0) return 'Datei ist leer, warte auf neue Zeilen …';
    return `Keine passenden Zeilen (${formatCount(update.totalLines)} ausgeblendet)`;
  });

  constructor() {
    // Follow: every change of the line count or of the viewport keeps the end in view.
    effect(() => {
      const session = this.session();
      if (session.follow()) {
        const anchor = bottomAnchor(this.metrics());
        session.scroll.set(anchor);
      }
    });
    // A view that shrank (filter, truncation) must not leave the position behind the end.
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
      // Following, the new end has to arrive before the view can move there.
      const wanted = session.wantedRange();
      session.cache.ensure(wanted.start, wanted.end);
    });
    effect(() => {
      // Heights belong to a view and a width.
      const generation = this.session().update().viewGeneration;
      void [generation, this.viewportW(), this.fontSize()];
      this.heights.clear();
    });
    effect(() => {
      this.session();
      this.contentW.set(0);
    });
    afterRenderEffect(() => {
      this.rows();
      this.measure();
      this.syncScrollbar();
    });
  }

  ngOnInit(): void {
    const scroller = this.scroller().nativeElement;
    scroller.addEventListener('wheel', this.onWheel, { passive: false });
    this.view().nativeElement.addEventListener('click', this.onClick);
    this.resizeObserver = new ResizeObserver(() => {
      this.viewportH.set(scroller.clientHeight);
      this.viewportW.set(scroller.clientWidth);
    });
    this.resizeObserver.observe(scroller);
    this.viewportH.set(scroller.clientHeight);
    this.viewportW.set(scroller.clientWidth);
    document.addEventListener('keydown', this.onKey);
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    document.removeEventListener('keydown', this.onKey);
  }

  protected jumpToEnd(): void {
    const session = this.session();
    session.setFollow(true);
    session.scroll.set(bottomAnchor(this.metrics()));
  }

  private measure(): void {
    const view = this.view().nativeElement;
    if (this.wrap()) {
      let changed = false;
      for (const el of Array.from(view.querySelectorAll<HTMLElement>('.row'))) {
        const position = Number(el.dataset['position']);
        const height = el.offsetHeight;
        if (this.heights.get(position) !== height) {
          this.heights.set(position, height);
          changed = true;
        }
      }
      if (changed) this.heightsRevision.update((r) => r + 1);
      return;
    }
    let widest = this.contentW();
    for (const el of Array.from(view.querySelectorAll<HTMLElement>('.row'))) {
      const text = el.querySelector<HTMLElement>('.text');
      if (!text) continue;
      const width = text.offsetLeft + text.offsetWidth + 24;
      if (width > widest) widest = width;
    }
    if (widest !== this.contentW()) this.contentW.set(widest);
  }

  /** The native scrollbar mirrors the line position. */
  private syncScrollbar(): void {
    if (this.dragging) return;
    const scroller = this.scroller().nativeElement;
    const target = Math.round(
      topToScrollTop(
        this.session().scroll().top,
        this.session().displayedLines(),
        this.viewportH(),
        this.rowH(),
      ),
    );
    this.expectedScrollTop = target;
    if (Math.abs(scroller.scrollTop - target) >= 1) scroller.scrollTop = target;
  }

  protected onScrollbar(): void {
    const session = this.session();
    const scroller = this.scroller().nativeElement;
    if (scroller.scrollLeft !== session.scrollLeft()) session.scrollLeft.set(scroller.scrollLeft);
    if (Math.abs(scroller.scrollTop - this.expectedScrollTop) < 2) return;
    // Dragged by the user.
    this.expectedScrollTop = scroller.scrollTop;
    const count = session.displayedLines();
    const range = scrollRange(count, this.viewportH(), this.rowH());
    const top = scrollTopToTop(scroller.scrollTop, count, this.viewportH(), this.rowH());
    if (scroller.scrollTop >= range - 1) {
      this.jumpToEnd();
    } else {
      session.setFollow(false);
      session.scroll.set({ top, subPx: 0 });
    }
  }

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_LINE_PX : 1;
    const dx = event.shiftKey ? event.deltaX + event.deltaY : event.deltaX;
    const dy = event.shiftKey ? 0 : event.deltaY;
    if (dx !== 0) this.scroller().nativeElement.scrollLeft += dx * unit;
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

  private readonly onClick = (event: MouseEvent): void => {
    // Dragging over text selects text, that is not a click on the line.
    if (window.getSelection()?.toString()) return;
    const row = (event.target as HTMLElement).closest<HTMLElement>('.row');
    const line = row?.dataset['line'];
    if (line === undefined) return;
    void this.sessions.selectEntry(this.session(), Number(line), event.shiftKey);
  };

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
