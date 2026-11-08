import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { AppError, toAppError } from '../../core/errors/app-error';
import { pickFile } from '../../core/dialog/native-dialog';
import { LogApi } from '../../core/log/log-api';
import {
  DbAuth,
  DbConfig,
  DbEngine,
  DbPreview,
  DbTable,
  RemoteCredentials,
  TlsMode,
} from '../../core/log/log.models';
import { SettingsService } from '../../core/settings/settings.service';
import { LogSessionService } from '../sessions/log-session.service';
import {
  DbForm,
  ENGINES,
  TLS_CHOICES,
  checkDbForm,
  dbLabel,
  defaultDbForm,
  defaultPort,
  describeDbError,
  formOfDbConfig,
  guessColumns,
  previewTable,
  tableLabel,
  tableQuery,
  tlsWarning,
} from './database-logic';

/**
 * „Datenbank“ (prompt 019): a `SELECT` on PostgreSQL, MySQL/MariaDB, SQL Server or SQLite as a live source. The
 * query is checked here roughly and in the backend properly (one SELECT, nothing that writes) and runs read-only;
 * new rows come by polling with the key column. The password stays in this dialog while it is open and goes into the
 * system keychain only when ticked. Values from the database are shown as text, never as markup.
 */
@Component({
  selector: 'app-database-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog (close)="closed.emit()" aria-labelledby="db-title">
      <form (submit)="submit($event)" novalidate>
        <h2 id="db-title">Datenbank</h2>
        @if (saved().length) {
          <div class="saved" role="group" aria-label="Zuletzt geöffnete Datenbank-Abfragen">
            <span class="dim">Zuletzt:</span>
            @for (s of saved(); track $index) {
              <button type="button" class="chip" (click)="use(s.config, s.keep)">
                {{ label(s.config) }}
              </button>
            }
          </div>
        }
        <label class="row">
          <span>Art</span>
          <select id="db-engine" (change)="chooseEngine($event)">
            @for (e of engines; track e.id) {
              <option [value]="e.id" [selected]="form().engine === e.id">{{ e.label }}</option>
            }
          </select>
        </label>
        @if (form().engine === 'sqlite') {
          <label class="row">
            <span>Datei</span>
            <input
              id="db-path"
              type="text"
              spellcheck="false"
              autocomplete="off"
              placeholder="/pfad/zur/app.db"
              [value]="form().path"
              [attr.aria-invalid]="!!check().errors.path"
              (input)="patch({ path: value($event) })"
            />
            <button type="button" id="db-path-pick" (click)="pickPath()">Wählen …</button>
          </label>
          @if (check().errors.path; as message) {
            <p class="error">{{ message }}</p>
          }
          <p class="dim note">Wird nur lesend geöffnet; die Datei wird nie verändert.</p>
        } @else {
          <div class="grid">
            <label class="row">
              <span>Host</span>
              <input
                id="db-host"
                type="text"
                spellcheck="false"
                autocomplete="off"
                [value]="form().host"
                [attr.aria-invalid]="!!check().errors.host"
                (input)="patch({ host: value($event) })"
              />
            </label>
            <label class="row port">
              <span>Port</span>
              <input
                id="db-port"
                type="number"
                min="1"
                max="65535"
                [placeholder]="portPlaceholder()"
                [value]="form().port"
                [attr.aria-invalid]="!!check().errors.port"
                (input)="patch({ port: value($event) })"
              />
            </label>
          </div>
          @if (check().errors.host || check().errors.port; as message) {
            <p class="error">{{ message }}</p>
          }
          <label class="row">
            <span>Datenbank</span>
            <input
              id="db-database"
              type="text"
              spellcheck="false"
              autocomplete="off"
              placeholder="leer: Standard des Benutzers"
              [value]="form().database"
              (input)="patch({ database: value($event) })"
            />
          </label>
          <label class="row">
            <span>Benutzer</span>
            <input
              id="db-user"
              type="text"
              spellcheck="false"
              autocomplete="username"
              [value]="form().user"
              [attr.aria-invalid]="!!check().errors.user"
              (input)="patch({ user: value($event) })"
            />
          </label>
          <fieldset>
            <legend>Anmeldung</legend>
            @if (form().engine !== 'mssql') {
              @for (a of auths; track a.id) {
                <label>
                  <input
                    type="radio"
                    name="db-auth"
                    [id]="'db-auth-' + a.id"
                    [checked]="form().auth === a.id"
                    (change)="patch({ auth: a.id })"
                  />
                  {{ a.label }}
                </label>
              }
            }
            @if (form().auth === 'password' || form().engine === 'mssql') {
              <label class="row">
                <span>Passwort</span>
                <input
                  #secretInput
                  id="db-secret"
                  type="password"
                  autocomplete="current-password"
                  placeholder="leer: aus dem Schlüsselbund"
                  [value]="secret()"
                  (input)="secret.set(value($event))"
                />
              </label>
              <label>
                <input
                  id="db-remember"
                  type="checkbox"
                  [checked]="remember()"
                  (change)="remember.set(checked($event))"
                />
                Im Schlüsselbund merken (erst nach erfolgreicher Anmeldung)
              </label>
              <button type="button" class="link" id="db-forget" (click)="forget()">
                Gespeichertes Passwort vergessen
              </button>
            }
            <p class="dim note">
              <strong>Empfohlen:</strong> ein eigenes Datenbank-Konto mit reinen Leserechten (nur
              SELECT auf die Log-Tabelle). Die App prüft die Abfrage und fragt nur lesend ab, aber
              manche Funktionen einer Datenbank können mehr als lesen.
            </p>
          </fieldset>
          <label class="row">
            <span>TLS</span>
            <select id="db-tls" (change)="chooseTls($event)">
              @for (t of tlsChoices; track t.id) {
                <option [value]="t.id" [selected]="form().tls === t.id">{{ t.label }}</option>
              }
            </select>
          </label>
          @if (warning(); as text) {
            <p class="warning" role="note" id="db-tls-warning">
              <strong>Achtung:</strong> {{ text }}
            </p>
          }
          @if (form().tls === 'verify') {
            <label class="row">
              <span>CA-Datei</span>
              <input
                id="db-ca"
                type="text"
                spellcheck="false"
                autocomplete="off"
                placeholder="optional, PEM; sonst die Zertifikate des Systems"
                [value]="form().caFile"
                [attr.aria-invalid]="!!check().errors.caFile"
                (input)="patch({ caFile: value($event) })"
              />
              <button type="button" (click)="pickCa()">Wählen …</button>
            </label>
            @if (check().errors.caFile; as message) {
              <p class="error">{{ message }}</p>
            }
          }
        }
        <div class="query-head">
          <label class="block" for="db-query">Abfrage</label>
          <button
            type="button"
            id="db-tables"
            [disabled]="!check().connection || loadingTables()"
            (click)="loadTables()"
          >
            Tabelle wählen …
          </button>
        </div>
        @if (tables(); as list) {
          <label class="row">
            <span>Tabelle</span>
            <select id="db-table" aria-label="Tabelle" (change)="chooseTable($event)">
              <option value="" selected disabled>{{ list.length }} Tabellen und Sichten</option>
              @for (t of list; track $index) {
                <option [value]="$index">{{ tableName(t) }}</option>
              }
            </select>
          </label>
        }
        <textarea
          id="db-query"
          rows="3"
          spellcheck="false"
          placeholder="SELECT * FROM logs WHERE level <> 'DEBUG'"
          [value]="form().query"
          [attr.aria-invalid]="!!check().errors.query"
          aria-describedby="db-query-note"
          (input)="patch({ query: value($event) })"
        ></textarea>
        <p id="db-query-note" class="dim note">
          @if (touched() && check().errors.query; as message) {
            <span class="error">{{ message }}</span>
          } @else {
            Ein SELECT ohne ORDER BY und LIMIT: die App holt die Zeilen nach der Schlüsselspalte
            geordnet in Stapeln, lesend und mit Zeitlimit.
          }
        </p>
        <datalist id="db-columns">
          @for (c of columnNames(); track c) {
            <option [value]="c"></option>
          }
        </datalist>
        <div class="grid3">
          <label class="stack">
            <span>Schlüsselspalte</span>
            <input
              id="db-key"
              type="text"
              list="db-columns"
              spellcheck="false"
              [value]="form().keyColumn"
              [attr.aria-invalid]="!!check().errors.keyColumn"
              (input)="patch({ keyColumn: value($event) })"
            />
          </label>
          <label class="stack">
            <span>Zeitspalte</span>
            <input
              id="db-time"
              type="text"
              list="db-columns"
              spellcheck="false"
              placeholder="optional"
              [value]="form().timeColumn"
              (input)="patch({ timeColumn: value($event) })"
            />
          </label>
          <label class="stack">
            <span>Level-Spalte</span>
            <input
              id="db-level"
              type="text"
              list="db-columns"
              spellcheck="false"
              placeholder="optional"
              [value]="form().levelColumn"
              (input)="patch({ levelColumn: value($event) })"
            />
          </label>
        </div>
        <p class="dim note">
          Schlüssel: fortlaufende Spalte (id oder Zeit); neue Zeilen kommen mit einem größeren Wert.
          Gleiche Werte (Zeiten) gehen nicht verloren. Zeit- und Level-Spalte heißen in der Ansicht
          „timestamp“ und „level“.
        </p>
        <div class="grid">
          <label class="row">
            <span>Abstand</span>
            <input
              id="db-interval"
              type="text"
              inputmode="decimal"
              [value]="form().interval"
              [attr.aria-invalid]="!!check().errors.interval"
              (input)="patch({ interval: value($event) })"
            />
            <span class="unit">s</span>
          </label>
        </div>
        @if (check().errors.interval; as message) {
          <p class="error">{{ message }}</p>
        }
        <fieldset>
          <legend>Startpunkt</legend>
          <label>
            <input
              type="radio"
              name="db-start"
              id="db-start-last"
              [checked]="!form().startAll"
              (change)="patch({ startAll: false })"
            />
            Letzte
            <input
              id="db-start-n"
              class="count"
              type="number"
              min="1"
              aria-label="Anzahl Zeilen"
              [value]="form().startLast"
              [disabled]="form().startAll"
              (input)="patch({ startLast: value($event) })"
            />
            Zeilen
          </label>
          <label>
            <input
              type="radio"
              name="db-start"
              id="db-start-all"
              [checked]="form().startAll"
              (change)="patch({ startAll: true })"
            />
            Alle Zeilen
          </label>
          @if (check().errors.startLast; as message) {
            <p class="error">{{ message }}</p>
          }
        </fieldset>
        @if (preview(); as table) {
          <div class="preview" role="region" aria-label="Vorschau der ersten Zeilen" tabindex="0">
            <table id="db-preview">
              <thead>
                <tr>
                  @for (c of table.columns; track $index) {
                    <th scope="col">{{ c }}</th>
                  }
                </tr>
              </thead>
              <tbody>
                @for (r of table.rows; track $index) {
                  <tr>
                    @for (v of r; track $index) {
                      <td>{{ v }}</td>
                    }
                  </tr>
                } @empty {
                  <tr>
                    <td [attr.colspan]="table.columns.length || 1" class="dim">Keine Zeilen.</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="dim note" role="status">
            {{ table.rows.length }} Zeilen der Vorschau, Schlüssel vom Typ {{ keyType() }}.
          </p>
        }
        <label>
          <input
            id="db-keep"
            type="checkbox"
            [checked]="keep()"
            (change)="keep.set(checked($event))"
          />
          Spool beim Schließen behalten
        </label>
        @if (busy()) {
          <p class="dim note" role="status">Verbinde …</p>
        }
        @if (error(); as message) {
          <p class="error" role="alert" id="db-error">{{ message }}</p>
        }
        <div class="actions">
          <button type="button" (click)="dialog.close()">Abbrechen</button>
          <button
            type="button"
            id="db-preview-button"
            [disabled]="busy() || !check().config"
            (click)="loadPreview()"
          >
            Vorschau
          </button>
          <button
            id="db-start"
            type="submit"
            class="primary"
            [disabled]="busy() || !check().config"
          >
            Öffnen
          </button>
        </div>
      </form>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(620px, 94vw);
      max-height: 94vh;
      padding: 14px 16px;
      background: var(--bg-panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 45%);
    }
    h2 {
      margin: 0 0 10px;
      font-size: 14px;
    }
    fieldset {
      margin: 0 0 10px;
      padding: 6px 10px 4px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    legend {
      padding: 0 4px;
      font-size: 12px;
      font-weight: 600;
    }
    label {
      display: flex;
      gap: 6px;
      align-items: baseline;
      padding: 2px 0;
      font-size: 12.5px;
    }
    label.row {
      align-items: center;
      margin-bottom: 6px;
    }
    label.row > span:first-child {
      flex: none;
      width: 80px;
    }
    label.row > select,
    label.row > input {
      flex: 1;
      min-width: 0;
    }
    label.port > span:first-child {
      width: auto;
    }
    label.port > input {
      width: 7em;
      flex: none;
    }
    label.stack {
      flex-direction: column;
      align-items: stretch;
      gap: 2px;
    }
    label.block {
      display: block;
      font-weight: 600;
      font-size: 12px;
    }
    .grid {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .grid > label.row:first-child {
      flex: 1;
      min-width: 220px;
    }
    .grid3 {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 8px;
    }
    .unit {
      flex: none;
    }
    .count {
      width: 7em;
    }
    .query-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      font-family: var(--font-mono);
      font-size: 12px;
      resize: vertical;
    }
    .preview {
      max-height: 200px;
      overflow: auto;
      margin: 6px 0;
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    .preview table {
      border-collapse: collapse;
      font-family: var(--font-mono);
      font-size: 11.5px;
    }
    .preview th,
    .preview td {
      padding: 2px 6px;
      border-bottom: 1px solid var(--border);
      text-align: left;
      white-space: nowrap;
      max-width: 260px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .preview th {
      position: sticky;
      top: 0;
      background: var(--bg-panel);
    }
    .saved {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      margin-bottom: 10px;
      font-size: 12px;
    }
    .chip {
      padding: 2px 8px;
      border: 1px solid var(--border);
      border-radius: 10px;
      font-size: 12px;
    }
    .dim {
      color: var(--text-dim);
    }
    .note {
      margin: 2px 0 8px;
      font-size: 11.5px;
    }
    .warning {
      margin: 0 0 10px;
      padding: 8px 10px;
      border: 1px solid var(--lv-warn-fg);
      border-radius: var(--radius);
      color: var(--lv-warn-fg);
      font-size: 12px;
    }
    .error {
      margin: 2px 0 8px;
      color: var(--danger);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .link {
      padding: 0;
      border: none;
      background: none;
      color: var(--accent);
      font-size: 12px;
      text-decoration: underline;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 12px;
    }
    .primary {
      background: var(--accent);
      color: var(--accent-text);
      font-weight: 600;
    }
  `,
})
export class DatabaseDialogComponent implements OnInit, OnDestroy {
  private readonly api = inject(LogApi);
  protected readonly sessions = inject(LogSessionService);
  private readonly settings = inject(SettingsService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly secretInput = viewChild<ElementRef<HTMLInputElement>>('secretInput');

  /** A configuration to start from (remembered, a workspace); otherwise the defaults. */
  readonly start = input<DbConfig | null>(null);
  /** What made the dialog open (a missing password, a certificate), shown at once. */
  readonly startError = input<AppError | null>(null);
  readonly closed = output<void>();

  protected readonly engines = ENGINES;
  protected readonly tlsChoices = TLS_CHOICES;
  protected readonly auths: readonly { id: DbAuth; label: string }[] = [
    { id: 'password', label: 'Benutzer und Passwort' },
    { id: 'none', label: 'Ohne Passwort' },
  ];
  protected readonly label = dbLabel;
  protected readonly tableName = tableLabel;

  protected readonly form = signal<DbForm>(defaultDbForm());
  protected readonly keep = signal(false);
  protected readonly busy = signal(false);
  protected readonly loadingTables = signal(false);
  protected readonly touched = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly tables = signal<DbTable[] | null>(null);
  private readonly previewData = signal<DbPreview | null>(null);
  /** The password as typed; only here, only while the dialog is open. */
  protected readonly secret = signal('');
  protected readonly remember = signal(false);

  protected readonly saved = computed(() =>
    this.settings
      .settings()
      .savedSources.filter(
        (s): s is { config: DbConfig; keep: boolean } => s.config.kind === 'database',
      ),
  );
  protected readonly check = computed(() => checkDbForm(this.form()));
  protected readonly warning = computed(() => tlsWarning(this.form()));
  protected readonly portPlaceholder = computed(() => String(defaultPort(this.form().engine)));
  protected readonly preview = computed(() => {
    const p = this.previewData();
    return p ? previewTable(p) : null;
  });
  protected readonly keyType = computed(() => this.previewData()?.keyType ?? '');
  protected readonly columnNames = computed(
    () => this.previewData()?.columns.map((c) => c.name) ?? [],
  );

  ngOnInit(): void {
    const start = this.start();
    if (start) this.use(start, false);
    const error = this.startError();
    if (error) this.error.set(describeDbError(error));
    this.dialog().nativeElement.showModal();
  }

  ngOnDestroy(): void {
    this.secret.set('');
  }

  protected patch(change: Partial<DbForm>): void {
    const before = this.form();
    this.form.update((f) => ({ ...f, ...change }));
    this.error.set(null);
    const after = this.form();
    // Another server or login: the password typed for the old one no longer applies.
    if (
      after.engine !== before.engine ||
      after.host !== before.host ||
      after.port !== before.port ||
      after.user !== before.user ||
      after.database !== before.database
    ) {
      this.secret.set('');
      this.tables.set(null);
    }
    if (
      after.query !== before.query ||
      after.engine !== before.engine ||
      after.path !== before.path
    ) {
      this.previewData.set(null);
    }
  }

  protected use(config: DbConfig, keep: boolean): void {
    this.form.set(formOfDbConfig(config));
    this.keep.set(keep);
    this.secret.set('');
    this.error.set(null);
    this.previewData.set(null);
    this.tables.set(null);
  }

  protected chooseEngine(event: Event): void {
    this.patch({ engine: (event.target as HTMLSelectElement).value as DbEngine, port: '' });
  }

  protected chooseTls(event: Event): void {
    this.patch({ tls: (event.target as HTMLSelectElement).value as TlsMode });
  }

  protected chooseTable(event: Event): void {
    const table = this.tables()?.[Number((event.target as HTMLSelectElement).value)];
    if (table) this.patch({ query: tableQuery(table, this.form().engine) });
  }

  protected async pickPath(): Promise<void> {
    const path = await pickFile('SQLite-Datei wählen', [
      { name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] },
    ]);
    if (path) this.patch({ path });
  }

  protected async pickCa(): Promise<void> {
    const path = await pickFile('CA-Zertifikat wählen', [
      { name: 'Zertifikat (PEM)', extensions: ['pem', 'crt', 'cer'] },
    ]);
    if (path) this.patch({ caFile: path });
  }

  private credentials(): RemoteCredentials | null {
    const c = this.check().connection;
    if (!c || c.auth !== 'password' || !this.secret()) return null;
    return { secret: this.secret(), remember: this.remember() };
  }

  protected async loadTables(): Promise<void> {
    const connection = this.check().connection;
    if (!connection || this.loadingTables()) return;
    this.loadingTables.set(true);
    try {
      this.tables.set(await this.api.dbTables(connection, this.credentials()));
    } catch (e) {
      this.showError(toAppError(e));
    } finally {
      this.loadingTables.set(false);
    }
  }

  protected async loadPreview(): Promise<void> {
    this.touched.set(true);
    const config = this.check().config;
    if (!config || this.busy()) return;
    this.busy.set(true);
    try {
      const preview = await this.api.dbPreview(config, this.credentials());
      this.previewData.set(preview);
      this.fillColumns(preview.columns.map((c) => c.name));
    } catch (e) {
      this.showError(toAppError(e));
    } finally {
      this.busy.set(false);
    }
  }

  /** Empty time and level columns take the usual names of the result. */
  private fillColumns(names: string[]): void {
    const guess = guessColumns(names);
    const f = this.form();
    const change: Partial<DbForm> = {};
    if (!f.timeColumn && guess.time) change.timeColumn = guess.time;
    if (!f.levelColumn && guess.level) change.levelColumn = guess.level;
    if (!names.includes(f.keyColumn) && guess.key) change.keyColumn = guess.key;
    if (Object.keys(change).length) this.form.update((v) => ({ ...v, ...change }));
  }

  protected async forget(): Promise<void> {
    const connection = this.check().connection;
    if (!connection) return;
    try {
      await this.api.forgetDbSecret(connection);
      this.error.set('Gespeichertes Passwort entfernt.');
    } catch (e) {
      this.showError(toAppError(e));
    }
  }

  private showError(error: AppError): void {
    this.error.set(describeDbError(error));
    if (error.code === 'secret_required') {
      this.secret.set('');
      setTimeout(() => this.secretInput()?.nativeElement.focus());
    }
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    this.touched.set(true);
    const config = this.check().config;
    if (!config || this.busy()) return;
    this.busy.set(true);
    try {
      const error = await this.sessions.openSource(config, this.keep(), this.credentials());
      if (error) this.showError(error);
      else this.dialog().nativeElement.close();
    } catch (e) {
      this.showError(toAppError(e));
    } finally {
      this.busy.set(false);
    }
  }
}
