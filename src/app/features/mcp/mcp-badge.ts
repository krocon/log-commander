import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  viewChild,
} from '@angular/core';
import { LogSessionService } from '../sessions/log-session.service';
import { McpService } from './mcp.service';
import { historyResult, historyTime } from './mcp-texts';

/**
 * „KI“ in the status bar (prompt 022): shown while AI control is on or there is a history. The panel lists the
 * last calls (tool, tab, result – never log text), hides the tab in front from the AI, and cuts the connections.
 */
@Component({
  selector: 'app-mcp-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown.escape)': 'close()' },
  template: `
    @if (mcp.visible()) {
      <button
        #toggle
        type="button"
        class="badge"
        [class.on]="mcp.connected()"
        [class.dim]="!mcp.info()?.enabled"
        aria-haspopup="dialog"
        [attr.aria-expanded]="open()"
        [title]="title()"
        (click)="open.set(!open())"
      >
        <span class="dot" aria-hidden="true"></span>KI
        @if (connections() > 1) {
          <span>({{ connections() }})</span>
        }
      </button>
      @if (open()) {
        <div class="panel" role="dialog" aria-label="KI-Steuerung" tabindex="-1" #panel>
          <p class="state" role="status">{{ title() }}</p>
          @if (sessions.active(); as tab) {
            <label class="hide">
              <input
                type="checkbox"
                [checked]="mcp.isHidden(tab)"
                [disabled]="mcp.isHidden(tab) && !tab.aiHidden()"
                (change)="mcp.toggleHidden(tab)"
              />
              „{{ tab.tabLabel() }}“ vor der KI verbergen
            </label>
          }
          <h3>Letzte Aufrufe</h3>
          @if (mcp.history().length) {
            <ol class="history">
              @for (h of mcp.history(); track $index) {
                <li [class.err]="h.result !== 'ok' && h.result !== 'confirmed'">
                  <span class="time">{{ time(h.at) }}</span>
                  <code>{{ h.tool }}</code>
                  @if (h.tab) {
                    <bdi class="tab">{{ h.tab }}</bdi>
                  }
                  <span class="result">{{ result(h.result) }}</span>
                </li>
              }
            </ol>
          } @else {
            <p class="empty">Noch keine Aufrufe.</p>
          }
          <div class="actions">
            <button type="button" [disabled]="!mcp.history().length" (click)="mcp.clearHistory()">
              Verlauf leeren
            </button>
            <button type="button" [disabled]="!mcp.connected()" (click)="mcp.disconnect()">
              KI trennen
            </button>
          </div>
        </div>
      }
    }
  `,
  styles: `
    :host {
      position: relative;
      display: flex;
      align-items: center;
    }
    .badge {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 0 6px;
      height: 20px;
      border: 1px solid var(--border);
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      color: var(--text-dim);
    }
    .badge.on {
      color: var(--accent);
      border-color: var(--accent);
    }
    .badge.dim {
      opacity: 0.7;
    }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: currentColor;
    }
    .panel {
      position: absolute;
      right: 0;
      bottom: 26px;
      z-index: 50;
      width: min(440px, 90vw);
      max-height: 60vh;
      overflow: auto;
      padding: 10px 12px;
      background: var(--bg-panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: 0 6px 24px rgb(0 0 0 / 30%);
      white-space: normal;
    }
    .state {
      margin: 0 0 8px;
      font-weight: 600;
    }
    .hide {
      display: flex;
      gap: 6px;
      align-items: center;
      margin-bottom: 8px;
    }
    h3 {
      margin: 6px 0 4px;
      font-size: 11.5px;
      color: var(--text-dim);
    }
    .history {
      margin: 0;
      padding: 0;
      list-style: none;
      font-size: 11.5px;
    }
    .history li {
      display: flex;
      gap: 8px;
      padding: 2px 0;
      border-bottom: 1px solid var(--border);
    }
    .history .tab {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 140px;
      color: var(--text-dim);
    }
    .history .result {
      margin-left: auto;
    }
    .history li.err .result {
      color: var(--danger);
    }
    .time {
      color: var(--text-dim);
    }
    .empty {
      color: var(--text-dim);
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 10px;
    }
  `,
})
export class McpBadgeComponent {
  protected readonly mcp = inject(McpService);
  protected readonly sessions = inject(LogSessionService);
  private readonly toggle = viewChild<ElementRef<HTMLButtonElement>>('toggle');
  protected readonly open = this.mcp.panelOpen;
  protected readonly connections = computed(() => this.mcp.info()?.connections ?? 0);
  protected readonly title = computed(() => {
    const info = this.mcp.info();
    if (!info?.enabled) return 'KI-Steuerung aus (Einstellungen)';
    const n = info.connections;
    return n === 0
      ? 'KI-Steuerung an, keine KI verbunden'
      : n === 1
        ? 'Eine KI verbunden'
        : `${n} KIs verbunden`;
  });
  protected readonly time = historyTime;
  protected readonly result = historyResult;

  close(): void {
    if (!this.open()) return;
    this.open.set(false);
    this.toggle()?.nativeElement.focus();
  }
}
