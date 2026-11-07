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
import { AppError, describeError, toAppError } from '../../core/errors/app-error';
import { pickFile } from '../../core/dialog/native-dialog';
import { LogApi } from '../../core/log/log-api';
import {
  RemoteAuth,
  RemoteCredentials,
  RemoteHost,
  RemoteListing,
  SftpConfig,
} from '../../core/log/log.models';
import { SettingsService } from '../../core/settings/settings.service';
import { formatBytes } from '../../shared/format';
import { LogSessionService } from '../sessions/log-session.service';
import {
  RemoteForm,
  RemoteStep,
  applyHost,
  browseStart,
  checkRemoteForm,
  defaultSftpConfig,
  joinRemote,
  nextStep,
  parentPath,
  remoteFormOf,
  sftpAddress,
  sftpLabel,
  targetOf,
} from './remote-logic';

/** What a confirmation or a secret continues: opening the file or listing a folder. */
type Pending = { kind: 'open' } | { kind: 'list'; path: string };

/**
 * „Remote-Datei“ (prompt 017, `Cmd/Ctrl+Shift+H`): a log file on a server over SSH/SFTP, followed live into a
 * spool. Unknown host keys need an explicit confirmation of their fingerprint; a changed host key ends here with no
 * way around it. Passwords and passphrases are asked for here, kept in this dialog only while it is open and go into
 * the system keychain only when ticked.
 */
@Component({
  selector: 'app-remote-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog (close)="closed.emit()" aria-labelledby="remote-title">
      <form (submit)="submit($event)" novalidate>
        <h2 id="remote-title">Remote-Datei (SSH/SFTP)</h2>
        @if (saved().length) {
          <div class="saved" role="group" aria-label="Zuletzt geöffnete Remote-Dateien">
            <span class="dim">Zuletzt:</span>
            @for (s of saved(); track $index) {
              <button type="button" class="chip" (click)="use(s.config, s.keep)">
                {{ label(s.config) }}
              </button>
            }
          </div>
        }
        <label class="row">
          <span>Host</span>
          <input
            id="remote-host"
            type="text"
            list="remote-hosts"
            autocomplete="off"
            spellcheck="false"
            placeholder="server.example.com oder Eintrag aus ~/.ssh/config"
            [value]="form().host"
            [attr.aria-invalid]="!!shownErrors().host"
            aria-describedby="remote-host-note"
            (input)="patch({ host: value($event) })"
            (change)="hostChosen()"
          />
          <datalist id="remote-hosts">
            @for (h of hosts(); track h.alias) {
              <option [value]="h.alias">{{ h.hostName }}</option>
            }
          </datalist>
        </label>
        <p id="remote-host-note" class="dim note">
          @if (shownErrors().host; as message) {
            <span class="error">{{ message }}</span>
          } @else if (hostEntry(); as h) {
            @if (h.proxy) {
              <span class="error"
                >ProxyJump/ProxyCommand aus ~/.ssh/config wird nicht unterstützt.</span
              >
            } @else {
              Aus ~/.ssh/config: {{ h.hostName }}{{ h.user ? ', Benutzer ' + h.user : ''
              }}{{ h.port ? ', Port ' + h.port : '' }}
            }
          } @else {
            Nur SFTP, keine Shell. Bastion-Hosts (ProxyJump) gehen nicht.
          }
        </p>
        <div class="pair">
          <label class="row">
            <span>Benutzer</span>
            <input
              id="remote-user"
              type="text"
              autocomplete="off"
              spellcheck="false"
              placeholder="aus ~/.ssh/config bzw. lokal"
              [value]="form().user"
              [attr.aria-invalid]="!!shownErrors().user"
              (input)="patch({ user: value($event) })"
            />
          </label>
          <label class="row short">
            <span>Port</span>
            <input
              id="remote-port"
              type="number"
              min="1"
              max="65535"
              placeholder="22"
              [value]="form().port"
              [attr.aria-invalid]="!!shownErrors().port"
              (input)="patch({ port: value($event) })"
            />
          </label>
        </div>
        @if (shownErrors().user ?? shownErrors().port; as message) {
          <p class="error">{{ message }}</p>
        }
        <fieldset>
          <legend>Anmeldung</legend>
          @for (a of auths; track a.id) {
            <label>
              <input
                type="radio"
                name="remote-auth"
                [id]="'remote-auth-' + a.id"
                [value]="a.id"
                [checked]="form().auth === a.id"
                (change)="patch({ auth: a.id })"
              />
              {{ a.label }}
            </label>
          }
          @if (form().auth === 'key') {
            <div class="file">
              <input
                id="remote-key"
                type="text"
                spellcheck="false"
                placeholder="leer: IdentityFile aus ~/.ssh/config bzw. ~/.ssh/id_ed25519"
                aria-label="Schlüsseldatei"
                [value]="form().keyFile"
                [attr.aria-invalid]="!!shownErrors().keyFile"
                (input)="patch({ keyFile: value($event) })"
              />
              <button type="button" (click)="chooseKey()">Wählen …</button>
            </div>
            @if (shownErrors().keyFile; as message) {
              <p class="error">{{ message }}</p>
            }
          }
          <p class="dim note">
            Passwort und Passphrase werden beim Verbinden abgefragt und nur auf Wunsch im
            Schlüsselbund des Systems gespeichert, nie in Einstellungen oder Arbeitsstand.
            <button
              type="button"
              class="link"
              id="remote-forget"
              [disabled]="!target()"
              (click)="forget()"
            >
              Gespeichertes vergessen
            </button>
          </p>
        </fieldset>
        <label class="row">
          <span>Pfad</span>
          <input
            id="remote-path"
            type="text"
            spellcheck="false"
            placeholder="/var/log/app.log"
            [value]="form().path"
            [attr.aria-invalid]="!!shownErrors().path"
            (input)="patch({ path: value($event) })"
          />
          <button
            type="button"
            id="remote-browse"
            [disabled]="busy() || !target()"
            [attr.aria-expanded]="!!listing()"
            aria-controls="remote-listing"
            (click)="browse(browseFrom())"
          >
            Durchsuchen …
          </button>
        </label>
        @if (shownErrors().path; as message) {
          <p class="error">{{ message }}</p>
        }
        @if (listing(); as l) {
          <div
            id="remote-listing"
            class="listing"
            role="group"
            [attr.aria-label]="'Ordner ' + l.path"
          >
            <div class="where">
              <button
                type="button"
                class="up"
                [disabled]="l.path === '/' || busy()"
                (click)="browse(parent(l.path))"
              >
                ↑ Übergeordnet
              </button>
              <bdi class="mono">{{ l.path }}</bdi>
            </div>
            <ul>
              @for (e of l.entries; track e.name) {
                <li>
                  <button
                    type="button"
                    class="entry"
                    [class.dir]="e.dir"
                    [disabled]="busy()"
                    (click)="e.dir ? browse(join(l.path, e.name)) : choose(join(l.path, e.name))"
                  >
                    <span aria-hidden="true">{{ e.dir ? '▸' : '·' }}</span>
                    <bdi>{{ e.name }}</bdi>
                    @if (!e.dir && e.size !== null) {
                      <span class="dim size">{{ bytes(e.size) }}</span>
                    }
                  </button>
                </li>
              } @empty {
                <li class="dim">Leer</li>
              }
            </ul>
            @if (l.truncated) {
              <p class="dim note">Nur die ersten 10 000 Einträge.</p>
            }
          </div>
        }
        <fieldset>
          <legend>Start</legend>
          <label>
            <input
              type="radio"
              name="remote-start"
              id="remote-start-tail"
              [checked]="!form().whole"
              (change)="patch({ whole: false })"
            />
            Die letzten
            <input
              id="remote-start-mb"
              class="num"
              type="number"
              min="1"
              aria-label="Megabyte vom Ende"
              [value]="form().startMb"
              [disabled]="form().whole"
              (input)="patch({ startMb: value($event) })"
            />
            MB
          </label>
          <label>
            <input
              type="radio"
              name="remote-start"
              id="remote-start-whole"
              [checked]="form().whole"
              (change)="patch({ whole: true })"
            />
            Ganze Datei
          </label>
          <label>
            Prüfen alle
            <input
              id="remote-poll"
              class="num"
              type="number"
              min="200"
              step="100"
              aria-label="Intervall in Millisekunden"
              [value]="form().pollMs"
              (input)="patch({ pollMs: value($event) })"
            />
            ms
          </label>
          @if (shownErrors().startMb ?? shownErrors().pollMs; as message) {
            <p class="error">{{ message }}</p>
          }
        </fieldset>
        <label>
          <input
            id="remote-keep"
            type="checkbox"
            [checked]="keep()"
            (change)="keep.set(checked($event))"
          />
          Spool beim Schließen behalten
        </label>
        @if (step(); as st) {
          @switch (st.kind) {
            @case ('trust') {
              <div class="step" role="alert" id="remote-trust-box">
                <strong>Unbekannter Server.</strong> Der Host-Schlüssel von {{ address() }} ist
                weder in ~/.ssh/known_hosts noch in der Liste der App. Fingerabdruck mit dem des
                Servers vergleichen (z. B.
                <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> dort):
                <p class="mono print" id="remote-fingerprint">
                  {{ st.keyType }} {{ st.fingerprint }}
                </p>
                <div class="actions">
                  <button type="button" (click)="step.set(null)">Abbrechen</button>
                  <button
                    type="button"
                    id="remote-trust"
                    class="primary"
                    (click)="trust(st.fingerprint)"
                  >
                    Vertrauen und verbinden
                  </button>
                </div>
              </div>
            }
            @case ('changed') {
              <div class="step bad" role="alert" id="remote-changed">
                <strong>Host-Schlüssel abgelehnt – Verbindung abgebrochen.</strong> Er ist geändert,
                gesperrt oder sein Eintrag in known_hosts ist nicht verwendbar. Das kann ein Angriff
                (Man-in-the-Middle) sein oder ein neu aufgesetzter Server. Die App verbindet nicht,
                solange der Eintrag nicht von Hand geprüft und berichtigt ist.
                <p class="mono">{{ st.message }}</p>
              </div>
            }
            @case ('secret') {
              <div class="step" id="remote-secret-box">
                <label class="row">
                  <span>{{ st.secret === 'passphrase' ? 'Passphrase' : 'Passwort' }}</span>
                  <input
                    #secretInput
                    id="remote-secret"
                    type="password"
                    autocomplete="off"
                    [attr.aria-invalid]="st.wrong"
                    [attr.aria-describedby]="st.wrong ? 'remote-secret-wrong' : null"
                    [value]="secret()"
                    (input)="secret.set(value($event))"
                  />
                </label>
                @if (st.wrong) {
                  <p class="error" id="remote-secret-wrong">
                    {{
                      st.secret === 'passphrase'
                        ? 'Falsche Passphrase.'
                        : 'Passwort nicht angenommen.'
                    }}
                  </p>
                }
                <label>
                  <input
                    id="remote-remember"
                    type="checkbox"
                    [checked]="remember()"
                    (change)="remember.set(checked($event))"
                  />
                  Im Schlüsselbund des Systems merken
                </label>
              </div>
            }
            @case ('error') {
              <p class="error" role="alert">{{ st.message }}</p>
            }
          }
        }
        <div class="actions">
          <button type="button" (click)="dialog.close()">Abbrechen</button>
          <button
            id="remote-connect"
            type="submit"
            class="primary"
            [disabled]="busy() || !canSubmit()"
          >
            {{ busy() ? 'Verbinde …' : 'Verbinden' }}
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
      margin-bottom: 4px;
    }
    label.row > span {
      flex: none;
      width: 72px;
    }
    label.row > input {
      flex: 1;
      min-width: 0;
    }
    .pair {
      display: flex;
      gap: 12px;
    }
    .pair > label:first-child {
      flex: 1;
    }
    label.short > span {
      width: auto;
    }
    label.short > input {
      width: 80px;
      flex: none;
    }
    .num {
      width: 72px;
    }
    .file {
      display: flex;
      gap: 6px;
      margin: 2px 0 4px 22px;
    }
    .file input {
      flex: 1;
      min-width: 0;
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
    .mono {
      font-family: var(--font-mono);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .print {
      margin: 6px 0;
      padding: 4px 6px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      color: var(--text);
      user-select: all;
    }
    .listing {
      margin: 0 0 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    .where {
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 4px 6px;
      border-bottom: 1px solid var(--border);
    }
    .listing ul {
      max-height: 180px;
      margin: 0;
      padding: 2px 0;
      overflow: auto;
      list-style: none;
    }
    .entry {
      display: flex;
      gap: 6px;
      width: 100%;
      padding: 2px 8px;
      border: 0;
      background: none;
      color: var(--text);
      font-family: var(--font-mono);
      font-size: 12px;
      text-align: left;
    }
    .entry:hover {
      background: var(--bg-hover);
    }
    .entry.dir {
      font-weight: 600;
    }
    .size {
      margin-left: auto;
    }
    .step {
      margin: 8px 0;
      padding: 8px 10px;
      border: 1px solid var(--lv-warn-fg);
      border-radius: var(--radius);
      font-size: 12px;
    }
    .step.bad {
      border-color: var(--danger);
      color: var(--danger);
    }
    .error {
      margin: 2px 0 8px;
      color: var(--danger);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .link {
      padding: 0;
      border: 0;
      background: none;
      color: var(--accent);
      font-size: 11.5px;
      text-decoration: underline;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 10px;
    }
    .primary {
      background: var(--accent);
      color: var(--accent-text);
      font-weight: 600;
    }
  `,
})
export class RemoteDialogComponent implements OnInit, OnDestroy {
  private readonly api = inject(LogApi);
  private readonly sessions = inject(LogSessionService);
  private readonly settings = inject(SettingsService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  /** A configuration to start from (a remembered connection, a workspace). */
  readonly start = input<SftpConfig | null>(null);
  /** The error that opened the dialog (a workspace could not connect without asking). */
  readonly startError = input<AppError | null>(null);
  readonly closed = output<void>();

  protected readonly auths: readonly { id: RemoteAuth; label: string }[] = [
    { id: 'agent', label: 'SSH-Agent' },
    { id: 'key', label: 'Schlüsseldatei' },
    { id: 'password', label: 'Passwort' },
  ];
  protected readonly label = sftpLabel;
  protected readonly bytes = formatBytes;
  protected readonly parent = parentPath;
  protected readonly join = joinRemote;

  protected readonly form = signal<RemoteForm>(remoteFormOf(defaultSftpConfig()));
  protected readonly keep = signal(false);
  protected readonly busy = signal(false);
  protected readonly hosts = signal<RemoteHost[]>([]);
  protected readonly listing = signal<RemoteListing | null>(null);
  protected readonly step = signal<RemoteStep | null>(null);
  /** The secret as typed; only here, only while the dialog is open. */
  protected readonly secret = signal('');
  protected readonly remember = signal(false);
  /** Errors show once a field was touched or a connect was tried. */
  private readonly touched = signal(false);
  private trusted: string | null = null;
  private pending: Pending = { kind: 'open' };

  protected readonly saved = computed(() =>
    this.settings
      .settings()
      .savedSources.filter(
        (s): s is { config: SftpConfig; keep: boolean } => s.config.kind === 'sftp',
      ),
  );
  protected readonly check = computed(() => checkRemoteForm(this.form()));
  protected readonly shownErrors = computed(() => (this.touched() ? this.check().errors : {}));
  protected readonly target = computed(() => targetOf(this.form()));
  protected readonly address = computed(() => {
    const t = this.target();
    return t ? sftpAddress(t) : this.form().host;
  });
  protected readonly hostEntry = computed(() =>
    this.hosts().find((h) => h.alias.toLowerCase() === this.form().host.trim().toLowerCase()),
  );
  protected readonly browseFrom = computed(() => browseStart(this.form().path));
  protected readonly canSubmit = computed(() => {
    const step = this.step()?.kind;
    if (step === 'changed' || step === 'trust') return false;
    if (step === 'secret' && this.pending.kind === 'list') return this.target() !== null;
    return this.check().config !== null;
  });

  ngOnInit(): void {
    const start = this.start();
    if (start) this.use(start, false);
    const error = this.startError();
    if (error) this.step.set(nextStep(error));
    this.dialog().nativeElement.showModal();
    this.api
      .remoteHosts()
      .then((hosts) => this.hosts.set(hosts))
      .catch(() => this.hosts.set([]));
  }

  ngOnDestroy(): void {
    this.secret.set('');
  }

  protected patch(change: Partial<RemoteForm>): void {
    const before = this.form();
    this.form.update((f) => ({ ...f, ...change }));
    this.touched.set(true);
    // Another server or login: a confirmation or a secret no longer applies.
    if (
      change.host !== undefined ||
      change.port !== undefined ||
      change.user !== undefined ||
      change.auth !== undefined ||
      change.keyFile !== undefined
    ) {
      const after = this.form();
      if (
        after.host !== before.host ||
        after.port !== before.port ||
        after.user !== before.user ||
        after.auth !== before.auth ||
        after.keyFile !== before.keyFile
      ) {
        this.trusted = null;
        this.secret.set('');
        this.step.set(null);
        this.listing.set(null);
      }
    }
  }

  protected use(config: SftpConfig, keep: boolean): void {
    this.form.set(remoteFormOf(config));
    this.keep.set(keep);
    this.trusted = null;
    this.secret.set('');
    this.step.set(null);
    this.listing.set(null);
  }

  /** A host of `~/.ssh/config` was chosen: its user and port where the form has none. */
  protected hostChosen(): void {
    this.form.update((f) => applyHost(f, this.hostEntry()));
  }

  protected async chooseKey(): Promise<void> {
    const path = await pickFile('Schlüsseldatei wählen');
    if (path) this.patch({ keyFile: path });
  }

  protected async forget(): Promise<void> {
    const target = this.target();
    if (!target) return;
    try {
      await this.api.forgetRemoteSecret(target);
      this.step.set({ kind: 'error', message: 'Gespeichertes Passwort bzw. Passphrase entfernt.' });
    } catch (e) {
      this.step.set({ kind: 'error', message: describeError(toAppError(e)) });
    }
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  private credentials(): RemoteCredentials {
    const creds: RemoteCredentials = {};
    // A typed secret stays for the next step (a host key to confirm after it), never longer than the dialog.
    if (this.secret()) {
      creds.secret = this.secret();
      creds.remember = this.remember();
    }
    if (this.trusted) creds.trustFingerprint = this.trusted;
    return creds;
  }

  protected trust(fingerprint: string): void {
    this.trusted = fingerprint;
    this.step.set(null);
    void this.run(this.pending);
  }

  protected browse(path: string): void {
    void this.run({ kind: 'list', path });
  }

  protected choose(path: string): void {
    this.patch({ path });
    this.listing.set(null);
  }

  protected submit(event: Event): void {
    event.preventDefault();
    this.touched.set(true);
    // A secret asked for while browsing continues the browsing.
    if (this.step()?.kind === 'secret' && this.pending.kind === 'list') {
      void this.run(this.pending);
      return;
    }
    if (!this.check().config) return;
    void this.run({ kind: 'open' });
  }

  private async run(action: Pending): Promise<void> {
    if (this.busy()) return;
    const target = this.target();
    if (!target) return;
    this.pending = action;
    const creds = this.credentials();
    this.busy.set(true);
    try {
      if (action.kind === 'list') {
        this.listing.set(await this.api.remoteListDir(target, creds, action.path));
        this.step.set(null);
        this.secret.set('');
      } else {
        const config = this.check().config;
        if (!config) return;
        const error = await this.sessions.openSource(config, this.keep(), creds);
        if (error) {
          this.fail(error);
        } else {
          this.secret.set('');
          this.dialog().nativeElement.close();
        }
      }
    } catch (e) {
      this.fail(toAppError(e));
    } finally {
      this.busy.set(false);
    }
  }

  private fail(error: AppError): void {
    const next = nextStep(error);
    // A secret that was not accepted is typed again, never reused.
    if (next.kind === 'secret') this.secret.set('');
    this.step.set(next);
    if (next.kind === 'secret') {
      queueMicrotask(() => document.getElementById('remote-secret')?.focus());
    } else if (next.kind === 'trust') {
      queueMicrotask(() => document.getElementById('remote-trust')?.focus());
    }
  }
}
