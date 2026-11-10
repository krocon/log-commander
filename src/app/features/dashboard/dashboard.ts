import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { toAppError } from '../../core/errors/app-error';
import { LogApi } from '../../core/log/log-api';
import { ReportSchema } from '../../core/log/log.models';
import { ActionService } from '../../core/actions/action.service';
import { formatBytes, formatCount } from '../../shared/format';
import { LogSessionService } from '../sessions/log-session.service';
import { SessionState } from '../sessions/session-state';
import {
  DashboardDef,
  PanelDef,
  baseUnit,
  defaultDashboard,
  emptyPanel,
  fromTemplate,
  MAX_PANELS,
  moved,
  templates,
  toggleField,
} from './dashboard-model';
import { DashboardPanelComponent, PanelPick } from './dashboard-panel';
import { DashboardStore } from './dashboard-store';
import { describeQueryError, firstLineQuery, rangeAt } from './report-logic';

/** Live refresh at most this often (prompt 012). */
export const REFRESH_MS = 5000;

const REASONS: Record<string, string> = {
  epoch: 'die Datei begann neu (geleert, rotiert oder neu sortiert)',
  columns: 'Profil oder Felder des Formats haben sich geändert',
  fields: 'andere Felder wurden gewählt',
};

/**
 * The dashboard of a tab (prompt 012): panels with SQL over the table `log` of the session, built in the
 * backend on first open. Shown over the log, which keeps running below. Loaded lazily (`@defer`).
 */
@Component({
  selector: 'app-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DashboardPanelComponent],
  template: `
    <div class="bar" role="toolbar" aria-label="Dashboard">
      <h2>Dashboard</h2>
      <span class="status" role="status" [attr.data-state]="status()?.state ?? 'none'">
        {{ statusText() }}
      </span>
      <span class="spacer"></span>
      <label class="templates">
        <span class="visually-hidden">Vorlage hinzufügen</span>
        <select aria-label="Vorlage hinzufügen" (change)="addTemplate($event)" [disabled]="full()">
          <option value="" selected>+ Vorlage …</option>
          @for (t of templateList(); track t.id) {
            <option [value]="t.id">{{ t.title }}</option>
          }
        </select>
      </label>
      <button type="button" class="add" [disabled]="full()" (click)="addPanel()">+ Panel</button>
      <button
        type="button"
        class="auto"
        [attr.aria-pressed]="dashboard()?.auto ?? false"
        title="Alle 5 s aktualisieren, solange das Dashboard sichtbar ist"
        (click)="toggleAuto()"
      >
        ⟳ Automatisch
      </button>
      <button type="button" (click)="refreshAll()" title="Alle Panels neu ausführen">↻ Alle</button>
      <button
        type="button"
        class="schema-toggle"
        [attr.aria-expanded]="schemaOpen()"
        aria-controls="report-schema"
        (click)="schemaOpen.set(!schemaOpen())"
      >
        ? Schema
      </button>
      <button
        type="button"
        class="back"
        (click)="sessions.setMode(session(), 'log')"
        [title]="'Zurück zum Log' + actions.hint('TOGGLE_DASHBOARD')"
      >
        ☰ Log
      </button>
    </div>
    @if (notice(); as n) {
      <p class="notice" role="status">
        {{ n }}
        <button type="button" aria-label="Hinweis schließen" (click)="notice.set(null)">×</button>
      </p>
    }
    @if (status()?.lowSpace) {
      <p class="notice warn" role="status">Wenig freier Speicher für die Dashboard-Datenbank.</p>
    }
    @if (failure(); as f) {
      <p class="notice error" role="alert">{{ f }}</p>
    }
    <div class="content">
      @if (schemaOpen()) {
        <aside id="report-schema" class="schema" aria-label="Schema und Hilfe">
          <h3>Tabelle <code>log</code></h3>
          <p class="hint">Eine Zeile je Eintrag (Kopf, ohne Fortsetzungszeilen), ohne Nachricht.</p>
          <table>
            <tbody>
              @for (c of schema()?.columns ?? []; track c.name) {
                <tr [class.off]="!c.included">
                  <td>
                    @if (c.column !== null) {
                      <input
                        type="checkbox"
                        [id]="'field-' + c.name"
                        [checked]="c.included"
                        [attr.aria-label]="c.name + ' in die Tabelle aufnehmen'"
                        (change)="setField(c.column, $any($event.target).checked)"
                      />
                    }
                  </td>
                  <td>
                    <code>{{ c.name }}</code>
                  </td>
                  <td class="type">{{ c.sqlType }}</td>
                  <td class="desc">{{ c.description }}{{ unitOf(c) }}</td>
                </tr>
              }
            </tbody>
          </table>
          <p class="hint">
            Angehakte Felder kommen in die Tabelle (Text kostet Platz, Zahlen sind vorgewählt).
            Ändern baut die Tabelle neu auf.
          </p>
          <h3>Tabelle <code>sources</code></h3>
          <p class="hint"><code>source</code>, <code>name</code>: Dateiname je Quelle.</p>
          <h3>Hilfen</h3>
          <ul class="hint">
            <li>
              <code>bucket(ts, '1m')</code>: Beginn der Minute; auch <code>'30s'</code>,
              <code>'5m'</code>, <code>'1h'</code>, <code>'1d'</code> (lokale Tage).
            </li>
            <li>
              <code>ts</code> ist UTC in Millisekunden; lesbar mit
              <code>datetime(ts / 1000, 'unixepoch', 'localtime')</code>.
            </li>
            <li>
              Erste Spalte <code>t</code>/<code>ts</code>/<code>bucket</code> mit ganzen Zahlen ist
              die Zeitachse, weitere Zahlenspalten sind Reihen, eine Textspalte teilt in Reihen.
            </li>
            <li>Eine Spalte <code>line</code> macht Tabellenzeilen zu Sprüngen ins Log.</li>
          </ul>
          <h3>SQLite statt T-SQL</h3>
          <ul class="hint">
            <li><code>LIMIT 10</code> statt <code>TOP 10</code>.</li>
            <li>
              <code>strftime('%H', ts / 1000, 'unixepoch')</code> statt <code>DATEPART</code>.
            </li>
            <li>
              <code>||</code> verbindet Text, <code>IFNULL</code>/<code>COALESCE</code> statt
              <code>ISNULL</code>.
            </li>
            <li>
              Nur lesen: <code>SELECT</code> und <code>WITH</code>, eine Anweisung, höchstens 10 000
              Zeilen und 10 s.
            </li>
          </ul>
        </aside>
      }
      <div class="grid">
        @for (panel of dashboard()?.panels ?? []; track panel.id) {
          <app-dashboard-panel
            [panel]="panel"
            [sessionId]="session().sessionId"
            [refresh]="tick()"
            (changed)="updatePanel($event)"
            (remove)="removePanel(panel.id)"
            (move)="movePanel(panel.id, $event)"
            (picked)="onPick($event)"
          />
        } @empty {
          <p class="empty">Keine Panels. „+ Vorlage …“ fügt eine fertige Auswertung hinzu.</p>
        }
      </div>
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      background: var(--bg-app);
      color: var(--text);
    }
    .bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      background: var(--bg-panel);
      border-bottom: 1px solid var(--border);
      flex-wrap: wrap;
    }
    h2 {
      margin: 0;
      font-size: 14px;
    }
    .status {
      color: var(--text-dim);
      font-size: 12px;
    }
    .spacer {
      flex: 1;
    }
    .notice {
      margin: 6px 10px 0;
      padding: 4px 8px;
      font-size: 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--bg-panel);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .notice.warn,
    .notice.error {
      color: var(--danger);
    }
    .notice button {
      margin-left: auto;
    }
    .content {
      flex: 1;
      min-height: 0;
      display: flex;
      gap: 10px;
      padding: 10px;
      overflow: hidden;
    }
    .grid {
      flex: 1;
      min-width: 0;
      overflow: auto;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      grid-auto-rows: min-content;
      gap: 10px;
      align-content: start;
    }
    .schema {
      flex: none;
      width: 300px;
      overflow: auto;
      font-size: 12px;
      background: var(--bg-panel);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 8px 10px;
    }
    .schema h3 {
      font-size: 12px;
      margin: 8px 0 4px;
    }
    .schema table {
      border-collapse: collapse;
      width: 100%;
    }
    .schema td {
      padding: 1px 4px;
      vertical-align: top;
    }
    .schema tr.off code {
      color: var(--text-dim);
    }
    .schema .type,
    .hint {
      color: var(--text-dim);
    }
    .hint {
      margin: 4px 0;
      padding-left: 0;
    }
    ul.hint {
      padding-left: 16px;
    }
    .empty {
      grid-column: 1 / -1;
      color: var(--text-dim);
    }
    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
    }
    @media (max-width: 900px) {
      .grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .schema {
        width: 220px;
      }
    }
  `,
})
export class DashboardComponent implements OnInit, OnDestroy {
  private readonly api = inject(LogApi);
  private readonly store = inject(DashboardStore);
  protected readonly sessions = inject(LogSessionService);
  protected readonly actions = inject(ActionService);

  readonly session = input.required<SessionState>();

  protected readonly schema = signal<ReportSchema | null>(null);
  protected readonly dashboard = signal<DashboardDef | null>(null);
  protected readonly schemaOpen = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly failure = signal<string | null>(null);
  /** Goes up for each refresh of all panels. */
  protected readonly tick = signal(0);
  protected readonly status = computed(() => this.session().update().report ?? null);
  protected readonly templateList = computed(() => templates(this.schema()));
  protected readonly full = computed(() => (this.dashboard()?.panels.length ?? 0) >= MAX_PANELS);
  protected readonly statusText = computed(() => {
    const s = this.status();
    if (!s) return 'Datenbank wird angelegt …';
    const rows = `${formatCount(s.rows)} Einträge`;
    switch (s.state) {
      case 'building':
        return `Aufbau ${Math.floor(s.progress * 100)} % · ${rows}`;
      case 'indexing':
        return `Zeitindex … · ${rows}`;
      case 'error':
        return `Fehler: ${describeQueryError(s.message ?? '')}`;
      default:
        return `${rows} · ${formatBytes(s.size)}`;
    }
  });

  private profileId = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastGeneration: number | null = null;
  private lastLines = -1;
  private lastState: string | null = null;
  private opened = false;
  private destroyed = false;

  /** Who opens the report for the backend: this tab (two tabs of a file can show a dashboard each). */
  private user(): string {
    return `tab:${this.session().id}`;
  }

  constructor() {
    // Starting over (truncation, other columns) or the end of the first build: schema and panels anew.
    effect(() => {
      const s = this.status();
      if (!s || !this.opened) return;
      untracked(() => {
        if (this.lastGeneration !== null && s.generation !== this.lastGeneration && s.reason) {
          this.notice.set(`Tabelle neu aufgebaut: ${REASONS[s.reason] ?? s.reason}.`);
        }
        const finished = s.state === 'ready' && this.lastState !== 'ready';
        if (s.generation !== this.lastGeneration || finished) {
          this.lastGeneration = s.generation;
          void this.loadSchema();
          if (finished) this.refreshAll();
        }
        this.lastState = s.state;
      });
    });
  }

  async ngOnInit(): Promise<void> {
    const session = this.session();
    await this.store.load();
    // Switched off again while loading: nothing was opened, nothing is to close.
    if (this.destroyed) return;
    this.profileId = session.columns()?.profileId ?? session.update().profileId;
    const saved = this.store.get(this.profileId);
    try {
      const schema = await this.api.openReport(
        session.sessionId,
        saved?.fields ?? null,
        this.user(),
      );
      if (this.destroyed) {
        // Gone while the backend opened: this opening is ours to close, and no timer starts.
        void this.api.closeReport(session.sessionId, this.user()).catch(() => undefined);
        return;
      }
      this.schema.set(schema);
      this.opened = true;
      this.lastGeneration = schema.status?.generation ?? null;
      this.lastState = schema.status?.state ?? null;
      const dashboard = saved ?? defaultDashboard(schema);
      this.dashboard.set(dashboard);
      if (!saved) this.store.set(this.profileId, dashboard);
    } catch (e) {
      this.failure.set(describeQueryError(toAppError(e).message));
    }
    if (this.destroyed) return;
    this.timer = setInterval(() => this.liveTick(), REFRESH_MS);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    // Hidden: the backend stops catching up once nobody else has it open; the file stays for the next time.
    // Only an opening that came back is closed here: the backend counts them (two tabs of a file, the AI).
    if (this.opened)
      void this.api.closeReport(this.session().sessionId, this.user()).catch(() => undefined);
  }

  /**
   * Every 5 s: only when switched on and something new is in the table. Behind other windows too, like the log
   * (`backgroundThrottling: disabled`); a hidden tab or the log mode has no dashboard, so nothing runs there.
   */
  private liveTick(): void {
    const d = this.dashboard();
    const s = this.status();
    if (!d?.auto || !s) return;
    if (s.lines === this.lastLines) return;
    this.lastLines = s.lines;
    this.tick.update((t) => t + 1);
  }

  protected refreshAll(): void {
    this.lastLines = this.status()?.lines ?? -1;
    this.tick.update((t) => t + 1);
  }

  private async loadSchema(): Promise<void> {
    try {
      this.schema.set(await this.api.getReportSchema(this.session().sessionId));
    } catch {
      // The next status asks again.
    }
  }

  private save(change: (d: DashboardDef) => DashboardDef): void {
    const current = this.dashboard();
    if (!current) return;
    const next = change(current);
    this.dashboard.set(next);
    this.store.set(this.profileId, next);
  }

  protected toggleAuto(): void {
    this.save((d) => ({ ...d, auto: !d.auto }));
  }

  protected addPanel(): void {
    this.save((d) => ({ ...d, panels: [...d.panels, emptyPanel()] }));
  }

  protected addTemplate(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const template = this.templateList().find((t) => t.id === select.value);
    select.value = '';
    if (!template) return;
    this.save((d) => ({ ...d, panels: [...d.panels, fromTemplate(template)] }));
  }

  protected updatePanel(panel: PanelDef): void {
    this.save((d) => ({ ...d, panels: d.panels.map((p) => (p.id === panel.id ? panel : p)) }));
  }

  protected removePanel(id: string): void {
    this.save((d) => ({ ...d, panels: d.panels.filter((p) => p.id !== id) }));
  }

  protected movePanel(id: string, step: -1 | 1): void {
    this.save((d) => ({ ...d, panels: moved(d.panels, id, step) }));
  }

  protected unitOf(c: { kind: string | null; unit: string | null } & object): string {
    const unit = baseUnit(c as Parameters<typeof baseUnit>[0]);
    return unit ? ` (${unit})` : '';
  }

  /** A field ticked or unticked: stored with the dashboard, the table is built anew. */
  protected async setField(column: string, on: boolean): Promise<void> {
    const schema = this.schema();
    const d = this.dashboard();
    if (!schema || !d) return;
    const fields = toggleField(schema, d.fields, column, on);
    this.save((x) => ({ ...x, fields }));
    try {
      this.schema.set(await this.api.openReport(this.session().sessionId, fields, this.user()));
    } catch (e) {
      this.failure.set(describeQueryError(toAppError(e).message));
    }
  }

  /** A point, bar, slice or table row: to the line in the log, or a filter for a bar without time axis. */
  protected async onPick(event: PanelPick): Promise<void> {
    const session = this.session();
    if (event.line !== null) {
      await this.sessions.showLine(session, event.line - 1);
      return;
    }
    const { data, pick } = event;
    if (!pick) return;
    if (data.axis === 'time' && !pick.slice) {
      const range = rangeAt(data, pick.index);
      if (!range) return;
      const level =
        data.splitColumn?.toLowerCase() === 'level' ? (pick.series?.level ?? null) : null;
      try {
        const result = await this.api.runReport(
          session.sessionId,
          firstLineQuery(range, level),
          `${event.panel.id}:jump`,
        );
        const line = result.rows[0]?.[0];
        if (typeof line !== 'number') {
          this.notice.set('Keine Zeile in diesem Zeitraum.');
          return;
        }
        await this.sessions.showLine(session, line - 1);
      } catch (e) {
        this.failure.set(describeQueryError(toAppError(e).message));
      }
      return;
    }
    // Without a time axis: the category (or slice) as a filter.
    let column: string | null;
    let value: string | null;
    if (pick.slice) {
      column = data.axis === 'category' && !data.splitColumn ? data.axisColumn : data.splitColumn;
      value = pick.slice.splitValue;
    } else if (
      pick.series?.splitValue !== null &&
      pick.series?.splitValue !== undefined &&
      data.splitColumn
    ) {
      column = data.splitColumn;
      value = pick.series.splitValue;
    } else {
      column = data.axisColumn;
      value = data.categories[pick.index] ?? null;
    }
    if (!column || value === null) return;
    const log = this.schema()?.columns.find((c) => c.name === column.toLowerCase())?.column ?? null;
    const done = await this.sessions.filterFromDashboard(session, { sql: column, log }, value);
    if (!done) this.notice.set(`Für die Spalte „${column}“ gibt es keinen Filter im Log.`);
  }
}
