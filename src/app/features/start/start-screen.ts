import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import { SettingsService } from '../../core/settings/settings.service';
import { baseName } from '../../shared/format';
import { LogSessionService } from '../sessions/log-session.service';
import { isWorkspacePath } from '../workspace/workspace-model';
import { sourceLabel } from '../sources/source-logic';
import { sftpAddress } from '../remote/remote-logic';
import { wineventWhere } from '../winevent/winevent-logic';
import { dbWhere } from '../database/database-logic';

@Component({
  selector: 'app-start-screen',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card">
      <h1>Log Commander</h1>
      <p class="lead">Logdateien live verfolgen, filtern und durchsuchen.</p>
      <div class="actions">
        <button type="button" class="primary" (click)="openFile.emit()">Datei öffnen …</button>
        <button type="button" class="secondary" (click)="openPath.emit()">Pfad eingeben …</button>
        <button type="button" class="secondary" (click)="merge.emit()">
          Dateien zusammenführen …
        </button>
        <button type="button" class="secondary" (click)="openSource.emit()">Quelle öffnen …</button>
        <button type="button" class="secondary" (click)="openRemote.emit()">Remote-Datei …</button>
        <button type="button" class="secondary" (click)="openWorkspace.emit()">
          Arbeitsstand öffnen …
        </button>
      </div>
      <p class="hint">
        oder Datei ins Fenster ziehen · ⌘/Strg+O · Pfad: ⌘/Strg+⇧+O · Zusammenführen: ⌘/Strg+⇧+M ·
        Quelle (Syslog): ⌘/Strg+⇧+L · Remote (SSH/SFTP): ⌘/Strg+⇧+H
      </p>
      @if (sourcesShown()) {
        <h2>Quellen</h2>
        <ul>
          @for (s of settings().savedSources; track $index) {
            @if (s.config.kind !== 'winevent' || sessions.wineventSupported()) {
              <li>
                @if (s.config.kind === 'sftp') {
                  <!-- Prompt 017: opens the dialog prefilled, connects only from there. -->
                  <button
                    type="button"
                    class="recent"
                    title="Im Dialog „Remote-Datei“ prüfen und verbinden"
                    (click)="sessions.remoteRequest.set({ config: s.config })"
                  >
                    <span class="name"
                      ><span class="ws" aria-hidden="true">⇅</span
                      ><span class="sr-only">Remote-Datei: </span>{{ sourceLabel(s.config) }}</span
                    >
                    <span class="dir">{{ address(s.config) }} · SSH/SFTP</span>
                  </button>
                } @else if (s.config.kind === 'database') {
                  <!-- Prompt 019: opens the dialog prefilled, connects only from there. -->
                  <button
                    type="button"
                    class="recent"
                    title="Im Dialog „Datenbank“ prüfen und öffnen"
                    (click)="sessions.databaseRequest.set({ config: s.config })"
                  >
                    <span class="name"
                      ><span class="ws" aria-hidden="true">⛁</span
                      ><span class="sr-only">Datenbank: </span>{{ sourceLabel(s.config) }}</span
                    >
                    <span class="dir">{{ dbWhere(s.config) }}</span>
                  </button>
                } @else if (s.config.kind === 'winevent') {
                  <!-- Prompt 018: opens the dialog prefilled; only listed on Windows. -->
                  <button
                    type="button"
                    class="recent"
                    title="Im Dialog „Windows-Ereignisse“ prüfen und öffnen"
                    (click)="sessions.wineventRequest.set({ config: s.config })"
                  >
                    <span class="name"
                      ><span class="ws" aria-hidden="true">⊞</span
                      ><span class="sr-only">Windows-Ereignisse: </span
                      >{{ sourceLabel(s.config) }}</span
                    >
                    <span class="dir">{{ where(s.config) }}</span>
                  </button>
                } @else {
                  <button
                    type="button"
                    class="recent"
                    title="Im Dialog „Quelle öffnen“ prüfen und starten"
                    (click)="sessions.sourceRequest.set({ config: s.config })"
                  >
                    <span class="name"
                      ><span class="ws" aria-hidden="true">⇣</span
                      ><span class="sr-only">Quelle: </span>{{ sourceLabel(s.config) }}</span
                    >
                    <span class="dir"
                      >{{ s.config.address
                      }}{{ s.config.allow.length ? ' · mit Absender-Filter' : '' }}</span
                    >
                  </button>
                }
                <button
                  type="button"
                  class="forget"
                  [attr.aria-label]="sourceLabel(s.config) + ' aus der Liste entfernen'"
                  title="Aus der Liste entfernen"
                  (click)="forgetSource($index)"
                >
                  ×
                </button>
              </li>
            }
          }
        </ul>
      }
      @if (settings().recentFiles.length) {
        <h2>Zuletzt geöffnet</h2>
        <ul>
          @for (path of settings().recentFiles; track path) {
            <li>
              <button type="button" class="recent" [title]="path" (click)="sessions.open(path)">
                <span class="name">
                  @if (isWorkspace(path)) {
                    <span class="ws" aria-hidden="true">❖</span
                    ><span class="sr-only">Arbeitsstand: </span>
                  }
                  {{ baseName(path) }}</span
                >
                <span class="dir">{{ path }}</span>
              </button>
              <button
                type="button"
                class="forget"
                [attr.aria-label]="baseName(path) + ' aus der Liste entfernen'"
                title="Aus der Liste entfernen"
                (click)="forget(path)"
              >
                ×
              </button>
            </li>
          }
        </ul>
      }
    </div>
  `,
  styles: `
    :host {
      display: grid;
      place-items: center;
      overflow: auto;
      padding: 24px;
    }
    .card {
      width: min(560px, 100%);
    }
    h1 {
      margin: 0;
      font-size: 22px;
      font-weight: 600;
    }
    .lead {
      margin: 4px 0 18px;
      color: var(--text-dim);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .secondary {
      padding: 7px 16px;
      border: 1px solid var(--border);
    }
    .primary {
      padding: 7px 16px;
      background: var(--accent);
      color: var(--accent-text);
      font-weight: 600;
    }
    .primary:hover {
      background: var(--accent);
      filter: brightness(1.1);
    }
    .hint {
      margin: 8px 0 0;
      color: var(--text-dim);
      font-size: 12px;
    }
    h2 {
      margin: 28px 0 6px;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-dim);
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    li {
      display: flex;
      align-items: center;
    }
    .recent {
      display: flex;
      flex: 1;
      min-width: 0;
      flex-direction: column;
      padding: 5px 8px;
      text-align: left;
    }
    .name {
      font-weight: 500;
    }
    .dir {
      width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--text-dim);
      font-size: 11.5px;
    }
    .forget {
      color: var(--text-dim);
    }
    .ws {
      margin-right: 5px;
      color: var(--accent);
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
  `,
})
export class StartScreenComponent {
  private readonly settingsService = inject(SettingsService);
  protected readonly settings = this.settingsService.settings;
  protected readonly sessions = inject(LogSessionService);
  /** Prompt 018: Windows event sources only where they can be opened. */
  protected readonly sourcesShown = computed(() =>
    this.settings().savedSources.some(
      (s) => s.config.kind !== 'winevent' || this.sessions.wineventSupported(),
    ),
  );
  protected readonly baseName = baseName;
  readonly openFile = output<void>();
  readonly openPath = output<void>();
  readonly merge = output<void>();
  readonly openWorkspace = output<void>();
  readonly openSource = output<void>();
  readonly openRemote = output<void>();
  protected readonly isWorkspace = isWorkspacePath;
  protected readonly sourceLabel = sourceLabel;
  protected readonly address = sftpAddress;
  protected readonly where = wineventWhere;
  protected readonly dbWhere = dbWhere;

  protected forget(path: string): void {
    this.settingsService.removeRecentFile(path);
  }

  protected forgetSource(index: number): void {
    this.settingsService.update({
      savedSources: this.settings().savedSources.filter((_, i) => i !== index),
    });
  }
}
