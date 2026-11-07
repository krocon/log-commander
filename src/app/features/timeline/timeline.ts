import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { LogApi } from '../../core/log/log-api';
import { TimeRange, Timeline } from '../../core/log/log.models';
import { SettingsService } from '../../core/settings/settings.service';
import { LogSessionService } from '../sessions/log-session.service';
import { SessionState } from '../sessions/session-state';
import {
  ColumnPart,
  bucketAt,
  bucketTooltip,
  filterTimeText,
  formatTime,
  needsDate,
  outages,
  outsideText,
  timeTicks,
  timeToX,
  timelineColumns,
  timelineSummary,
  visibleBand,
  windowOf,
  xToTime,
  zoomRange,
} from './timeline-logic';

/** At most this often the timeline is asked for (prompt 014: twice a second). */
const LOAD_INTERVAL_MS = 500;
const MAX_BUCKETS = 4096;
/** A column is this many pixels wide (one less is drawn, a pixel stays free). */
const COLUMN_PX = 3;
/** Height of the axis labels below the columns. */
const AXIS_PX = 14;
/** A press that moves less than this is a click (jump), more is a drag (window). */
const DRAG_PX = 4;

interface Colors {
  bg: string;
  band: string;
  bandEdge: string;
  parts: Record<ColumnPart, string>;
  gap: string;
  accent: string;
  text: string;
}

/** An answer of the backend for one tab and range. */
interface Loaded extends Timeline {
  tabId: number;
  zoomed: boolean;
}

/**
 * Timeline above the log (prompt 014): the entries of the whole file over time, stacked by level (the rest in
 * neutral, WARN, ERROR, FATAL on top), outages hatched, the band of what the log shows. Data from
 * `get_timeline` (a running summary per chunk of lines in the backend), at most twice a second. A click jumps to
 * the time (the selection stays, following stops), a drag marks a window to filter on or zoom into; the wheel
 * zooms, „Ganze Datei“ goes back. By keyboard the arrows move a cursor (Shift: window), `Enter` jumps.
 */
@Component({
  selector: 'app-timeline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'timeline',
    '[class.no-times]': 'noTimes()',
    '[attr.data-entries]': 'current()?.entries ?? -1',
    '[attr.data-has-times]': 'current()?.hasTimes ?? null',
    '[attr.data-from]': 'current()?.from ?? null',
    '[attr.data-to]': 'current()?.to ?? null',
    '[attr.data-buckets]': 'current()?.buckets?.length ?? 0',
    '[attr.data-outages]': 'outagesAttr()',
    '[attr.data-zoomed]': 'zoom() ? 1 : 0',
    '[attr.data-window]': 'windowAttr()',
  },
  template: `
    @if (noTimes()) {
      <p class="hint">Zeitstrahl: keine Zeitstempel in den Einträgen erkannt</p>
    } @else {
      <div
        #track
        class="track"
        tabindex="0"
        role="slider"
        aria-roledescription="Zeitstrahl"
        [attr.aria-label]="summary()"
        aria-valuemin="0"
        [attr.aria-valuemax]="bucketCount() - 1"
        [attr.aria-valuenow]="cursor() ?? 0"
        [attr.aria-valuetext]="cursorText()"
        [title]="tooltip()"
        (mousedown)="onDown($event)"
        (mousemove)="onHover($event)"
        (mouseleave)="tooltip.set('')"
        (wheel)="onWheel($event)"
        (keydown)="onKey($event)"
        (focus)="onFocus()"
        (blur)="requestDraw()"
      >
        <canvas #canvas></canvas>
      </div>
      <div class="side">
        @if (window(); as w) {
          <button
            type="button"
            class="filter"
            [title]="'Nur ' + windowText() + ' zeigen'"
            (click)="asFilter()"
          >
            Als Filter
          </button>
          <button
            type="button"
            title="In das markierte Zeitfenster zoomen"
            (click)="zoomToWindow()"
          >
            Hineinzoomen
          </button>
          <button
            type="button"
            class="clear"
            aria-label="Markierung aufheben"
            title="Markierung aufheben (Esc)"
            (click)="window.set(null)"
          >
            ×
          </button>
        } @else if (zoom()) {
          <button type="button" title="Zoom zurücksetzen: ganze Datei" (click)="setZoom(null)">
            Ganze Datei
          </button>
        }
        @if (outside(); as text) {
          <span class="outside" [title]="text">{{ outsideShort() }}</span>
        }
      </div>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex: none;
      height: 56px;
      background: var(--ruler-bg);
      border-bottom: 1px solid var(--border);
    }
    :host(.no-times) {
      height: auto;
    }
    .hint {
      margin: 0;
      padding: 3px 10px;
      font-size: 12px;
      color: var(--text-dim);
    }
    .track {
      flex: 1 1 0;
      min-width: 0;
      position: relative;
      cursor: crosshair;
    }
    .track:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
    }
    .side {
      flex: none;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: stretch;
      gap: 2px;
      padding: 2px 6px;
      max-width: 120px;
    }
    .side:empty {
      display: none;
    }
    .side button {
      height: 16px;
      padding: 0 6px;
      font-size: 11px;
      line-height: 14px;
    }
    .outside {
      font-size: 11px;
      color: var(--text-dim);
      white-space: nowrap;
    }
  `,
})
export class TimelineComponent implements OnDestroy {
  readonly session = input.required<SessionState>();

  private readonly api = inject(LogApi);
  private readonly sessions = inject(LogSessionService);
  private readonly settings = inject(SettingsService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly track = viewChild<ElementRef<HTMLElement>>('track');
  private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');

  /** Width of the track in CSS pixels. */
  private readonly width = signal(0);
  protected readonly loaded = signal<Loaded | null>(null);
  /** The zoom of each tab (`null`: whole file); the axis of the whole file for the zoom limits. */
  private readonly zooms = signal(new Map<number, TimeRange>());
  private readonly fullAxis = new Map<number, TimeRange>();
  /** A window marked by dragging or Shift+arrows. */
  protected readonly window = signal<TimeRange | null>(null);
  /** Keyboard cursor: a bucket. */
  protected readonly cursor = signal<number | null>(null);
  private readonly colorRevision = signal(0);
  protected readonly tooltip = signal('');

  protected readonly zoom = computed(() => this.zooms().get(this.session().id) ?? null);
  protected readonly current = computed(() => {
    const loaded = this.loaded();
    const session = this.session();
    if (!loaded || loaded.tabId !== session.id) return null;
    if (loaded.epoch !== session.update().epoch) return null;
    if (loaded.zoomed !== (this.zoom() !== null)) return null;
    return loaded;
  });
  protected readonly noTimes = computed(() => this.current()?.hasTimes === false);
  protected readonly bucketCount = computed(() => this.current()?.buckets.length ?? 0);
  private readonly outageList = computed(() => {
    const current = this.current();
    return current ? outages(current) : [];
  });
  protected readonly outagesAttr = computed(() =>
    this.outageList()
      .map((g) => `${g.from}:${g.to}`)
      .join(','),
  );
  protected readonly windowAttr = computed(() => {
    const w = this.window();
    return w ? `${w.from}:${w.to}` : null;
  });
  protected readonly summary = computed(() => {
    const current = this.current();
    return current ? timelineSummary(current) : 'Zeitstrahl wird geladen';
  });
  protected readonly cursorText = computed(() => {
    const current = this.current();
    const cursor = this.cursor();
    return current && cursor !== null ? bucketTooltip(current, cursor) : '';
  });
  protected readonly outside = computed(() => {
    const current = this.current();
    return current ? outsideText(current) : '';
  });
  protected readonly outsideShort = computed(() => {
    const current = this.current();
    if (!current) return '';
    return [
      current.before > 0 ? `◂ ${current.before}` : '',
      current.after > 0 ? `${current.after} ▸` : '',
    ]
      .filter(Boolean)
      .join(' ');
  });
  protected readonly windowText = computed(() => {
    const w = this.window();
    if (!w) return '';
    const date = needsDate(w.from, w.to);
    return `${formatTime(w.from, date)}–${formatTime(w.to)}`;
  });

  /** What a load depends on; equal strings start no load (a frozen tab sends equal updates). */
  private readonly loadKey = computed(() => {
    const session = this.session();
    const { totalLines, epoch } = session.update();
    const zoom = this.zoom();
    return `${session.id}|${totalLines}|${epoch}|${zoom?.from}|${zoom?.to}|${this.buckets()}`;
  });
  private readonly buckets = computed(() =>
    Math.min(MAX_BUCKETS, Math.max(0, Math.floor(this.width() / COLUMN_PX))),
  );

  private resizeObserver: ResizeObserver | null = null;
  private themeObserver: MutationObserver | null = null;
  private colors: Colors | null = null;
  private colorsFor = -1;
  private frame = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastLoad = -Infinity;
  private request = 0;
  private drag: { startX: number; startTs: number; moved: boolean } | null = null;
  /** Bucket where a window by Shift+arrows started. */
  private keyAnchor: number | null = null;

  constructor() {
    effect(() => {
      this.loadKey();
      untracked(() => this.scheduleLoad());
    });
    effect(() => {
      // A new tab: its own window and cursor.
      this.session();
      untracked(() => {
        this.window.set(null);
        this.cursor.set(null);
        this.keyAnchor = null;
      });
    });
    effect(() => {
      // The track comes and goes with the hint for files without times.
      const track = this.track()?.nativeElement;
      untracked(() => this.observe(track ?? null));
    });
    effect(() => {
      void [this.current(), this.colorRevision(), this.width(), this.window(), this.cursor()];
      const session = this.session();
      void [
        session.displayedLines(),
        session.scroll(),
        session.visibleRows(),
        session.cache.revision(),
      ];
      untracked(() => this.requestDraw());
    });
    this.themeObserver = new MutationObserver(() => this.colorRevision.update((r) => r + 1));
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'style'],
    });
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.themeObserver?.disconnect();
    if (this.timer) clearTimeout(this.timer);
    if (this.frame) cancelAnimationFrame(this.frame);
    this.endDrag();
    this.request++;
  }

  private observe(track: HTMLElement | null): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (!track) return;
    this.resizeObserver = new ResizeObserver(() => this.width.set(track.clientWidth));
    this.resizeObserver.observe(track);
    this.width.set(track.clientWidth);
  }

  // ---------------------------------------------------------------- loading

  private scheduleLoad(): void {
    if (this.timer) return;
    const wait = this.lastLoad + LOAD_INTERVAL_MS - performance.now();
    if (wait <= 0) {
      this.load();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.load();
    }, wait);
  }

  private load(): void {
    const session = this.session();
    // Without a track yet (or a file without times): a few buckets are enough to learn about the times.
    const buckets = this.buckets() || 1;
    this.lastLoad = performance.now();
    const zoom = this.zoom();
    const request = ++this.request;
    const tabId = session.id;
    this.api
      .getTimeline(session.sessionId, zoom?.from ?? null, zoom?.to ?? null, buckets)
      .then((timeline) => {
        if (request !== this.request) return;
        if (!zoom && timeline.hasTimes)
          this.fullAxis.set(tabId, { from: timeline.from, to: timeline.to });
        this.loaded.set({ ...timeline, tabId, zoomed: zoom !== null });
      })
      .catch(() => {
        // No backend (browser) or a closed tab: the strip stays empty.
      });
  }

  // ---------------------------------------------------------------- drawing

  protected requestDraw(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private readColors(): Colors {
    const revision = this.colorRevision();
    if (this.colors && this.colorsFor === revision) return this.colors;
    const style = getComputedStyle(this.host.nativeElement);
    const token = (name: string) => style.getPropertyValue(`--${name}`).trim();
    this.colors = {
      bg: token('ruler-bg'),
      band: token('ruler-band'),
      bandEdge: token('ruler-band-edge'),
      parts: {
        all: token('tl-all'),
        warn: token('ruler-warn'),
        error: token('ruler-error'),
        fatal: token('ruler-fatal'),
      },
      gap: token('tl-gap'),
      accent: token('accent'),
      text: token('text-dim'),
    };
    this.colorsFor = revision;
    return this.colors;
  }

  /** First and last file line the log shows, from the page cache. */
  private visibleLines(): [number | null, number | null] {
    const session = this.session();
    const top = session.scroll().top;
    const rows = Math.min(session.visibleRows(), Math.max(0, session.displayedLines() - top));
    const first = session.cache.line(top)?.line ?? null;
    let last: number | null = null;
    for (let p = top + rows - 1; p >= top && last === null; p--) {
      last = session.cache.line(p)?.line ?? null;
    }
    return [first, last];
  }

  private draw(): void {
    const canvas = this.canvas()?.nativeElement;
    if (!canvas) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width <= 0 || height <= 0) return;
    const ratio = window.devicePixelRatio || 1;
    const pixelW = Math.round(width * ratio);
    const pixelH = Math.round(height * ratio);
    if (canvas.width !== pixelW || canvas.height !== pixelH) {
      canvas.width = pixelW;
      canvas.height = pixelH;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const colors = this.readColors();
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, width, height);
    const current = this.current();
    if (!current || !current.hasTimes) return;
    const plotH = Math.max(1, height - AXIS_PX);
    const { from, to } = current;

    // The band of what the log shows, behind the columns.
    const [first, last] = this.visibleLines();
    const band = visibleBand(current, first, last, width);
    if (band) {
      ctx.fillStyle = colors.band;
      ctx.fillRect(band.x, 0, band.w, plotH);
      ctx.fillStyle = colors.bandEdge;
      ctx.fillRect(band.x, 0, 1, plotH);
      ctx.fillRect(band.x + band.w - 1, 0, 1, plotH);
    }

    // Outages: hatched over their whole length.
    ctx.save();
    ctx.strokeStyle = colors.gap;
    ctx.lineWidth = 1;
    for (const gap of this.outageList()) {
      const x1 = Math.max(0, timeToX(gap.from, from, to, width));
      const x2 = Math.min(width, timeToX(gap.to, from, to, width));
      if (x2 - x1 < 1) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x1, 0, x2 - x1, plotH);
      ctx.clip();
      ctx.beginPath();
      for (let x = x1 - plotH; x < x2; x += 6) {
        ctx.moveTo(x, plotH);
        ctx.lineTo(x + plotH, 0);
      }
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();

    for (const rect of timelineColumns(current.buckets, width, plotH)) {
      ctx.fillStyle = colors.parts[rect.part];
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    }

    // The marked window.
    const w = this.window();
    if (w) {
      const x1 = timeToX(w.from, from, to, width);
      const x2 = timeToX(w.to, from, to, width);
      ctx.save();
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = colors.accent;
      ctx.fillRect(x1, 0, Math.max(1, x2 - x1), plotH);
      ctx.restore();
      ctx.fillStyle = colors.accent;
      ctx.fillRect(x1, 0, 1, plotH);
      ctx.fillRect(Math.max(x1, x2 - 1), 0, 1, plotH);
    }

    // Keyboard cursor while focused.
    const cursor = this.cursor();
    if (cursor !== null && document.activeElement === this.track()?.nativeElement) {
      const n = current.buckets.length;
      const x = Math.round(((cursor + 0.5) / n) * width);
      ctx.fillStyle = colors.accent;
      ctx.fillRect(x - 1, 0, 2, plotH);
      ctx.beginPath();
      ctx.moveTo(x - 4, 0);
      ctx.lineTo(x + 4, 0);
      ctx.lineTo(x, 5);
      ctx.closePath();
      ctx.fill();
    }

    // Axis: a line and labels in local time.
    ctx.fillStyle = colors.text;
    ctx.fillRect(0, plotH, width, 1);
    ctx.font = '10px var(--font-ui), system-ui, sans-serif';
    ctx.textBaseline = 'top';
    for (const tick of timeTicks(from, to, width)) {
      ctx.fillRect(Math.round(tick.x), plotH, 1, 3);
      const textW = ctx.measureText(tick.label).width;
      if (tick.x + 2 + textW > width) continue;
      ctx.fillText(tick.label, Math.round(tick.x) + 2, plotH + 2);
    }
  }

  // ---------------------------------------------------------------- input

  private xOf(event: MouseEvent): number {
    const track = this.track()?.nativeElement;
    return track ? event.clientX - track.getBoundingClientRect().left : 0;
  }

  private timeAt(x: number): number | null {
    const current = this.current();
    if (!current?.hasTimes) return null;
    return xToTime(x, current.from, current.to, this.width());
  }

  protected onHover(event: MouseEvent): void {
    const current = this.current();
    if (!current || this.drag) return;
    const index = bucketAt(this.xOf(event), current.buckets.length, this.width());
    this.tooltip.set(bucketTooltip(current, index));
  }

  protected onDown(event: MouseEvent): void {
    if (event.button !== 0) return;
    const ts = this.timeAt(this.xOf(event));
    if (ts === null) return;
    event.preventDefault();
    this.track()?.nativeElement.focus();
    this.drag = { startX: event.clientX, startTs: ts, moved: false };
    window.addEventListener('mousemove', this.onDragMove);
    window.addEventListener('mouseup', this.onDragEnd);
  }

  private readonly onDragMove = (event: MouseEvent): void => {
    const drag = this.drag;
    if (!drag) return;
    if (!drag.moved && Math.abs(event.clientX - drag.startX) < DRAG_PX) return;
    drag.moved = true;
    const ts = this.timeAt(this.xOf(event));
    if (ts !== null) this.window.set(windowOf(drag.startTs, ts));
  };

  private readonly onDragEnd = (event: MouseEvent): void => {
    const drag = this.drag;
    this.endDrag();
    if (!drag) return;
    if (drag.moved) {
      this.onDragMove(event);
      return;
    }
    // A click: jump there.
    this.window.set(null);
    void this.sessions.jumpToTime(this.session(), drag.startTs);
  };

  private endDrag(): void {
    this.drag = null;
    window.removeEventListener('mousemove', this.onDragMove);
    window.removeEventListener('mouseup', this.onDragEnd);
  }

  protected onWheel(event: WheelEvent): void {
    const current = this.current();
    const ts = this.timeAt(this.xOf(event));
    if (!current || ts === null || event.deltaY === 0) return;
    event.preventDefault();
    this.zoomBy(event.deltaY > 0 ? 1.25 : 0.8, ts);
  }

  private zoomBy(factor: number, center: number): void {
    const current = this.current();
    const full = this.fullAxis.get(this.session().id);
    if (!current || !full) return;
    this.setZoom(zoomRange({ from: current.from, to: current.to }, center, factor, full));
  }

  setZoom(range: TimeRange | null): void {
    const id = this.session().id;
    this.zooms.update((zooms) => {
      const next = new Map(zooms);
      if (range) next.set(id, range);
      else next.delete(id);
      return next;
    });
    this.cursor.set(null);
    this.keyAnchor = null;
  }

  protected zoomToWindow(): void {
    const w = this.window();
    if (!w) return;
    this.window.set(null);
    this.setZoom(w);
  }

  protected asFilter(): void {
    const w = this.window();
    if (!w) return;
    this.window.set(null);
    this.sessions.filterTimeWindow(
      this.session(),
      filterTimeText(w.from),
      filterTimeText(w.to, true),
    );
  }

  protected onFocus(): void {
    if (this.cursor() === null && this.bucketCount() > 0) {
      // Start at the band of the log, else in the middle.
      const current = this.current()!;
      const [first] = this.visibleLines();
      const band = visibleBand(current, first, first, this.width());
      this.cursor.set(
        band ? bucketAt(band.x, this.bucketCount(), this.width()) : this.bucketCount() >> 1,
      );
    }
    this.requestDraw();
  }

  /** Start time of a bucket. */
  private bucketTime(index: number): number {
    const current = this.current()!;
    return current.from + (index * (current.to - current.from)) / current.buckets.length;
  }

  protected onKey(event: KeyboardEvent): void {
    const n = this.bucketCount();
    const current = this.current();
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'z' || event.key === 'Z') {
      event.preventDefault();
      this.settings.update({ showTimeline: !this.settings.settings().showTimeline });
      return;
    }
    if (!current || n === 0) return;
    const cursor = this.cursor() ?? n >> 1;
    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
        next = cursor - 1;
        break;
      case 'ArrowRight':
        next = cursor + 1;
        break;
      case 'PageUp':
        next = cursor - 10;
        break;
      case 'PageDown':
        next = cursor + 10;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = n - 1;
        break;
      case 'Enter':
        event.preventDefault();
        void this.sessions.jumpToTime(this.session(), this.bucketTime(cursor));
        return;
      case '+':
      case '=':
        event.preventDefault();
        this.zoomBy(0.5, this.bucketTime(cursor));
        return;
      case '-':
        event.preventDefault();
        this.zoomBy(2, this.bucketTime(cursor));
        return;
      case 'Escape':
        if (this.window()) {
          event.preventDefault();
          this.window.set(null);
        }
        return;
      default:
        return;
    }
    event.preventDefault();
    const clamped = Math.min(n - 1, Math.max(0, next));
    if (event.shiftKey) {
      // Shift: a window over the buckets from where Shift started to the cursor.
      const anchor = (this.keyAnchor ??= cursor);
      const low = Math.min(anchor, clamped);
      const high = Math.max(anchor, clamped);
      this.window.set(windowOf(this.bucketTime(low), this.bucketTime(high + 1)));
    } else {
      this.keyAnchor = null;
    }
    this.cursor.set(clamped);
  }
}
