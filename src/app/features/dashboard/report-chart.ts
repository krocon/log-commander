import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  ViewEncapsulation,
  computed,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type uPlot from 'uplot';
import {
  ChartData,
  PanelKind,
  Series,
  Slice,
  formatNumber,
  formatTime,
  pieSlices,
  seriesSums,
} from './report-logic';
import { UPlotCtor, chartErrorText, loadUPlot } from './chart-loader';

/** A point or bar the user picked: its index on the axis and the series under it, if one. */
export interface ChartPick {
  index: number;
  series: Series | null;
  /** For a pie: the slice. */
  slice: Slice | null;
}

const PALETTE = 8;

/** `#rrggbb` with an alpha for fills (canvas does not know every CSS colour function). */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color.trim());
  if (!m) return color;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Colours from the tokens in styles.css, read when drawing (the theme may have changed). */
function tokens(): {
  color: (s: Series | Slice, i: number) => string;
  grid: string;
  text: string;
  font: string;
} {
  const style = getComputedStyle(document.documentElement);
  const get = (name: string) => style.getPropertyValue(name).trim();
  return {
    color: (s, i) =>
      s.level ? get(`--chart-lv-${s.level.toLowerCase()}`) : get(`--chart-${(i % PALETTE) + 1}`),
    grid: get('--chart-grid'),
    text: get('--text-dim'),
    font: get('--font-ui') || 'sans-serif',
  };
}

/**
 * One chart of a dashboard panel (prompt 012): line, area, bars and stacked bars with uPlot on a canvas, a pie
 * drawn by hand. The legend shows the values under the cursor; ←/→ pick a point, Enter jumps to it. What is
 * drawn is also in data attributes (`data-points`, `data-series`, `data-sums`) for tests. `data-ready` is `1`
 * once the chart is drawn and `error` when it could not be drawn; the text then says why.
 */
@Component({
  selector: 'app-report-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  template: `
    <div
      #host
      class="rc"
      tabindex="0"
      role="application"
      [attr.aria-label]="ariaLabel()"
      aria-roledescription="Diagramm"
      [attr.data-kind]="kind()"
      [attr.data-points]="data().x.length"
      [attr.data-series]="seriesLabels()"
      [attr.data-sums]="sums()"
      [attr.data-ready]="error() ? 'error' : ready() ? '1' : null"
      (keydown)="onKey($event)"
    >
      @if (error(); as message) {
        <p class="rc-error" role="alert">{{ message }}</p>
      }
      @if (kind() === 'pie') {
        <div class="rc-pie">
          <canvas
            #pie
            class="rc-pie-canvas"
            aria-hidden="true"
            (click)="onPieClick($event)"
          ></canvas>
          <ul class="rc-legend" aria-label="Anteile">
            @for (slice of slices(); track slice.label; let i = $index) {
              <li>
                <button
                  type="button"
                  [class.current]="i === selected()"
                  [title]="slice.splitValue === null ? '' : 'Als Filter setzen'"
                  [disabled]="slice.splitValue === null"
                  (click)="pickSlice(i)"
                >
                  <span class="rc-swatch" [style.background]="sliceColor(slice, i)"></span>
                  <span class="rc-name">{{ slice.label }}</span>
                  <span class="rc-value">{{ fmt(slice.value) }} · {{ share(slice) }}</span>
                </button>
              </li>
            }
          </ul>
        </div>
      }
    </div>
  `,
  styles: `
    app-report-chart {
      display: block;
      min-height: 0;
    }
    .rc {
      position: relative;
      height: 100%;
      outline: none;
      border-radius: var(--radius);
    }
    .rc:focus-visible {
      box-shadow: 0 0 0 2px var(--accent);
    }
    .rc .uplot {
      font-family: var(--font-ui);
      color: var(--text);
    }
    .rc .u-legend {
      font-size: 12px;
      text-align: left;
      margin-top: 2px;
      color: var(--text);
    }
    .rc .u-legend .u-marker {
      border-radius: 2px;
    }
    .rc .u-legend th {
      font-weight: normal;
    }
    .rc .u-legend .u-value {
      font-variant-numeric: tabular-nums;
    }
    .rc .u-cursor-x,
    .rc .u-cursor-y {
      border-color: var(--text-dim);
    }
    .rc-error {
      margin: 0;
      padding: 8px;
      color: var(--text);
      font-size: 12px;
      user-select: text;
    }
    .rc-pie {
      display: flex;
      gap: 12px;
      height: 100%;
      align-items: center;
    }
    .rc-pie-canvas {
      flex: none;
      cursor: pointer;
    }
    .rc-legend {
      list-style: none;
      margin: 0;
      padding: 0;
      font-size: 12px;
      overflow: auto;
      max-height: 100%;
    }
    .rc-legend button {
      display: flex;
      gap: 6px;
      align-items: center;
      width: 100%;
      background: none;
      border: 1px solid transparent;
      color: var(--text);
      padding: 2px 4px;
      text-align: left;
    }
    .rc-legend button.current {
      border-color: var(--accent);
    }
    .rc-legend button:disabled {
      cursor: default;
      opacity: 1;
    }
    .rc-swatch {
      flex: none;
      width: 10px;
      height: 10px;
      border-radius: 2px;
    }
    .rc-value {
      color: var(--text-dim);
      font-variant-numeric: tabular-nums;
      margin-left: auto;
      padding-left: 8px;
    }
  `,
})
export class ReportChartComponent implements OnDestroy {
  readonly data = input.required<ChartData>();
  readonly kind = input.required<PanelKind>();
  readonly pick = output<ChartPick>();

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private readonly pieCanvas = viewChild<ElementRef<HTMLCanvasElement>>('pie');
  protected readonly ready = signal(false);
  /** Why the chart could not be drawn, else empty. */
  protected readonly error = signal('');
  /** Point (or slice) chosen with the keyboard. */
  protected readonly selected = signal(-1);
  protected readonly slices = computed(() => (this.kind() === 'pie' ? pieSlices(this.data()) : []));
  protected readonly seriesLabels = computed(() =>
    JSON.stringify(this.data().series.map((s) => s.label)),
  );
  protected readonly sums = computed(() => JSON.stringify(seriesSums(this.data())));
  protected readonly ariaLabel = computed(() => {
    const d = this.data();
    const names = d.series.map((s) => s.label).join(', ');
    return `${d.series.length} Reihen (${names}), ${d.x.length} Punkte. Pfeiltasten wählen einen Punkt, Enter springt ins Log.`;
  });

  private plot: uPlot | null = null;
  private focusedSeries: number | null = null;
  private resize: ResizeObserver | null = null;
  private theme: MutationObserver | null = null;
  private drawToken = 0;

  constructor() {
    effect(() => {
      const data = this.data();
      const kind = this.kind();
      this.selected.set(-1);
      void this.draw(data, kind);
    });
  }

  ngOnDestroy(): void {
    this.drawToken++;
    this.plot?.destroy();
    this.resize?.disconnect();
    this.theme?.disconnect();
  }

  protected fmt(value: number): string {
    return formatNumber(value);
  }

  protected share(slice: Slice): string {
    const total = this.slices().reduce((sum, s) => sum + s.value, 0);
    return total > 0 ? `${Math.round((slice.value / total) * 1000) / 10} %` : '';
  }

  protected sliceColor(slice: Slice, i: number): string {
    return tokens().color(slice, i);
  }

  private observe(): void {
    const element = this.host().nativeElement;
    if (!this.resize) {
      this.resize = new ResizeObserver(() => this.fit());
      this.resize.observe(element);
    }
    if (!this.theme) {
      // Theme or level colours changed: draw again with the new tokens.
      this.theme = new MutationObserver(() => void this.draw(this.data(), this.kind()));
      this.theme.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'style'],
      });
    }
  }

  private size(): { width: number; height: number } {
    const element = this.host().nativeElement;
    return {
      width: Math.max(120, element.clientWidth),
      height: Math.max(80, element.clientHeight),
    };
  }

  private fit(): void {
    if (this.kind() === 'pie') {
      this.drawPie();
      return;
    }
    if (!this.plot) return;
    const { width, height } = this.size();
    this.plot.setSize({ width, height: Math.max(60, height - this.legendHeight()) });
  }

  private legendHeight(): number {
    const legend = this.host().nativeElement.querySelector('.u-legend') as HTMLElement | null;
    const height = (legend?.offsetHeight ?? 24) + 4;
    // Never more than half of the chart, whatever the layout says in between.
    return Math.min(height, this.host().nativeElement.clientHeight / 2);
  }

  private async draw(data: ChartData, kind: PanelKind): Promise<void> {
    const token = ++this.drawToken;
    this.ready.set(false);
    this.error.set('');
    try {
      this.plot?.destroy();
      this.plot = null;
      this.observe();
      if (kind === 'pie') {
        // The canvas comes with the next change detection.
        queueMicrotask(() => {
          if (token !== this.drawToken) return;
          try {
            this.drawPie();
            this.ready.set(true);
          } catch (error) {
            this.failed(error);
          }
        });
        return;
      }
      const UPlot = await loadUPlot();
      if (token !== this.drawToken) return;
      this.drawPlot(UPlot, data, kind);
      this.ready.set(true);
    } catch (error) {
      // Without this the panel would stay empty for good and nobody would learn why.
      if (token === this.drawToken) this.failed(error);
    }
  }

  private failed(error: unknown): void {
    console.error(error);
    this.plot = null;
    this.host()
      .nativeElement.querySelectorAll('.uplot')
      .forEach((n) => n.remove());
    this.error.set(chartErrorText(error));
  }

  private drawPlot(UPlot: UPlotCtor, data: ChartData, kind: PanelKind): void {
    const element = this.host().nativeElement;
    const t = tokens();
    const time = data.axis === 'time';
    const stacked = kind === 'stacked';
    const bars = kind === 'bars' || stacked;
    const n = data.series.length;
    const step = time ? (data.step ?? 60_000) : 1;
    const group = step * 0.8;

    // Stacked: bottoms and tops per series; the legend keeps the own values.
    const tops: number[][] = [];
    const bottoms: number[][] = [];
    if (stacked) {
      const running = data.x.map(() => 0);
      for (const s of data.series) {
        bottoms.push([...running]);
        s.values.forEach((v, i) => (running[i] += v ?? 0));
        tops.push([...running]);
      }
    }
    const maxTop = stacked ? Math.max(1, ...tops[tops.length - 1]) : null;

    const series: uPlot.Series[] = [
      {
        label: time ? 'Zeit' : data.axisColumn,
        value: (_u, v) =>
          v === null || v === undefined ? '–' : time ? formatTime(v) : (data.categories[v] ?? ''),
      },
      ...data.series.map((s, k): uPlot.Series => {
        const color = t.color(s, k);
        const base: uPlot.Series = {
          label: s.label,
          stroke: color,
          width: bars ? 0 : 1.5,
          value: (_u, v) => (v === null || v === undefined ? '–' : formatNumber(v)),
          points: { show: !bars && data.x.length <= 120, size: 5, fill: color },
          spanGaps: false,
        };
        if (kind === 'area') base.fill = withAlpha(color, 0.25);
        if (bars) {
          base.fill = color;
          base.points = { show: false };
          const disp: Record<string, unknown> = stacked
            ? {
                y0: { unit: 1, values: () => bottoms[k] },
                y1: { unit: 1, values: () => tops[k] },
              }
            : {
                x0: {
                  unit: 1,
                  values: () => data.x.map((x) => x - group / 2 + (k * group) / n),
                },
                size: { unit: 1, values: () => [group / n] },
              };
          base.paths = UPlot.paths.bars!({ size: [stacked ? 0.8 : 1, 60], align: 1, disp });
        }
        return base;
      }),
    ];
    const axisStyle = {
      stroke: t.text,
      grid: { stroke: t.grid, width: 1 },
      ticks: { stroke: t.grid, width: 1 },
      font: `11px ${t.font}`,
    };
    const { width, height } = this.size();
    const options: uPlot.Options = {
      width,
      height: Math.max(60, height - 28),
      ms: 1,
      legend: { show: true, live: true },
      cursor: {
        focus: { prox: 24 },
        points: { size: 7 },
        drag: { x: false, y: false, setScale: false },
      },
      focus: { alpha: 0.4 },
      scales: {
        x: time
          ? {
              time: true,
              range: (_u, min, max) =>
                bars ? [min - step / 2, max + step / 2] : [min, max === min ? min + step : max],
            }
          : { time: false, range: () => [-0.5, Math.max(0.5, data.x.length - 0.5)] },
        y: {
          range: (_u, min, max) => [
            Math.min(0, min ?? 0),
            stacked ? (maxTop as number) * 1.05 : Math.max(1, (max ?? 1) * 1.05),
          ],
        },
      },
      axes: [
        time
          ? { ...axisStyle }
          : {
              ...axisStyle,
              splits: () => data.x,
              values: (_u, splits) => splits.map((i) => data.categories[i] ?? ''),
            },
        { ...axisStyle, size: 56, values: (_u, splits) => splits.map((v) => formatNumber(v)) },
      ],
      series,
      hooks: {
        setSeries: [(_u, i) => (this.focusedSeries = i)],
      },
    };
    const aligned = [data.x, ...data.series.map((s) => s.values)] as uPlot.AlignedData;
    element.querySelectorAll('.uplot').forEach((n) => n.remove());
    this.plot = new UPlot(options, aligned, element);
    this.plot.over.addEventListener('click', this.onPlotClick);
    // The legend wraps only once the plot has its width: fit again whenever it changes height.
    const legend = element.querySelector('.u-legend');
    if (legend) this.resize?.observe(legend);
    this.fit();
  }

  /** Series under the cursor: the focused one for lines, the segment for stacked bars, the slot for grouped bars. */
  private seriesAt(index: number): Series | null {
    const plot = this.plot;
    const data = this.data();
    if (!plot || data.series.length === 0) return null;
    if (data.series.length === 1) return data.series[0];
    const kind = this.kind();
    const top = plot.cursor.top ?? -1;
    const left = plot.cursor.left ?? -1;
    if (kind === 'stacked' && top >= 0) {
      const value = plot.posToVal(top, 'y');
      let running = 0;
      for (const s of data.series) {
        running += s.values[index] ?? 0;
        if (value <= running) return s;
      }
      return null;
    }
    if (kind === 'bars' && left >= 0) {
      const step = data.axis === 'time' ? (data.step ?? 60_000) : 1;
      const group = step * 0.8;
      const offset = plot.posToVal(left, 'x') - (data.x[index] - group / 2);
      const k = Math.floor((offset / group) * data.series.length);
      return data.series[k] ?? null;
    }
    const focused = this.focusedSeries;
    return focused !== null && focused > 0 ? (data.series[focused - 1] ?? null) : null;
  }

  private readonly onPlotClick = (): void => {
    const index = this.plot?.cursor.idx;
    if (index === null || index === undefined) return;
    this.pick.emit({ index, series: this.seriesAt(index), slice: null });
  };

  protected onKey(event: KeyboardEvent): void {
    const kind = this.kind();
    const count = kind === 'pie' ? this.slices().length : this.data().x.length;
    if (count === 0) return;
    let next = this.selected();
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = Math.min(count - 1, next + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = Math.max(0, next < 0 ? count - 1 : next - 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = count - 1;
        break;
      case 'Enter':
      case ' ':
        if (next < 0) return;
        event.preventDefault();
        if (kind === 'pie') this.pickSlice(next);
        else this.pick.emit({ index: next, series: this.keyboardSeries(next), slice: null });
        return;
      default:
        return;
    }
    event.preventDefault();
    this.selected.set(next);
    if (kind === 'pie') {
      this.drawPie();
      return;
    }
    const plot = this.plot;
    if (!plot) return;
    const data = this.data();
    const value = data.series[0]?.values[next] ?? 0;
    plot.setCursor({ left: plot.valToPos(data.x[next], 'x'), top: plot.valToPos(value, 'y') });
  }

  /** With the keyboard there is no position in a stack: one series, or none (the whole range). */
  private keyboardSeries(index: number): Series | null {
    const series = this.data().series.filter((s) => (s.values[index] ?? 0) !== 0);
    return series.length === 1
      ? series[0]
      : this.data().series.length === 1
        ? this.data().series[0]
        : null;
  }

  protected pickSlice(i: number): void {
    const slice = this.slices()[i];
    if (!slice || slice.splitValue === null) return;
    this.pick.emit({ index: i, series: null, slice });
  }

  private pieGeometry(): { size: number; canvas: HTMLCanvasElement } | null {
    const canvas = this.pieCanvas()?.nativeElement;
    if (!canvas) return null;
    const { height, width } = this.size();
    const size = Math.max(60, Math.min(height - 8, width * 0.5));
    return { size, canvas };
  }

  private drawPie(): void {
    const geometry = this.pieGeometry();
    if (!geometry) return;
    const { size, canvas } = geometry;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = size * ratio;
    canvas.height = size * ratio;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    const t = tokens();
    const slices = this.slices();
    const total = slices.reduce((sum, s) => sum + s.value, 0);
    const r = size / 2 - 2;
    let angle = -Math.PI / 2;
    slices.forEach((slice, i) => {
      const sweep = total > 0 ? (slice.value / total) * Math.PI * 2 : 0;
      ctx.beginPath();
      ctx.moveTo(size / 2, size / 2);
      ctx.arc(size / 2, size / 2, i === this.selected() ? r : r - 3, angle, angle + sweep);
      ctx.closePath();
      ctx.fillStyle = t.color(slice, i);
      ctx.fill();
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-panel');
      ctx.lineWidth = 1.5;
      ctx.stroke();
      angle += sweep;
    });
  }

  protected onPieClick(event: MouseEvent): void {
    const geometry = this.pieGeometry();
    if (!geometry) return;
    const box = geometry.canvas.getBoundingClientRect();
    const dx = event.clientX - box.left - box.width / 2;
    const dy = event.clientY - box.top - box.height / 2;
    let angle = Math.atan2(dy, dx) + Math.PI / 2;
    if (angle < 0) angle += Math.PI * 2;
    const slices = this.slices();
    const total = slices.reduce((sum, s) => sum + s.value, 0);
    let start = 0;
    for (let i = 0; i < slices.length; i++) {
      const sweep = (slices[i].value / total) * Math.PI * 2;
      if (angle >= start && angle < start + sweep) {
        this.pickSlice(i);
        return;
      }
      start += sweep;
    }
  }
}
