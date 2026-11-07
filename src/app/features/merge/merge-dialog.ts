import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  computed,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { describeError, toAppError } from '../../core/errors/app-error';
import { LogApi } from '../../core/log/log-api';
import { LogSessionService } from '../sessions/log-session.service';
import {
  MAX_SOURCES,
  MergeEntry,
  addPaths,
  formatTime,
  mergeProblem,
  sourceColor,
} from './merge-logic';

/**
 * Merges several files into one tab (prompt 006): open tabs to tick, more files from the file dialog, a
 * profile per file (the suggestion preselected) and the first and last time as a preview. Errors stay at
 * their file.
 */
@Component({
  selector: 'app-merge-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog (close)="closed.emit()" aria-labelledby="merge-title">
      <form (submit)="submit($event)">
        <h2 id="merge-title">Dateien zusammenführen</h2>
        <p class="hint">
          Einträge werden nach Zeitstempel gemischt, neue Zeilen laufen live ein (bis 1 s
          Verzögerung). 2 bis {{ max }} Dateien.
        </p>
        @if (openFiles().length) {
          <fieldset>
            <legend>Geöffnete Tabs</legend>
            @for (file of openFiles(); track file.path) {
              <label class="open-tab">
                <input
                  type="checkbox"
                  [checked]="isChosen(file.path)"
                  (change)="toggle(file.path, $event)"
                />
                <span class="name">{{ file.fileName }}</span>
                <span class="dir">{{ file.path }}</span>
              </label>
            }
          </fieldset>
        }
        <div class="list-head">
          <span>Ausgewählt ({{ entries().length }})</span>
          <button type="button" (click)="pickFiles()">Weitere Dateien …</button>
        </div>
        <ul class="entries" aria-label="Ausgewählte Dateien">
          @for (entry of entries(); track entry.path; let i = $index) {
            <li [class.failed]="entry.error">
              <span class="swatch" [class]="'swatch src-' + color(i)" aria-hidden="true"></span>
              <div class="file">
                <span class="name" [title]="entry.path">{{ entry.fileName }}</span>
                @if (entry.error) {
                  <span class="error" role="alert">{{ entry.error }}</span>
                } @else {
                  <span class="times">
                    {{ time(entry.firstTime) }} – {{ time(entry.lastTime) }}
                  </span>
                }
              </div>
              <select
                [attr.aria-label]="'Profil für ' + entry.fileName"
                [disabled]="!!entry.error || !entry.profileId"
                (change)="setProfile(entry.path, $event)"
              >
                @for (profile of sessions.profiles(); track profile.id) {
                  <option [value]="profile.id" [selected]="profile.id === entry.profileId">
                    {{ profile.name }}
                  </option>
                }
              </select>
              <button
                type="button"
                class="remove"
                [attr.aria-label]="entry.fileName + ' entfernen'"
                title="Aus der Auswahl entfernen"
                (click)="remove(entry.path)"
              >
                ×
              </button>
            </li>
          } @empty {
            <li class="empty">Noch keine Datei gewählt</li>
          }
        </ul>
        @if (message(); as text) {
          <p class="message" role="status">{{ text }}</p>
        }
        <div class="actions">
          <button type="button" (click)="dialog.close()">Abbrechen</button>
          <button type="submit" class="primary" [disabled]="!!problem() || busy()">
            Zusammenführen
          </button>
        </div>
      </form>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(680px, 92vw);
      max-height: 86vh;
      padding: 14px;
      background: var(--bg-panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 45%);
    }
    h2 {
      margin: 0 0 4px;
      font-size: 14px;
    }
    .hint {
      margin: 0 0 10px;
      color: var(--text-dim);
      font-size: 12px;
    }
    fieldset {
      margin: 0 0 10px;
      padding: 6px 8px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      max-height: 160px;
      overflow: auto;
    }
    legend {
      font-size: 12px;
      font-weight: 600;
    }
    .open-tab {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 2px 0;
      font-size: 12px;
    }
    .dir {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-dim);
    }
    .list-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 12px;
      font-weight: 600;
    }
    .entries {
      list-style: none;
      margin: 6px 0 0;
      padding: 0;
      max-height: 300px;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    .entries li {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 8px;
      border-bottom: 1px solid var(--border);
      font-size: 12px;
    }
    .entries li:last-child {
      border-bottom: none;
    }
    .entries .empty {
      color: var(--text-dim);
    }
    .swatch {
      flex: none;
      width: 4px;
      align-self: stretch;
      border-radius: 2px;
      background: var(--src);
    }
    .file {
      display: flex;
      flex: 1;
      min-width: 0;
      flex-direction: column;
    }
    .file .name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 500;
    }
    .times {
      color: var(--text-dim);
      font-variant-numeric: tabular-nums;
    }
    .error {
      color: var(--danger);
      overflow-wrap: anywhere;
    }
    select {
      max-width: 160px;
    }
    .remove {
      color: var(--text-dim);
    }
    .message {
      margin: 8px 0 0;
      color: var(--text-dim);
      font-size: 12px;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 14px;
    }
    .primary {
      background: var(--accent);
      color: var(--accent-text);
      font-weight: 600;
    }
    .primary:hover:not(:disabled) {
      background: var(--accent);
      filter: brightness(1.1);
    }
  `,
})
export class MergeDialogComponent implements OnInit {
  protected readonly sessions = inject(LogSessionService);
  private readonly api = inject(LogApi);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  readonly closed = output<void>();

  protected readonly max = MAX_SOURCES;
  protected readonly entries = signal<MergeEntry[]>([]);
  protected readonly busy = signal(false);
  private readonly notice = signal<string | null>(null);
  protected readonly problem = computed(() => mergeProblem(this.entries()));
  protected readonly message = computed(() => this.notice() ?? this.problem());

  /** Single files in the tabs; a merge cannot be merged again. */
  protected readonly openFiles = computed(() =>
    this.sessions
      .sessions()
      // A file once, also with filter tabs (prompt 013).
      .filter((s, i, all) => !s.isMerge && all.findIndex((o) => o.path === s.path) === i)
      .map((s) => ({ path: s.path, fileName: s.fileName })),
  );

  ngOnInit(): void {
    this.dialog().nativeElement.showModal();
  }

  protected color(index: number): number {
    return sourceColor(index);
  }

  protected time(micros: number | null): string {
    return formatTime(micros);
  }

  protected isChosen(path: string): boolean {
    return this.entries().some((e) => e.path === path);
  }

  protected toggle(path: string, event: Event): void {
    if ((event.target as HTMLInputElement).checked) this.add([path]);
    else this.remove(path);
  }

  protected remove(path: string): void {
    this.entries.update((all) => all.filter((e) => e.path !== path));
    this.notice.set(null);
  }

  protected setProfile(path: string, event: Event): void {
    const profileId = (event.target as HTMLSelectElement).value;
    this.entries.update((all) => all.map((e) => (e.path === path ? { ...e, profileId } : e)));
  }

  protected async pickFiles(): Promise<void> {
    try {
      const chosen = await openDialog({ multiple: true, title: 'Dateien zum Zusammenführen' });
      if (chosen?.length) this.add(chosen);
    } catch (e) {
      this.notice.set(describeError(toAppError(e)));
    }
  }

  /** Adds files (also from the end-to-end test) and asks the backend about each one. */
  add(paths: readonly string[]): void {
    const { entries, duplicates } = addPaths(this.entries(), paths);
    this.entries.set(entries);
    this.notice.set(
      duplicates.length ? `Schon in der Auswahl: ${duplicates.map(baseName).join(', ')}` : null,
    );
    for (const path of paths) {
      if (duplicates.includes(path)) continue;
      void this.inspect(path);
    }
  }

  private async inspect(path: string): Promise<void> {
    let patch: Partial<MergeEntry>;
    try {
      const c = await this.api.inspectMergeSource(path);
      patch =
        c.firstTime === null && c.fileSize > 0
          ? { error: 'Keine Zeitstempel in den ersten 200 Zeilen' }
          : {
              fileName: c.fileName,
              profileId: c.suggestedProfileId,
              firstTime: c.firstTime,
              lastTime: c.lastTime,
            };
    } catch (e) {
      patch = { error: describeError(toAppError(e)) };
    }
    this.entries.update((all) => all.map((e) => (e.path === path ? { ...e, ...patch } : e)));
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.problem() || this.busy()) return;
    this.busy.set(true);
    try {
      const error = await this.sessions.openMerged(
        this.entries().map((e) => ({ path: e.path, profileId: e.profileId || null })),
      );
      if (!error) {
        this.dialog().nativeElement.close();
        return;
      }
      // An error of one file stays at that file.
      const at = error.path ? this.entries().find((e) => e.path === error.path) : undefined;
      if (at) {
        const text = describeError({ ...error, path: undefined });
        this.entries.update((all) =>
          all.map((e) => (e.path === at.path ? { ...e, error: text } : e)),
        );
      } else {
        this.notice.set(describeError(error));
      }
    } finally {
      this.busy.set(false);
    }
  }
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}
