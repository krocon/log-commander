import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Level, LevelCounts } from '../../core/log/log.models';
import { formatBytes, formatCount } from '../../shared/format';
import { SEVERITIES, onlyLevel, toggleLevel } from '../sessions/filter-logic';
import { LogSessionService } from '../sessions/log-session.service';
import { SessionState } from '../sessions/session-state';

interface LevelRow {
  level: Level;
  label: string;
}

const LEVEL_ROWS: readonly LevelRow[] = [
  ...SEVERITIES.map((level) => ({ level, label: level as string })),
  { level: 'UNKNOWN', label: 'Ohne Level' },
];

/**
 * Lines per level of the whole file and of the view (prompt 005). The rows are fixed, an update only
 * changes text: it comes up to 10 times a second.
 */
@Component({
  selector: 'app-stats-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stats' },
  template: `
    @let u = session().update();
    @let levels = session().levels();
    <table aria-label="Statistik">
      <thead>
        <tr>
          <th scope="col"><span class="sr-only">Zeile</span></th>
          <th scope="col">Alle</th>
          <th scope="col" [title]="pending() ? 'Filter läuft …' : 'Nach dem Filter'">Ansicht</th>
        </tr>
      </thead>
      <tbody>
        <tr class="total">
          <th scope="row">Zeilen</th>
          <td>{{ count(u.totalLines) }}</td>
          <td>{{ pending() ? '…' : count(u.filteredLines) }}</td>
        </tr>
        @for (row of rows; track row.level) {
          <tr [class]="'lv lv-' + row.level">
            <th scope="row">
              <button
                type="button"
                class="level"
                [attr.data-level]="row.level"
                [attr.aria-pressed]="levels.has(row.level)"
                [title]="row.label + ': Klick nur dieses Level · Alt-Klick an/aus'"
                (click)="onLevel($event, row.level)"
              >
                {{ row.label }}
              </button>
            </th>
            <td>{{ count(u.counts[row.level]) }}</td>
            <td>{{ pending() ? '…' : count(viewCount(u.viewCounts, row.level)) }}</td>
          </tr>
        }
        <tr class="size">
          <th scope="row">Dateigröße</th>
          <td>{{ size(u.fileSize) }}</td>
          <td><span aria-label="entfällt">–</span></td>
        </tr>
      </tbody>
    </table>
  `,
  styles: `
    :host {
      display: block;
      overflow: auto;
      padding: 6px 8px 8px;
      font-size: 12px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-variant-numeric: tabular-nums;
    }
    th,
    td {
      padding: 2px 4px;
      white-space: nowrap;
    }
    thead th {
      color: var(--text-dim);
      font-weight: 600;
      text-align: right;
      border-bottom: 1px solid var(--border);
    }
    tbody th {
      text-align: left;
      font-weight: normal;
      color: var(--text-dim);
    }
    td {
      text-align: right;
    }
    .total td,
    .total th {
      color: var(--text);
      font-weight: 600;
    }
    .size th,
    .size td {
      border-top: 1px solid var(--border);
      color: var(--text-dim);
    }
    .level {
      width: 100%;
      text-align: left;
      padding: 0 4px;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-dim);
    }
    .level[aria-pressed='true'] {
      background: transparent;
      color: var(--text);
    }
    .level[aria-pressed='true']::before {
      content: '● ';
      color: var(--mark);
    }
    .level[aria-pressed='false']::before {
      content: '○ ';
    }
    .level:hover {
      background: var(--bg-hover);
    }
    .lv-TRACE {
      --mark: var(--lv-trace-fg);
    }
    .lv-DEBUG {
      --mark: var(--lv-debug-fg);
    }
    .lv-INFO {
      --mark: var(--lv-info-badge);
    }
    .lv-WARN {
      --mark: var(--lv-warn-fg);
    }
    .lv-ERROR {
      --mark: var(--lv-error-fg);
    }
    .lv-FATAL {
      --mark: var(--lv-error-edge);
    }
    .lv-UNKNOWN {
      --mark: var(--text-dim);
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
    }
  `,
})
export class StatsPanelComponent {
  private readonly sessions = inject(LogSessionService);
  readonly session = input.required<SessionState>();

  protected readonly rows = LEVEL_ROWS;
  /** The view counts still belong to the old filter. */
  protected readonly pending = computed(() => this.session().update().filterPending);

  protected count(value: number): string {
    return formatCount(value);
  }

  protected viewCount(counts: LevelCounts | undefined, level: Level): number {
    return counts?.[level] ?? 0;
  }

  protected size(bytes: number): string {
    return formatBytes(bytes);
  }

  /** Like the chips, the other way round: a click shows only this level, Alt-click switches it. */
  protected onLevel(event: MouseEvent, level: Level): void {
    const session = this.session();
    const next = event.altKey ? toggleLevel(session.levels(), level) : onlyLevel(level);
    void this.sessions.setLevels(session, next);
  }
}
