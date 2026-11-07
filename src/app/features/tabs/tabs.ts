import { ChangeDetectionStrategy, Component, inject, output } from '@angular/core';
import { SessionMarksComponent } from '../../shared/session-marks';
import { LogSessionService } from '../sessions/log-session.service';

@Component({
  selector: 'app-tabs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SessionMarksComponent],
  template: `
    <div class="tabs" role="tablist" aria-label="Geöffnete Dateien">
      @for (session of sessions.sessions(); track session.id) {
        <div class="tab" [class.active]="session.id === sessions.activeId()">
          <button
            type="button"
            class="title"
            role="tab"
            [attr.aria-selected]="session.id === sessions.activeId()"
            [title]="session.title"
            (click)="sessions.activate(session.id)"
          >
            <app-session-marks [session]="session" />
            {{ session.fileName }}
          </button>
          <button
            type="button"
            class="close"
            [attr.aria-label]="session.fileName + ' schließen'"
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
  readonly openFile = output<void>();
  readonly openPath = output<void>();
  readonly merge = output<void>();
}
