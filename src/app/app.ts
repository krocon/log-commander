import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getMatches } from '@tauri-apps/plugin-cli';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { SettingsService } from './core/settings/settings.service';
import { LogViewComponent } from './features/log-view/log-view';
import { OpenPathDialogComponent } from './features/open-path/open-path-dialog';
import { LogSessionService } from './features/sessions/log-session.service';
import { SettingsDialogComponent } from './features/settings/settings-dialog';
import { StartScreenComponent } from './features/start/start-screen';
import { StatusBarComponent } from './features/statusbar/status-bar';
import { TabsComponent } from './features/tabs/tabs';
import { ToolbarComponent } from './features/toolbar/toolbar';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    LogViewComponent,
    OpenPathDialogComponent,
    SettingsDialogComponent,
    StartScreenComponent,
    StatusBarComponent,
    TabsComponent,
    ToolbarComponent,
  ],
  template: `
    <app-tabs (openFile)="openFile()" (openPath)="pathDialogOpen.set(true)" />
    <app-toolbar (openSettings)="settingsOpen.set(true)" />
    @if (active(); as session) {
      <app-log-view class="main" [session]="session" />
    } @else {
      <app-start-screen
        class="main"
        (openFile)="openFile()"
        (openPath)="pathDialogOpen.set(true)"
      />
    }
    <app-status-bar />
    @if (sessions.error(); as error) {
      <div class="error" role="alert">
        <span>{{ error }}</span>
        <button type="button" aria-label="Meldung schließen" (click)="sessions.error.set(null)">
          ×
        </button>
      </div>
    }
    @if (dropActive()) {
      <div class="drop" aria-hidden="true"><span>Datei hier ablegen</span></div>
    }
    @if (settingsOpen()) {
      <app-settings-dialog (closed)="settingsOpen.set(false)" />
    }
    @if (pathDialogOpen()) {
      <app-open-path-dialog (closed)="pathDialogOpen.set(false)" />
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      height: 100vh;
    }
    .main {
      flex: 1;
      min-height: 0;
    }
    .error {
      position: fixed;
      left: 50%;
      bottom: 38px;
      transform: translateX(-50%);
      z-index: 5;
      display: flex;
      align-items: center;
      gap: 10px;
      max-width: 80vw;
      padding: 7px 8px 7px 14px;
      background: var(--lv-fatal-bg);
      color: var(--lv-fatal-fg);
      border-radius: var(--radius);
      box-shadow: 0 4px 16px rgb(0 0 0 / 40%);
    }
    .drop {
      position: fixed;
      inset: 8px;
      z-index: 6;
      display: grid;
      place-items: center;
      border: 2px dashed var(--accent);
      border-radius: 10px;
      background: color-mix(in srgb, var(--bg-app) 80%, transparent);
      font-size: 18px;
      pointer-events: none;
    }
  `,
})
export class App implements OnInit, OnDestroy {
  protected readonly sessions = inject(LogSessionService);
  private readonly settings = inject(SettingsService);

  protected readonly active = computed(() => this.sessions.active());
  protected readonly settingsOpen = signal(false);
  protected readonly pathDialogOpen = signal(false);
  protected readonly dropActive = signal(false);
  private dialogOpen = false;
  private readonly cleanups: (() => void)[] = [];

  constructor() {
    if (isTauri()) {
      effect(() => {
        const name = this.active()?.fileName;
        void getCurrentWindow()
          .setTitle(name ? `${name} – Log Commander` : 'Log Commander')
          .catch(() => undefined);
      });
    }
  }

  async ngOnInit(): Promise<void> {
    document.addEventListener('keydown', this.onKey);
    await this.settings.load();
    if (!isTauri()) return;
    await this.sessions.refreshProfiles();
    this.cleanups.push(await listen('menu-open', () => this.openFile()));
    this.cleanups.push(await listen('menu-open-path', () => this.pathDialogOpen.set(true)));
    this.cleanups.push(
      await getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === 'enter' || payload.type === 'over') {
          this.dropActive.set(true);
        } else if (payload.type === 'leave') {
          this.dropActive.set(false);
        } else {
          this.dropActive.set(false);
          for (const path of payload.paths) void this.sessions.open(path);
        }
      }),
    );
    await this.openFromCommandLine();
  }

  ngOnDestroy(): void {
    document.removeEventListener('keydown', this.onKey);
    for (const cleanup of this.cleanups) cleanup();
  }

  protected async openFile(): Promise<void> {
    if (this.dialogOpen) return;
    this.dialogOpen = true;
    try {
      const chosen = await openDialog({ multiple: true, title: 'Logdatei öffnen' });
      for (const path of chosen ?? []) void this.sessions.open(path);
    } catch (e) {
      this.sessions.showError(String(e));
    } finally {
      this.dialogOpen = false;
    }
  }

  private async openFromCommandLine(): Promise<void> {
    try {
      const matches = await getMatches();
      const value = matches.args['file']?.value;
      const paths = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
      for (const path of paths) await this.sessions.open(path);
    } catch (e) {
      // Unknown arguments of a launcher are no reason to bother the user.
      console.warn('command line ignored', e);
    }
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    const mod = event.metaKey || event.ctrlKey;
    if (!mod) return;
    const key = event.key.toLowerCase();
    if (key === 'o') {
      event.preventDefault();
      if (event.shiftKey) this.pathDialogOpen.set(true);
      else void this.openFile();
    } else if (key === 'w') {
      event.preventDefault();
      const id = this.sessions.activeId();
      if (id !== null) void this.sessions.close(id);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      this.sessions.cycle(event.shiftKey ? -1 : 1);
    } else if (key === ',') {
      event.preventDefault();
      this.settingsOpen.set(true);
    }
  };
}
