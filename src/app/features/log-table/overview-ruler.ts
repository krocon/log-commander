import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { LogApi } from '../../core/log/log-api';
import { Overview } from '../../core/log/log.models';
import { LogSessionService } from '../sessions/log-session.service';
import { SessionState } from '../sessions/session-state';
import {
  RULER_LEVELS,
  RulerLevel,
  RulerMark,
  RulerPin,
  RulerRect,
  band,
  clickTarget,
  pinY,
  rulerMarks,
  rulerRects,
  rulerTooltip,
} from './ruler-logic';

/** At most this often the overview is asked for (prompt 007: twice a second). */
const LOAD_INTERVAL_MS = 500;
const MAX_BUCKETS = 8192;
const MAX_LINES = 10_000;

interface RulerColors {
  bg: string;
  band: string;
  bandEdge: string;
  levels: Record<RulerLevel, string>;
  bookmark: string;
  note: string;
  selection: string;
}

/** An answer of the backend for one tab. */
interface Loaded extends Overview {
  sessionId: number;
}

/**
 * Overview ruler right of the log (prompt 007): where errors, warnings, bookmarks and the selection lie in
 * the current view, and the visible band. FATAL and ERROR share the left lane, WARN has the right one; the
 * length of a bar tells how dense its level is there (a single line still gets a short bar). One canvas,
 * drawn in an animation frame when something changed; the data comes from `get_overview` (a running summary
 * in the backend). A click jumps there, the selection
 * stays. The ruler itself is hidden from assistive technology: `E`, `W`, `N` and `G` do the same by keyboard.
 */
@Component({
  selector: 'app-overview-ruler',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'ruler',
    '[attr.data-count]': 'loaded()?.count ?? -1',
    '[attr.data-generation]': 'loaded()?.viewGeneration ?? -1',
    '[attr.data-marks]': 'marksAttr()',
    '[attr.data-pins]': 'pinsAttr()',
  },
  template: `
    <div
      #track
      class="track"
      aria-hidden="true"
      [title]="tooltip()"
      (click)="onClick($event)"
      (mousemove)="onHover($event)"
    >
      <canvas #canvas></canvas>
    </div>
    <button
      type="button"
      class="to-end"
      aria-label="Ans Ende"
      title="Ans Ende springen und neuen Zeilen folgen (End, F)"
      [attr.aria-pressed]="session().follow()"
      (click)="toEnd()"
    >
      ▼
    </button>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      width: 14px;
      flex: none;
      background: var(--ruler-bg);
      border-left: 1px solid var(--border);
    }
    .track {
      flex: 1 1 0;
      min-height: 0;
      position: relative;
      cursor: pointer;
    }
    canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
    }
    .to-end {
      flex: none;
      height: 18px;
      padding: 0;
      border: 0;
      border-top: 1px solid var(--border);
      border-radius: 0;
      background: var(--ruler-bg);
      color: var(--text-dim);
      font-size: 9px;
      line-height: 18px;
    }
    .to-end:hover {
      background: var(--bg-hover);
      color: var(--text);
    }
    .to-end[aria-pressed='true'] {
      color: var(--accent);
    }
  `,
})
export class OverviewRulerComponent implements OnInit, OnDestroy {
  readonly session = input.required<SessionState>();

  private readonly api = inject(LogApi);
  private readonly sessions = inject(LogSessionService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly track = viewChild.required<ElementRef<HTMLElement>>('track');
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  /** Height of the track in CSS pixels: one bucket per pixel. */
  private readonly height = signal(0);
  protected readonly loaded = signal<Loaded | null>(null);
  /** Bumped when the theme or the level colours change: the canvas reads them again. */
  private readonly colorRevision = signal(0);
  protected readonly tooltip = signal('');

  /** The answer for the tab shown, if it still is its view. */
  private readonly current = computed(() => {
    const loaded = this.loaded();
    const session = this.session();
    if (!loaded || loaded.sessionId !== session.id) return null;
    const update = session.update();
    if (loaded.epoch !== update.epoch || loaded.viewGeneration !== update.viewGeneration) {
      return null;
    }
    return loaded;
  });
  private readonly marks = computed(() => {
    const current = this.current();
    return current ? rulerMarks(current.density, this.height()) : [];
  });
  private readonly pins = computed<RulerPin[]>(() => {
    const current = this.current();
    if (!current) return [];
    const session = this.session();
    const bookmarks = session.bookmarks();
    const notes = session.notes();
    const anchor = session.selection()?.anchor;
    const pins: RulerPin[] = [];
    for (const mark of current.marks) {
      if (bookmarks.has(mark.line)) pins.push({ kind: 'bookmark', ...mark });
      if (notes.has(mark.line)) pins.push({ kind: 'note', ...mark });
      if (mark.line === anchor) pins.push({ kind: 'selection', ...mark });
    }
    return pins;
  });
  protected readonly marksAttr = computed(() =>
    this.marks()
      // `LEVEL:y:percent`, y the middle of the mark, percent its highest density.
      .map(
        (m) =>
          `${m.level}:${Math.round(m.y + m.h / 2)}:${Math.round(Math.max(...m.density) * 100)}`,
      )
      .join(','),
  );
  protected readonly pinsAttr = computed(() => {
    const current = this.current();
    if (!current) return '';
    return this.pins()
      .map((p) => `${p.kind}:${p.line}:${Math.round(pinY(p, current.count, this.height()))}`)
      .join(',');
  });

  /** What a load depends on; equal strings start no load (a frozen tab sends equal updates). */
  private readonly loadKey = computed(() => {
    const session = this.session();
    const { filteredLines, viewGeneration, epoch } = session.update();
    const anchor = session.selection()?.anchor ?? -1;
    return `${session.id}|${filteredLines}|${viewGeneration}|${epoch}|${anchor}|${[...session.bookmarks()].join(',')}|${[...session.notes().keys()].join(',')}|${this.height()}`;
  });

  private resizeObserver: ResizeObserver | null = null;
  private themeObserver: MutationObserver | null = null;
  private colors: RulerColors | null = null;
  private colorsFor = -1;
  private frame = 0;
  /** Bars of the last drawing, kept while marks and size stay (scrolling only moves the band). */
  private rects: { marks: RulerMark[]; width: number; height: number; rects: RulerRect[] } | null =
    null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastLoad = -Infinity;
  private request = 0;

  constructor() {
    effect(() => {
      this.loadKey();
      untracked(() => this.scheduleLoad());
    });
    effect(() => {
      // Everything the picture depends on.
      void [this.current(), this.marks(), this.pins(), this.colorRevision(), this.height()];
      const session = this.session();
      void [session.displayedLines(), session.scroll(), session.visibleRows()];
      untracked(() => this.requestDraw());
    });
  }

  ngOnInit(): void {
    const track = this.track().nativeElement;
    this.resizeObserver = new ResizeObserver(() => this.height.set(track.clientHeight));
    this.resizeObserver.observe(track);
    this.height.set(track.clientHeight);
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
    this.request++;
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
    const height = Math.min(MAX_BUCKETS, Math.max(0, Math.floor(this.height())));
    if (height === 0) return;
    this.lastLoad = performance.now();
    const session = this.session();
    const lines = new Set<number>();
    const anchor = session.selection()?.anchor;
    if (anchor !== undefined) lines.add(anchor);
    for (const line of [...session.bookmarks(), ...session.notes().keys()]) {
      if (lines.size >= MAX_LINES) break;
      lines.add(line);
    }
    const request = ++this.request;
    this.api
      .getOverview(session.sessionId, height, [...lines], session.viewId)
      .then((overview) => {
        // A newer request overtook this one; a foreign epoch or view is filtered by `current`.
        if (request !== this.request) return;
        this.loaded.set({ ...overview, sessionId: session.id });
      })
      .catch(() => {
        // No backend (browser) or a closed tab: the ruler stays empty.
      });
  }

  // ---------------------------------------------------------------- drawing

  private requestDraw(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private readColors(): RulerColors {
    const revision = this.colorRevision();
    if (this.colors && this.colorsFor === revision) return this.colors;
    const style = getComputedStyle(this.host.nativeElement);
    const token = (name: string) => style.getPropertyValue(`--${name}`).trim();
    this.colors = {
      bg: token('ruler-bg'),
      band: token('ruler-band'),
      bandEdge: token('ruler-band-edge'),
      levels: {
        FATAL: token('ruler-fatal'),
        ERROR: token('ruler-error'),
        WARN: token('ruler-warn'),
      },
      bookmark: token('ruler-bookmark'),
      note: token('note'),
      selection: token('ruler-selection'),
    };
    this.colorsFor = revision;
    return this.colors;
  }

  private draw(): void {
    const canvas = this.canvas().nativeElement;
    const width = canvas.clientWidth;
    const height = this.height();
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

    const session = this.session();
    // The band follows what the view draws, the marks the count of their answer.
    const visible = band(
      session.scroll().top,
      session.visibleRows(),
      session.displayedLines(),
      height,
    );
    if (visible) {
      ctx.fillStyle = colors.band;
      ctx.fillRect(0, visible.y, width, visible.h);
      ctx.fillStyle = colors.bandEdge;
      ctx.fillRect(0, visible.y, width, 1);
      ctx.fillRect(0, visible.y + visible.h - 1, width, 1);
    }

    const marks = this.marks();
    const buckets = (this.current()?.density.length ?? 0) / RULER_LEVELS.length;
    const cached = this.rects;
    const rects =
      cached && cached.marks === marks && cached.width === width && cached.height === height
        ? cached.rects
        : rulerRects(marks, buckets, height, width);
    this.rects = { marks, width, height, rects };
    for (const rect of rects) {
      ctx.fillStyle = colors.levels[rect.level];
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    }

    const current = this.current();
    if (!current) return;
    for (const pin of this.pins()) {
      const y = Math.round(pinY(pin, current.count, height));
      if (pin.kind === 'bookmark') {
        // A small flag: a pole across the ruler and a pennant on the right.
        ctx.fillStyle = colors.bookmark;
        ctx.strokeStyle = colors.bookmark;
        ctx.fillRect(0, y - 1, width, 2);
        ctx.beginPath();
        ctx.moveTo(width, y - 5);
        ctx.lineTo(width - 6, y - 2);
        ctx.lineTo(width, y + 1);
        ctx.closePath();
        if (pin.visible) ctx.fill();
        else ctx.stroke();
      } else if (pin.kind === 'note') {
        // A small diamond in the middle of the ruler.
        ctx.fillStyle = colors.note;
        ctx.strokeStyle = colors.note;
        const x = Math.round(width / 2);
        ctx.beginPath();
        ctx.moveTo(x, y - 4);
        ctx.lineTo(x + 4, y);
        ctx.lineTo(x, y + 4);
        ctx.lineTo(x - 4, y);
        ctx.closePath();
        if (pin.visible) ctx.fill();
        else ctx.stroke();
      } else {
        // A triangle from the left edge.
        ctx.fillStyle = colors.selection;
        ctx.strokeStyle = colors.selection;
        ctx.beginPath();
        ctx.moveTo(0, y - 4);
        ctx.lineTo(7, y);
        ctx.lineTo(0, y + 4);
        ctx.closePath();
        if (pin.visible) ctx.fill();
        else ctx.stroke();
      }
    }
  }

  // ---------------------------------------------------------------- input

  private view(): Parameters<typeof clickTarget>[1] | null {
    const current = this.current();
    if (!current) return null;
    return {
      marks: this.marks(),
      pins: this.pins(),
      count: current.count,
      height: this.height(),
      buckets: current.density.length / RULER_LEVELS.length,
    };
  }

  private yOf(event: MouseEvent): number {
    return event.clientY - this.track().nativeElement.getBoundingClientRect().top;
  }

  protected onHover(event: MouseEvent): void {
    const view = this.view();
    this.tooltip.set(view ? rulerTooltip(this.yOf(event), view) : '');
  }

  protected onClick(event: MouseEvent): void {
    const view = this.view();
    const session = this.session();
    if (!view || view.count === 0) return;
    const target = clickTarget(this.yOf(event), view);
    if (target.kind === 'position') session.jumpTo(target.position, null);
    else void this.sessions.jumpToRulerLevel(session, target.from, target.levels, target.fallback);
  }

  protected toEnd(): void {
    // The log view puts the scroll position at the bottom once it follows.
    this.session().setFollow(true);
  }
}
