import { ChangeDetectionStrategy, Component, inject, output } from '@angular/core';
import { SessionMarksComponent } from '../../shared/session-marks';
import { LogSessionService } from '../sessions/log-session.service';
import { WorkspaceService } from '../workspace/workspace.service';

@Component({
  selector: 'app-tabs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SessionMarksComponent],
  template: `
    <div class="tabs" role="tablist" aria-label="Geöffnete Dateien">
      @for (session of sessions.sessions(); track session.id) {
        <div
          class="tab"
          [class.active]="session.id === sessions.activeId()"
          [class.view]="session.viewId !== 0"
        >
          <button
            type="button"
            class="title"
            role="tab"
            [attr.aria-selected]="session.id === sessions.activeId()"
            [title]="session.tabTitle()"
            (click)="sessions.activate(session.id)"
          >
            @if (session.viewId !== 0) {
              <!-- A filter tab (prompt 013): it filters the tab to its left further. -->
              <span class="chain" aria-hidden="true">↳</span>
            }
            @if (session.isSource && session.viewId === 0) {
              @if (session.source?.kind === 'sftp') {
                <!-- Prompt 017: a file on a server, pulled over SFTP into a spool. -->
                <span class="src" role="img" aria-label="Remote-Datei" title="Über SSH/SFTP (Spool)"
                  >⇅</span
                >
              } @else {
                <!-- A source without a file (prompt 016): received, not read from a file. -->
                <span class="src" role="img" aria-label="Quelle" title="Empfangen (Spool)">⇣</span>
              }
            }
            <app-session-marks [session]="session" />
            {{ session.tabLabel() }}
          </button>
          <button
            type="button"
            class="close"
            [attr.aria-label]="session.tabLabel() + ' schließen'"
            title="Schließen (⌘/Strg+W)"
            (click)="sessions.close(session.id)"
          >
            ×
          </button>
        </div>
      }
    </div>
    <button type="button" class="open" title="Datei öffnen (⌘/Strg+O)" (click)="openFile.emit()">
      ＋
    </button>
    <button
      type="button"
      class="open"
      title="Pfad eingeben und öffnen (⌘/Strg+⇧+O)"
      (click)="openPath.emit()"
    >
      Pfad …
    </button>
    <button
      type="button"
      class="open"
      title="Mehrere Dateien nach Zeit zusammenführen (⌘/Strg+⇧+M)"
      (click)="merge.emit()"
    >
      Zusammenführen …
    </button>
    <button
      type="button"
      class="open"
      title="Syslog über UDP/TCP empfangen (⌘/Strg+⇧+L)"
      (click)="openSource.emit()"
    >
      Quelle …
    </button>
    <button
      type="button"
      class="open"
      title="Logdatei auf einem Server über SSH/SFTP live verfolgen (⌘/Strg+⇧+H)"
      (click)="openRemote.emit()"
    >
      Remote …
    </button>
    @if (sessions.sessions().length) {
      <button
        type="button"
        class="open workspace-save"
        title="Arbeitsstand speichern: Dateien, Filter-Tabs, Lesezeichen, Notizen, Layout (Datei → Save Workspace…)"
        [disabled]="workspace.busy()"
        (click)="workspace.save()"
      >
        ❖ Speichern …
      </button>
    }
  `,
  styles: `
    :host {
      display: flex;
      align-items: stretch;
      height: 32px;
      background: var(--bg-app);
      border-bottom: 1px solid var(--border);
      font-size: 12px;
    }
    .tabs {
      display: flex;
      min-width: 0;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .tab {
      display: flex;
      align-items: center;
      flex: none;
      max-width: 240px;
      border-right: 1px solid var(--border);
      color: var(--text-dim);
    }
    .tab.view {
      max-width: 300px;
      border-left: 1px dashed var(--text-dim);
    }
    .chain {
      color: var(--text-dim);
    }
    .src {
      color: var(--accent);
    }
    .tab.active {
      background: var(--bg-panel);
      color: var(--text);
      box-shadow: inset 0 2px 0 var(--accent);
    }
    .title {
      display: flex;
      align-items: center;
      gap: 6px;
      height: 100%;
      min-width: 0;
      border-radius: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .close {
      padding: 0 6px;
      margin-right: 4px;
      color: var(--text-dim);
    }
    .open {
      flex: none;
      border-radius: 0;
      padding: 0 12px;
    }
  `,
})
export class TabsComponent {
  protected readonly sessions = inject(LogSessionService);
  protected readonly workspace = inject(WorkspaceService);
  readonly openFile = output<void>();
  readonly openPath = output<void>();
  readonly merge = output<void>();
  readonly openSource = output<void>();
  readonly openRemote = output<void>();
}
