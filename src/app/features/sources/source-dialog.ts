import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { describeError, toAppError } from '../../core/errors/app-error';
import { SourceConfig, SyslogConfig, SyslogProtocol } from '../../core/log/log.models';
import { SettingsService } from '../../core/settings/settings.service';
import { LogSessionService } from '../sessions/log-session.service';
import {
  DEFAULT_SYSLOG_PORT,
  SyslogForm,
  checkSyslogForm,
  defaultSyslogConfig,
  formOf,
  isIpAddress,
  isLoopbackAddress,
  portNeedsPrivileges,
  sourceLabel,
} from './source-logic';

/** Addresses offered in the list; anything else is typed. */
const ADDRESSES: readonly { value: string; label: string }[] = [
  { value: '127.0.0.1', label: 'Nur dieser Rechner (127.0.0.1)' },
  { value: '::1', label: 'Nur dieser Rechner, IPv6 (::1)' },
  { value: '0.0.0.0', label: 'Alle Netzwerkschnittstellen, IPv4 (0.0.0.0)' },
  { value: '::', label: 'Alle Netzwerkschnittstellen, IPv4 und IPv6 (::)' },
];
const OTHER = 'other';

/**
 * „Quelle öffnen“ (prompt 016, `Cmd/Ctrl+Shift+L`): a source without a file. For now syslog over UDP/TCP; 017–019
 * add their kinds here. Listens on this computer only unless chosen otherwise, with a visible warning.
 */
@Component({
  selector: 'app-source-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog (close)="closed.emit()" aria-labelledby="source-title">
      <form (submit)="submit($event)" novalidate>
        <h2 id="source-title">Quelle öffnen</h2>
        @if (saved().length) {
          <div class="saved" role="group" aria-label="Zuletzt geöffnete Quellen">
            <span class="dim">Zuletzt:</span>
            @for (s of saved(); track $index) {
              <button type="button" class="chip" (click)="useSaved(s.config, s.keep)">
                {{ label(s.config) }}
              </button>
            }
          </div>
        }
        <label class="row">
          <span>Art</span>
          <select id="source-kind" (change)="chooseKind($event)">
            <option value="syslog" selected>Syslog (UDP/TCP)</option>
            <option value="sftp">Remote-Datei (SSH/SFTP) …</option>
            @if (sessions.wineventSupported()) {
              <!-- Prompt 018: only on Windows; elsewhere the kind does not show. -->
              <option value="winevent">Windows-Ereignisse …</option>
            }
          </select>
        </label>
        <fieldset>
          <legend>Protokoll</legend>
          @for (p of protocols; track p.id) {
            <label>
              <input
                type="radio"
                name="protocol"
                [value]="p.id"
                [checked]="form().protocol === p.id"
                (change)="patch({ protocol: p.id })"
              />
              {{ p.label }}
            </label>
          }
          <p class="dim note">
            RFC 3164 und 5424; TCP mit Octet-Counting oder Zeilenumbruch. Kein TLS.
          </p>
        </fieldset>
        <label class="row">
          <span>Adresse</span>
          <select id="source-address" (change)="chooseAddress($event)">
            @for (a of addresses; track a.value) {
              <option [value]="a.value" [selected]="addressChoice() === a.value">
                {{ a.label }}
              </option>
            }
            <option [value]="other" [selected]="addressChoice() === other">Andere Adresse …</option>
          </select>
        </label>
        @if (addressChoice() === other) {
          <label class="row">
            <span>IP-Adresse</span>
            <input
              id="source-address-other"
              type="text"
              autocomplete="off"
              spellcheck="false"
              [value]="form().address"
              [attr.aria-invalid]="!!check().errors.address"
              aria-describedby="source-address-error"
              (input)="patch({ address: value($event) })"
            />
          </label>
        }
        @if (check().errors.address; as message) {
          <p id="source-address-error" class="error">{{ message }}</p>
        }
        <label class="row">
          <span>Port</span>
          <input
            id="source-port"
            type="number"
            min="1"
            max="65535"
            [value]="form().port"
            [attr.aria-invalid]="!!check().errors.port"
            aria-describedby="source-port-note"
            (input)="patch({ port: value($event) })"
          />
        </label>
        <p id="source-port-note" class="dim note" [class.warn]="privileged()">
          @if (check().errors.port; as message) {
            <span class="error">{{ message }}</span>
          } @else if (privileged()) {
            Ports unter 1024 (z. B. 514) brauchen Administrator- bzw. Root-Rechte; ohne sie
            scheitert das Lauschen. Üblich ist {{ defaultPort }}, dorthin kann der Sender oder ein
            lokaler Weiterleiter schicken.
          } @else {
            Standard {{ defaultPort }}; 514 bräuchte Administrator- bzw. Root-Rechte.
          }
        </p>
        @if (remote()) {
          <div class="remote" role="note" id="source-remote-warning">
            <strong>Achtung:</strong> Auf dieser Adresse erreichen auch andere Rechner im Netz den
            Port. Ohne Absender-Filter nimmt er alles an, was ihn erreicht, und schreibt es in den
            Spool. macOS bzw. Windows fragen beim ersten Lauschen nach einer Freigabe in der
            Firewall.
            <label>
              <input
                id="source-allow-remote"
                type="checkbox"
                [checked]="form().allowRemote"
                aria-describedby="source-remote-warning"
                (change)="patch({ allowRemote: checked($event) })"
              />
              Lauschen über diesen Rechner hinaus erlauben
            </label>
          </div>
        }
        <label class="block" for="source-allow">Absender-Filter (optional)</label>
        <textarea
          id="source-allow"
          rows="3"
          spellcheck="false"
          placeholder="10.0.0.0/8&#10;192.168.1.20"
          [value]="form().allowText"
          [attr.aria-invalid]="!!check().errors.allow"
          aria-describedby="source-allow-note"
          (input)="patch({ allowText: value($event) })"
        ></textarea>
        <p id="source-allow-note" class="dim note">
          @if (check().errors.allow; as message) {
            <span class="error">{{ message }}</span>
          } @else {
            Eine Adresse oder ein Netz je Zeile. Leer: jeder Absender, der den Port erreicht. Bei
            UDP lässt sich der Absender fälschen: der Filter ist keine Authentifizierung.
          }
        </p>
        <label>
          <input
            id="source-keep"
            type="checkbox"
            [checked]="keep()"
            (change)="keep.set(checked($event))"
          />
          Spool beim Schließen behalten
        </label>
        <p class="dim note">
          Meldungen landen in einer Spool-Datei im Cache-Ordner (je Quelle höchstens
          {{ limit() }}, die älteste Datei fällt weg) und werden wie eine Datei angezeigt. Ohne
          „Behalten“ wird der Spool beim Schließen gelöscht.
        </p>
        @if (error(); as message) {
          <p class="error" role="alert">{{ message }}</p>
        }
        <div class="actions">
          <button type="button" (click)="dialog.close()">Abbrechen</button>
          <button
            id="source-start"
            type="submit"
            class="primary"
            [disabled]="busy() || !check().config"
          >
            Starten
          </button>
        </div>
      </form>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(500px, 92vw);
      max-height: 92vh;
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
    label.block {
      display: block;
      font-weight: 600;
      font-size: 12px;
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      font-family: var(--font-mono);
      font-size: 12px;
      resize: vertical;
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
    .warn {
      color: var(--lv-warn-fg);
    }
    .remote {
      margin: 0 0 10px;
      padding: 8px 10px;
      border: 1px solid var(--lv-warn-fg);
      border-radius: var(--radius);
      color: var(--lv-warn-fg);
      font-size: 12px;
    }
    .remote label {
      margin-top: 6px;
      color: var(--text);
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
export class SourceDialogComponent implements OnInit {
  protected readonly sessions = inject(LogSessionService);
  private readonly settings = inject(SettingsService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  /** A configuration to start from (a remembered source); otherwise the defaults. */
  readonly start = input<SourceConfig | null>(null);
  readonly closed = output<void>();

  protected readonly protocols: readonly { id: SyslogProtocol; label: string }[] = [
    { id: 'udp', label: 'UDP' },
    { id: 'tcp', label: 'TCP' },
    { id: 'both', label: 'UDP und TCP' },
  ];
  protected readonly addresses = ADDRESSES;
  protected readonly other = OTHER;
  protected readonly defaultPort = DEFAULT_SYSLOG_PORT;
  protected readonly label = sourceLabel;

  protected readonly form = signal<SyslogForm>(formOf(defaultSyslogConfig()));
  protected readonly keep = signal(false);
  /** „Andere Adresse …“ was chosen (the typed address may still match a preset). */
  private readonly customAddress = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly saved = computed(() =>
    this.settings
      .settings()
      .savedSources.filter(
        (s): s is { config: SyslogConfig; keep: boolean } => s.config.kind === 'syslog',
      ),
  );
  protected readonly limit = computed(() => {
    const mb = this.settings.settings().spoolLimitMb;
    return mb >= 1024 ? `${(mb / 1024).toLocaleString('de-DE')} GB` : `${mb} MB`;
  });

  protected readonly check = computed(() => checkSyslogForm(this.form()));
  protected readonly addressChoice = computed(() => {
    const address = this.form().address.trim();
    return !this.customAddress() && ADDRESSES.some((a) => a.value === address) ? address : OTHER;
  });
  protected readonly remote = computed(() => {
    const address = this.form().address.trim();
    return isIpAddress(address) && !isLoopbackAddress(address);
  });
  protected readonly privileged = computed(() => portNeedsPrivileges(Number(this.form().port)));

  ngOnInit(): void {
    const start = this.start();
    if (start) this.useSaved(start, false);
    this.dialog().nativeElement.showModal();
  }

  protected patch(change: Partial<SyslogForm>): void {
    this.form.update((f) => ({ ...f, ...change }));
    this.error.set(null);
  }

  /** Prompt 017: a remote file has a dialog of its own; 018: Windows events too. */
  protected chooseKind(event: Event): void {
    const kind = (event.target as HTMLSelectElement).value;
    if (kind === 'sftp') {
      this.dialog().nativeElement.close();
      this.sessions.remoteRequest.set({ config: null });
    } else if (kind === 'winevent' && this.sessions.wineventSupported()) {
      this.dialog().nativeElement.close();
      this.sessions.wineventRequest.set({ config: null });
    }
  }

  protected useSaved(config: SourceConfig, keep: boolean): void {
    if (config.kind !== 'syslog') return;
    this.form.set(formOf(config));
    this.customAddress.set(!ADDRESSES.some((a) => a.value === config.address));
    this.keep.set(keep);
    this.error.set(null);
  }

  protected chooseAddress(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (value === OTHER) {
      this.customAddress.set(true);
      return;
    }
    this.customAddress.set(false);
    // A new choice of address asks again before listening beyond this computer.
    this.patch({ address: value, allowRemote: false });
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    const config = this.check().config;
    if (!config || this.busy()) return;
    this.busy.set(true);
    try {
      const error = await this.sessions.openSource(config, this.keep());
      if (error) this.error.set(describeError(error));
      else this.dialog().nativeElement.close();
    } catch (e) {
      this.error.set(describeError(toAppError(e)));
    } finally {
      this.busy.set(false);
    }
  }
}
