import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { formatBytes, formatCount } from '../../shared/format';
import { LogSessionService } from '../sessions/log-session.service';
import { statusPill } from './status-pill';

@Component({
  selector: 'app-status-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (session(); as s) {
      <span class="pill" [class]="'pill ' + pill().cls" role="status">
        <span class="dot"></span>{{ pill().label }}
      </span>
      <span class="path" [title]="s.path"
        ><bdi>{{ s.path }}</bdi></span
      >
      @if (s.update().frozenStale) {
        <span class="stale">Datei wurde geleert, Anzeige ist evtl. unvollständig</span>
      }
      <span class="spring"></span>
      @if (pending(); as bytes) {
        <span title="Seit dem Einfrieren geschrieben, wird beim Fortsetzen nachgelesen"
          >+{{ bytes }} warten</span
        >
      }
      @if (s.update().filterPending) {
        <span>Filter {{ percent(s.update().filterProgress) }}</span>
      }
      <span title="Encoding">{{ encodingLabel() }}</span>
      <span>{{ size() }}</span>
      <span>{{ lines() }}</span>
    } @else {
      <span class="path">Keine Datei geöffnet</span>
    }
  `,
  styles: `
    :host {
      display: flex;
      align-items: center;
      gap: 14px;
      height: 26px;
      padding: 0 10px;
      background: var(--bg-panel);
      border-top: 1px solid var(--border);
      color: var(--text-dim);
      font-size: 11.5px;
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .path {
      overflow: hidden;
      text-overflow: ellipsis;
      direction: rtl;
      text-align: left;
      min-width: 60px;
    }
    .spring {
      flex: 1;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      color: var(--text);
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--text-dim);
    }
    .live .dot {
      background: var(--ok);
      animation: pulse 1.6s ease-in-out infinite;
    }
    .warn .dot {
      background: var(--lv-warn-fg);
    }
    .bad .dot {
      background: var(--danger);
    }
    .loading .dot,
    .frozen .dot {
      background: var(--accent);
    }
    .stale {
      color: var(--lv-warn-fg);
    }
    @keyframes pulse {
      50% {
        opacity: 0.35;
      }
    }
  `,
})
export class StatusBarComponent {
  private readonly sessions = inject(LogSessionService);
  protected readonly session = this.sessions.active;

  protected readonly pill = computed(() => {
    const session = this.session();
    if (!session) return { label: '', cls: '' };
    return statusPill(session.status(), session.frozen(), session.follow());
  });

  protected readonly pending = computed(() => {
    const bytes = this.session()?.update().pendingBytes ?? 0;
    return bytes > 0 ? formatBytes(bytes) : '';
  });

  protected readonly size = computed(() => formatBytes(this.session()?.update().fileSize ?? 0));

  protected readonly encodingLabel = computed(() => {
    const encoding = this.session()?.update().encoding;
    const labels: Record<string, string> = {
      utf8: 'UTF-8',
      utf16Le: 'UTF-16 LE',
      utf16Be: 'UTF-16 BE',
      latin1: 'Latin-1',
    };
    return encoding ? (labels[encoding] ?? encoding) : '';
  });

  protected readonly lines = computed(() => {
    const update = this.session()?.update();
    if (!update) return '';
    const total = formatCount(update.totalLines);
    return update.filteredLines === update.totalLines
      ? `${total} Zeilen`
      : `${formatCount(update.filteredLines)} von ${total} Zeilen`;
  });

  protected percent(progress: number): string {
    return `${Math.round(progress * 100)} %`;
  }
}
