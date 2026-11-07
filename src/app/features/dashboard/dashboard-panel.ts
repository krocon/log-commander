import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { toAppError } from '../../core/errors/app-error';
import { LogApi } from '../../core/log/log-api';
import { ReportResult } from '../../core/log/log.models';
import { HEIGHTS, PANEL_KINDS, PanelDef, resized } from './dashboard-model';
import { ChartPick, ReportChartComponent } from './report-chart';
import {
  ChartData,
  MAX_POINTS,
  PanelKind,
  describeQueryError,
  effectiveKind,
  formatCell,
  formatNumber,
  intervalOf,
  lineOfRow,
  singleValue,
  suggestInterval,
  toChartData,
  withInterval,
} from './report-logic';

/** A pick in a panel, handed to the dashboard: a point/bar/slice of a chart, or a table row with `line`. */
export interface PanelPick {
  panel: PanelDef;
  data: ChartData;
  pick: ChartPick | null;
  /** A table row: its line (1-based). */
  line: number | null;
}

/** Rows a table panel shows; the rest stays in the result. */
const TABLE_ROWS = 500;

/**
 * One panel of a dashboard (prompt 012): title, SQL, chart type, size; runs its query (slot = panel id, so a
 * newer run stops an older one) and draws the result. A run in flight is not overtaken by the live refresh.
 */
@Component({
  selector: 'app-dashboard-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReportChartComponent],
  host: {
    '[style.grid-column]': '"span " + panel().width',
    '[attr.data-panel]': 'panel().id',
    '[attr.aria-busy]': 'running()',
  },
  template: `
    @let p = panel();
    <section class="panel" [attr.aria-label]="p.title">
      <header>
        <h3 [title]="p.title">{{ p.title }}</h3>
        <span class="meta">
          @if (running()) {
            <span class="busy">läuft …</span>
          } @else if (result(); as r) {
            {{ r.rows.length }} Zeilen · {{ fmt(r.elapsedMs) }} ms
          }
        </span>
        <span class="tools">
          <button
            type="button"
            class="edit"
            [attr.aria-expanded]="editing()"
            [attr.aria-controls]="'editor-' + p.id"
            title="SQL, Titel und Diagrammart bearbeiten"
            (click)="editing.set(!editing())"
          >
            ✎ SQL
          </button>
          <button type="button" title="Neu ausführen" aria-label="Neu ausführen" (click)="run()">
            ↻
          </button>
          <button
            type="button"
            aria-label="Schmaler"
            title="Schmaler"
            [disabled]="p.width === 1"
            (click)="size('narrower')"
          >
            ⇤
          </button>
          <button
            type="button"
            aria-label="Breiter"
            title="Breiter"
            [disabled]="p.width === 4"
            (click)="size('wider')"
          >
            ⇥
          </button>
          <button
            type="button"
            aria-label="Niedriger"
            title="Niedriger"
            [disabled]="p.height === 's'"
            (click)="size('lower')"
          >
            ⤒
          </button>
          <button
            type="button"
            aria-label="Höher"
            title="Höher"
            [disabled]="p.height === 'l'"
            (click)="size('taller')"
          >
            ⤓
          </button>
          <button type="button" aria-label="Nach vorn" title="Nach vorn" (click)="move.emit(-1)">
            ↑
          </button>
          <button type="button" aria-label="Nach hinten" title="Nach hinten" (click)="move.emit(1)">
            ↓
          </button>
          <button
            type="button"
            class="remove"
            aria-label="Panel entfernen"
            title="Panel entfernen"
            (click)="remove.emit()"
          >
            ×
          </button>
        </span>
      </header>
      @if (editing()) {
        <form class="editor" [id]="'editor-' + p.id" (submit)="$event.preventDefault(); apply()">
          <div class="row">
            <label>
              Titel
              <input
                type="text"
                name="title"
                [value]="p.title"
                maxlength="120"
                (change)="setTitle($event)"
              />
            </label>
            <label>
              Diagramm
              <select name="kind" (change)="setKind($event)">
                @for (k of kinds; track k.kind) {
                  <option [value]="k.kind" [selected]="k.kind === p.kind">{{ k.label }}</option>
                }
              </select>
            </label>
          </div>
          <label class="sql">
            SQL (SQLite) – Ausführen mit ⌘/Strg+Enter
            <textarea
              name="sql"
              rows="6"
              spellcheck="false"
              [value]="draft()"
              (input)="draft.set($any($event.target).value)"
              (keydown)="onEditorKey($event)"
            ></textarea>
          </label>
          <div class="row">
            <button type="submit" class="primary">Ausführen</button>
          </div>
        </form>
      }
      @if (error(); as e) {
        <p class="error" role="alert">{{ e }}</p>
      }
      @if (notes().length) {
        <p class="note" role="status">
          @for (note of notes(); track note) {
            <span>{{ note }}</span>
          }
          @if (suggestion(); as spec) {
            <button type="button" (click)="useInterval(spec)">
              Mit bucket(ts, '{{ spec }}') ausführen
            </button>
          }
        </p>
      }
      <div class="body" [style.height.px]="bodyHeight()">
        @if (result(); as r) {
          @switch (shown()) {
            @case ('table') {
              <div class="table-wrap">
                <table class="rt">
                  <thead>
                    <tr>
                      @for (c of r.columns; track $index) {
                        <th scope="col">{{ c }}</th>
                      }
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of tableRows(); track $index; let i = $index) {
                      @let line = lineOf(i);
                      <tr
                        [class.link]="line !== null"
                        [attr.tabindex]="line !== null ? 0 : null"
                        [attr.title]="line !== null ? 'Zeile ' + line + ' im Log zeigen' : null"
                        (click)="line !== null && openLine(line)"
                        (keydown.enter)="line !== null && openLine(line)"
                      >
                        @for (cell of row; track $index; let c = $index) {
                          <td [class.num]="isNumber(cell)">{{ cell_(r.columns[c], cell) }}</td>
                        }
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
            @case ('value') {
              <div class="value" [attr.data-value]="value()">
                <span class="big">{{ valueText() }}</span>
                <span class="label">{{ r.columns[0] }}</span>
              </div>
            }
            @default {
              @if (chart().message; as message) {
                <p class="empty">{{ message }}</p>
              } @else {
                <app-report-chart [data]="chart()" [kind]="shown()" (pick)="onPick($event)" />
              }
            }
          }
        } @else if (!error()) {
          <p class="empty">{{ running() ? 'Abfrage läuft …' : 'Noch nicht ausgeführt' }}</p>
        }
      </div>
    </section>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .panel {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 8px 10px;
      background: var(--bg-panel);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      height: 100%;
    }
    header {
      display: flex;
      align-items: center;
      gap: 4px 8px;
      min-width: 0;
      flex-wrap: wrap;
    }
    h3 {
      flex: 1 1 8em;
      min-width: 0;
      margin: 0;
      font-size: 13px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .meta {
      color: var(--text-dim);
      font-size: 11px;
      white-space: nowrap;
    }
    .tools {
      margin-left: auto;
      display: flex;
      gap: 2px;
      flex: none;
    }
    .tools button {
      padding: 1px 6px;
      min-width: 24px;
    }
    .editor {
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 12px;
    }
    .editor .row {
      display: flex;
      gap: 10px;
      align-items: end;
      flex-wrap: wrap;
    }
    .editor label {
      display: flex;
      flex-direction: column;
      gap: 2px;
      color: var(--text-dim);
    }
    textarea {
      font-family: var(--font-mono);
      font-size: 12px;
      width: 100%;
      resize: vertical;
      background: var(--bg-app);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 6px;
    }
    .error {
      margin: 0;
      color: var(--danger);
      font-size: 12px;
      white-space: pre-wrap;
    }
    .note {
      margin: 0;
      font-size: 12px;
      color: var(--text-dim);
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .body {
      min-height: 0;
      overflow: hidden;
    }
    .body > app-report-chart {
      height: 100%;
    }
    .empty {
      color: var(--text-dim);
      font-size: 12px;
      margin: 8px 0;
    }
    .table-wrap {
      height: 100%;
      overflow: auto;
    }
    .rt {
      border-collapse: collapse;
      font-size: 12px;
      width: 100%;
    }
    .rt th {
      position: sticky;
      top: 0;
      background: var(--bg-raised);
      text-align: left;
      font-weight: 600;
      padding: 2px 6px;
    }
    .rt td {
      padding: 1px 6px;
      border-top: 1px solid var(--border);
      white-space: nowrap;
      max-width: 40ch;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .rt td.num {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .rt tr.link {
      cursor: pointer;
    }
    .rt tr.link:hover,
    .rt tr.link:focus-visible {
      background: var(--bg-hover);
      outline: none;
    }
    .value {
      height: 100%;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
    }
    .value .big {
      font-size: 36px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .value .label {
      color: var(--text-dim);
      font-size: 12px;
    }
  `,
})
export class DashboardPanelComponent implements OnInit {
  private readonly api = inject(LogApi);

  readonly panel = input.required<PanelDef>();
  readonly sessionId = input.required<number>();
  /** Goes up for each live refresh; a panel in flight skips it. */
  readonly refresh = input(0);
  readonly changed = output<PanelDef>();
  readonly remove = output<void>();
  readonly move = output<-1 | 1>();
  readonly picked = output<PanelPick>();

  protected readonly kinds = PANEL_KINDS;
  protected readonly editing = signal(false);
  protected readonly draft = signal('');
  protected readonly running = signal(false);
  protected readonly result = signal<ReportResult | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly chart = computed(() => {
    const r = this.result();
    return r
      ? toChartData(r, intervalOf(this.panel().sql))
      : toChartData({ columns: [], rows: [], truncated: false, elapsedMs: 0 });
  });
  protected readonly shown = computed<PanelKind>(() =>
    effectiveKind(this.panel().kind, this.chart()),
  );
  protected readonly bodyHeight = computed(() => HEIGHTS[this.panel().height]);
  protected readonly tableRows = computed(() => (this.result()?.rows ?? []).slice(0, TABLE_ROWS));
  protected readonly value = computed(() => {
    const r = this.result();
    return r ? singleValue(r) : null;
  });
  protected readonly valueText = computed(() => {
    const v = this.value();
    return v === null ? '–' : typeof v === 'number' ? formatNumber(v) : v;
  });
  protected readonly suggestion = computed(() =>
    this.shown() === 'table' || this.shown() === 'value' ? null : suggestInterval(this.chart()),
  );
  protected readonly notes = computed(() => {
    const notes: string[] = [];
    const r = this.result();
    const d = this.chart();
    if (r?.truncated) notes.push('Nur die ersten 10 000 Zeilen (oder 32 MB) des Ergebnisses.');
    if (this.shown() === 'table' && (r?.rows.length ?? 0) > TABLE_ROWS) {
      notes.push(`Tabelle zeigt die ersten ${TABLE_ROWS} Zeilen.`);
    }
    if (d.skipped > 0) notes.push(`${d.skipped} Zeilen ohne Zeit ausgelassen.`);
    if (d.droppedSeries > 0) notes.push(`${d.droppedSeries} weitere Reihen nicht gezeigt.`);
    if (this.panel().kind !== this.shown() && this.shown() === 'bars') {
      notes.push('Ohne Zeitachse als Säulen.');
    }
    if (this.suggestion()) notes.push(`Mehr als ${formatNumber(MAX_POINTS)} Punkte je Reihe.`);
    return notes;
  });

  private lastSql = '';
  private lastRefresh = 0;
  private refreshWaiting = false;

  constructor() {
    // A live refresh does not overtake a run in flight: it waits and runs once that is done.
    effect(() => {
      const tick = this.refresh();
      if (tick === this.lastRefresh) return;
      this.lastRefresh = tick;
      untracked(() => {
        if (this.running()) this.refreshWaiting = true;
        else void this.run();
      });
    });
  }

  ngOnInit(): void {
    this.draft.set(this.panel().sql);
    this.lastRefresh = this.refresh();
    void this.run();
  }

  /** Runs the panel's SQL; a newer run of this panel stops the older one in the backend. */
  async run(sql = this.panel().sql): Promise<void> {
    this.lastSql = sql;
    this.running.set(true);
    try {
      const result = await this.api.runReport(this.sessionId(), sql, this.panel().id);
      if (sql !== this.lastSql) return;
      this.result.set(result);
      this.error.set(null);
    } catch (e) {
      if (sql !== this.lastSql) return;
      const err = toAppError(e);
      if (err.message.includes('cancelled by a newer query')) return;
      this.error.set(describeQueryError(err.message));
      this.result.set(null);
    } finally {
      if (sql === this.lastSql) {
        this.running.set(false);
        if (this.refreshWaiting) {
          this.refreshWaiting = false;
          void this.run();
        }
      }
    }
  }

  protected apply(): void {
    const sql = this.draft();
    if (sql !== this.panel().sql) this.changed.emit({ ...this.panel(), sql });
    void this.run(sql);
  }

  protected onEditorKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      this.apply();
    }
  }

  protected setTitle(event: Event): void {
    const title = (event.target as HTMLInputElement).value.trim().slice(0, 120) || 'Panel';
    this.changed.emit({ ...this.panel(), title });
  }

  protected setKind(event: Event): void {
    const kind = (event.target as HTMLSelectElement).value as PanelKind;
    this.changed.emit({ ...this.panel(), kind });
  }

  protected size(change: 'wider' | 'narrower' | 'taller' | 'lower'): void {
    this.changed.emit(resized(this.panel(), change));
  }

  protected useInterval(spec: string): void {
    const sql = withInterval(this.panel().sql, spec);
    this.draft.set(sql);
    this.changed.emit({ ...this.panel(), sql });
    void this.run(sql);
  }

  protected onPick(pick: ChartPick): void {
    this.picked.emit({ panel: this.panel(), data: this.chart(), pick, line: null });
  }

  protected lineOf(row: number): number | null {
    const r = this.result();
    return r ? lineOfRow(r, row) : null;
  }

  protected openLine(line: number): void {
    this.picked.emit({ panel: this.panel(), data: this.chart(), pick: null, line });
  }

  protected isNumber(value: unknown): boolean {
    return typeof value === 'number';
  }

  protected cell_(column: string, value: string | number | null): string {
    return formatCell(column, value);
  }

  protected fmt(value: number): string {
    return formatNumber(Math.round(value));
  }
}
