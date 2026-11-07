import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { SessionState } from '../features/sessions/session-state';
import { statusPill } from '../features/statusbar/status-pill';

/**
 * The marks of an open file, shared by the tabs and the sidebar tree (prompt 005): new errors, frozen,
 * and with `status` the state of the file as in the status bar (dot plus text, never colour alone).
 */
@Component({
  selector: 'app-session-marks',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (session().hasNewErrors()) {
      <span
        class="alert"
        role="img"
        title="Neue ERROR-/FATAL-Zeilen"
        aria-label="Neue Fehler"
      ></span>
    }
    @if (status()) {
      <span class="state" [class]="'state ' + pill().cls">
        <span class="dot" aria-hidden="true"></span>{{ pill().label }}
      </span>
    } @else if (session().frozen()) {
      <span class="frozen" role="img" title="Eingefroren" aria-label="Eingefroren">⏸</span>
    }
  `,
  styles: `
    :host {
      display: contents;
    }
    .alert {
      flex: none;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--danger);
    }
    .frozen {
      flex: none;
      color: var(--accent);
    }
    .state {
      flex: none;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: var(--text-dim);
      font-size: 11px;
    }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--text-dim);
    }
    .live .dot {
      background: var(--ok);
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
  `,
})
export class SessionMarksComponent {
  readonly session = input.required<SessionState>();
  /** Also the state of the file (sidebar); the tabs show only the marks. */
  readonly status = input(false);

  protected readonly pill = computed(() => {
    const session = this.session();
    return statusPill(session.status(), session.frozen(), session.follow());
  });
}
