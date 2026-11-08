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
import { LogApi } from '../../core/log/log-api';
import { RemoteCredentials, WinAuth, WinEventConfig } from '../../core/log/log.models';
import { SettingsService } from '../../core/settings/settings.service';
import { LogSessionService } from '../sessions/log-session.service';
import { sourceKey } from '../sources/source-logic';
import {
  MAX_CHANNELS,
  PERIODS,
  USUAL_CHANNELS,
  WINEVENT_PROFILE,
  WinEventForm,
  checkWinEventForm,
  computerName,
  defaultWinEventForm,
  describeWinEventError,
  filterChannels,
  formOfConfig,
  wineventLabel,
} from './winevent-logic';

/** Channels drawn at a time; the filter narrows the rest. */
const SHOWN = 300;

/**
 * „Windows-Ereignisse“ (prompt 018, only on Windows): channels of this or another computer as live sources, the
 * events of a period first. A remote computer is read with the logged-on Windows identity or with user and
 * password; the password stays in this dialog while it is open and goes into the system keychain only when ticked.
 */
@Component({
  selector: 'app-winevent-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog (close)="closed.emit()" aria-labelledby="winevent-title">
      <form (submit)="submit($event)" novalidate>
        <h2 id="winevent-title">Windows-Ereignisse</h2>
        @if (saved().length) {
          <div class="saved" role="group" aria-label="Zuletzt geöffnete Ereignisprotokolle">
            <span class="dim">Zuletzt:</span>
            @for (s of saved(); track $index) {
              <button type="button" class="chip" (click)="use(s.config, s.keep)">
                {{ label(s.config) }}
              </button>
            }
          </div>
        }
        <label class="row">
          <span>Rechner</span>
          <input
            id="winevent-computer"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="leer: dieser Rechner"
            [value]="form().computer"
            [attr.aria-invalid]="!!check().errors.computer"
            (input)="patch({ computer: value($event) })"
            (change)="computerChanged()"
          />
        </label>
        @if (check().errors.computer; as message) {
          <p class="error">{{ message }}</p>
        }
        @if (remote()) {
          <fieldset>
            <legend>Anmeldung auf {{ computer() }}</legend>
            @for (a of auths; track a.id) {
              <label>
                <input
                  type="radio"
                  name="winevent-auth"
                  [id]="'winevent-auth-' + a.id"
                  [value]="a.id"
                  [checked]="form().auth === a.id"
                  (change)="patch({ auth: a.id })"
                />
                {{ a.label }}
              </label>
            }
            @if (form().auth === 'password') {
              <label class="row">
                <span>Benutzer</span>
                <input
                  id="winevent-user"
                  type="text"
                  autocomplete="username"
                  spellcheck="false"
                  placeholder="FIRMA\\name"
                  [value]="form().user"
                  [attr.aria-invalid]="!!check().errors.user"
                  (input)="patch({ user: value($event) })"
                />
              </label>
              @if (check().errors.user; as message) {
                <p class="error">{{ message }}</p>
              }
              <label class="row">
                <span>Passwort</span>
                <input
                  #secretInput
                  id="winevent-secret"
                  type="password"
                  autocomplete="current-password"
                  placeholder="leer: aus dem Schlüsselbund"
                  [value]="secret()"
                  (input)="secret.set(value($event))"
                />
              </label>
              <label>
                <input
                  id="winevent-remember"
                  type="checkbox"
                  [checked]="remember()"
                  (change)="remember.set(checked($event))"
                />
                Im Schlüsselbund merken (erst nach erfolgreicher Anmeldung)
              </label>
              <button type="button" class="link" id="winevent-forget" (click)="forget()">
                Gespeichertes Passwort vergessen
              </button>
            }
            <p class="dim note">
              Dort müssen die Firewall-Regel „Remoteereignisprotokollverwaltung“ freigegeben und das
              Konto Mitglied von „Ereignisprotokollleser“ (Event Log Readers) oder Administrator
              sein.
            </p>
          </fieldset>
        }
        <fieldset>
          <legend>Kanäle ({{ form().channels.length }} von höchstens {{ maxChannels }})</legend>
          <div class="channel-tools">
            <input
              id="winevent-filter"
              type="search"
              spellcheck="false"
              placeholder="Filtern, z. B. powershell"
              aria-label="Kanäle filtern"
              [value]="query()"
              (input)="query.set(value($event))"
            />
            <button
              type="button"
              id="winevent-load"
              [disabled]="loading() || !check().target"
              (click)="loadChannels()"
            >
              {{ loaded() ? 'Neu laden' : 'Alle Kanäle laden' }}
            </button>
          </div>
          <div class="channels" id="winevent-channels" role="group" aria-label="Kanäle">
            @for (c of shown(); track c) {
              <label>
                <input
                  type="checkbox"
                  [checked]="form().channels.includes(c)"
                  [disabled]="!form().channels.includes(c) && form().channels.length >= maxChannels"
                  (change)="toggle(c, checked($event))"
                />
                <bdi>{{ c }}</bdi>
              </label>
            } @empty {
              <p class="dim note">Kein Kanal passt zum Filter.</p>
            }
            @if (more()) {
              <p class="dim note">… {{ more() }} weitere, Filter eingeben</p>
            }
          </div>
          @if (loading()) {
            <p class="dim note" role="status">Lade Kanäle …</p>
          }
          @if (touched() && check().errors.channels; as message) {
            <p class="error">{{ message }}</p>
          }
          <p class="dim note">
            „Security“ braucht Administratorrechte oder die Gruppe „Ereignisprotokollleser“; die App
            fordert keine Rechteerhöhung an.
          </p>
        </fieldset>
        <label class="row">
          <span>Zeitraum</span>
          <select id="winevent-period" (change)="choosePeriod($event)">
            @for (p of periods; track $index) {
              <option [value]="$index" [selected]="form().hours === p.hours">{{ p.label }}</option>
            }
          </select>
        </label>
        <label>
          <input
            id="winevent-xml"
            type="checkbox"
            [checked]="form().xml"
            (change)="patch({ xml: checked($event) })"
          />
          Vollständiges XML anhängen (Detail-Panel; braucht mehr Platz im Spool)
        </label>
        @if (form().channels.length > 1) {
          <label>
            <input
              id="winevent-merge"
              type="checkbox"
              [checked]="form().merge"
              (change)="patch({ merge: checked($event) })"
            />
            Zusätzlich zu einem Tab zusammenführen (nach Zeit)
          </label>
        }
        <label>
          <input
            id="winevent-keep"
            type="checkbox"
            [checked]="keep()"
            (change)="keep.set(checked($event))"
          />
          Spool beim Schließen behalten
        </label>
        @if (error(); as message) {
          <p class="error" role="alert" id="winevent-error">{{ message }}</p>
        }
        <div class="actions">
          <button type="button" (click)="dialog.close()">Abbrechen</button>
          <button
            id="winevent-start"
            type="submit"
            class="primary"
            [disabled]="busy() || !check().configs.length"
          >
            {{ form().channels.length > 1 ? form().channels.length + ' Kanäle öffnen' : 'Öffnen' }}
          </button>
        </div>
      </form>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(560px, 94vw);
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
    label.row > span {
      flex: none;
      width: 80px;
    }
    label.row > select,
    label.row > input {
      flex: 1;
      min-width: 0;
    }
    .channel-tools {
      display: flex;
      gap: 6px;
      margin-bottom: 6px;
    }
    .channel-tools input {
      flex: 1;
      min-width: 0;
    }
    .channels {
      max-height: 180px;
      overflow: auto;
      padding: 2px 4px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      font-family: var(--font-mono);
    }
    .channels label {
      font-size: 12px;
      overflow-wrap: anywhere;
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
    .link {
      padding: 0;
      border: none;
      background: none;
      color: var(--accent);
      font-size: 12px;
      text-decoration: underline;
    }
    .error {
      margin: 2px 0 8px;
      color: var(--danger);
      font-size: 12px;
      overflow-wrap: anywhere;
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
export class WinEventDialogComponent implements OnInit, OnDestroy {
  private readonly api = inject(LogApi);
  private readonly sessions = inject(LogSessionService);
  private readonly settings = inject(SettingsService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly secretInput = viewChild<ElementRef<HTMLInputElement>>('secretInput');

  /** A configuration to start from (a remembered channel, a workspace). */
  readonly start = input<WinEventConfig | null>(null);
  /** The error that opened the dialog (a workspace needed a password). */
  readonly startError = input<AppError | null>(null);
  readonly closed = output<void>();

  protected readonly auths: readonly { id: WinAuth; label: string }[] = [
    { id: 'current', label: 'Angemeldete Windows-Identität' },
    { id: 'password', label: 'Benutzer und Passwort' },
  ];
  protected readonly periods = PERIODS;
  protected readonly maxChannels = MAX_CHANNELS;
  protected readonly label = wineventLabel;

  protected readonly form = signal<WinEventForm>(defaultWinEventForm());
  protected readonly keep = signal(false);
  protected readonly busy = signal(false);
  protected readonly loading = signal(false);
  protected readonly loaded = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly touched = signal(false);
  protected readonly query = signal('');
  protected readonly available = signal<string[]>([...USUAL_CHANNELS]);
  /** The password as typed; only here, only while the dialog is open. */
  protected readonly secret = signal('');
  protected readonly remember = signal(false);

  protected readonly saved = computed(() =>
    this.settings
      .settings()
      .savedSources.filter(
        (s): s is { config: WinEventConfig; keep: boolean } => s.config.kind === 'winevent',
      ),
  );
  protected readonly check = computed(() => checkWinEventForm(this.form()));
  protected readonly computer = computed(() => computerName(this.form().computer));
  protected readonly remote = computed(() => this.computer() !== '');
  private readonly filtered = computed(() =>
    filterChannels(this.available(), this.query(), this.form().channels),
  );
  protected readonly shown = computed(() => this.filtered().slice(0, SHOWN));
  protected readonly more = computed(() => Math.max(0, this.filtered().length - SHOWN));

  ngOnInit(): void {
    const start = this.start();
    if (start) this.use(start, false);
    const error = this.startError();
    if (error) this.error.set(describeWinEventError(error));
    this.dialog().nativeElement.showModal();
    // This computer: the list right away (no login needed).
    if (!this.remote()) void this.loadChannels();
  }

  ngOnDestroy(): void {
    this.secret.set('');
  }

  protected patch(change: Partial<WinEventForm>): void {
    const before = this.form();
    this.form.update((f) => ({ ...f, ...change }));
    this.error.set(null);
    // Another computer or login: the password typed for the old one no longer applies.
    const after = this.form();
    if (
      computerName(after.computer) !== computerName(before.computer) ||
      after.auth !== before.auth ||
      after.user !== before.user
    ) {
      this.secret.set('');
    }
  }

  /** Another computer: its own channels (the usual ones until loaded). */
  protected computerChanged(): void {
    this.loaded.set(false);
    this.available.set([...new Set([...USUAL_CHANNELS, ...this.form().channels])]);
    if (!this.remote()) void this.loadChannels();
  }

  protected use(config: WinEventConfig, keep: boolean): void {
    this.form.set(formOfConfig(config));
    this.keep.set(keep);
    this.secret.set('');
    this.error.set(null);
    this.available.update((list) => [...new Set([...list, config.channel])]);
  }

  protected toggle(channel: string, on: boolean): void {
    const channels = this.form().channels.filter((c) => c !== channel);
    this.touched.set(true);
    this.patch({ channels: on ? [...channels, channel] : channels });
  }

  protected choosePeriod(event: Event): void {
    const index = Number((event.target as HTMLSelectElement).value);
    this.patch({ hours: PERIODS[index]?.hours ?? null });
  }

  private credentials(): RemoteCredentials | null {
    if (this.check().target?.auth !== 'password' || !this.secret()) return null;
    return { secret: this.secret(), remember: this.remember() };
  }

  protected async loadChannels(): Promise<void> {
    const target = this.check().target;
    if (!target || this.loading()) return;
    this.loading.set(true);
    try {
      const list = await this.api.wineventChannels(target, this.credentials());
      this.available.set([...new Set([...list, ...this.form().channels])]);
      this.loaded.set(true);
    } catch (e) {
      this.showError(toAppError(e));
    } finally {
      this.loading.set(false);
    }
  }

  protected async forget(): Promise<void> {
    const target = this.check().target;
    if (!target) return;
    try {
      await this.api.forgetWineventSecret(target);
      this.error.set('Gespeichertes Passwort entfernt.');
    } catch (e) {
      this.showError(toAppError(e));
    }
  }

  private showError(error: AppError): void {
    this.error.set(describeWinEventError(error));
    if (error.code === 'secret_required') {
      this.secret.set('');
      setTimeout(() => this.secretInput()?.nativeElement.focus());
    }
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    this.touched.set(true);
    const { configs } = this.check();
    if (!configs.length || this.busy()) return;
    this.busy.set(true);
    try {
      for (const config of configs) {
        const error = await this.sessions.openSource(config, this.keep(), this.credentials());
        if (error) {
          this.showError(error);
          return;
        }
      }
      if (this.form().merge && configs.length > 1) {
        // Prompt 006: the spools of the channels as one tab by time; the channel tabs stay (they feed it).
        const keys = configs.map(sourceKey);
        const paths = keys
          .map(
            (key) =>
              this.sessions
                .sessions()
                .find((s) => s.viewId === 0 && s.source && sourceKey(s.source.config) === key)
                ?.path,
          )
          .filter((p): p is string => !!p);
        const error = await this.sessions.openMerged(
          paths.map((path) => ({ path, profileId: WINEVENT_PROFILE })),
        );
        if (error) {
          this.showError(error);
          return;
        }
      }
      this.dialog().nativeElement.close();
    } catch (e) {
      this.showError(toAppError(e));
    } finally {
      this.busy.set(false);
    }
  }
}
