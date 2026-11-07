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
import { pickSaveFile } from '../../core/dialog/native-dialog';
import { describeError, toAppError } from '../../core/errors/app-error';
import { ExportFormat } from '../../core/log/log.models';
import { SettingsService } from '../../core/settings/settings.service';
import { formatCount } from '../../shared/format';
import { SessionState } from '../sessions/session-state';
import { dirName } from '../workspace/workspace-paths';
import {
  EXPORT_FORMATS,
  ExportScope,
  exportColumns,
  exportFileName,
  exportRange,
  extensionOf,
  withExtension,
} from './export-logic';
import { ExportService } from './export.service';

/**
 * Export (prompt 015, `Cmd/Ctrl+Shift+E`): scope, format and columns, then the native save dialog. The backend
 * writes the file; progress and „Abbrechen“ are in the status bar.
 */
@Component({
  selector: 'app-export-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog (close)="closed.emit()" aria-labelledby="export-title">
      <form (submit)="submit($event)">
        <h2 id="export-title">Exportieren</h2>
        <fieldset>
          <legend>Bereich</legend>
          <label [class.off]="!selection()">
            <input
              type="radio"
              name="scope"
              value="selection"
              [checked]="scope() === 'selection'"
              [disabled]="!selection()"
              (change)="scope.set('selection')"
            />
            Auswahl
            @if (selection(); as sel) {
              <span class="dim">Zeilen {{ sel.first + 1 }}–{{ sel.last + 1 }}</span>
            } @else {
              <span class="dim">keine Zeile gewählt</span>
            }
          </label>
          <label>
            <input
              type="radio"
              name="scope"
              value="view"
              [checked]="scope() === 'view'"
              (change)="scope.set('view')"
            />
            Ansicht
            <span class="dim">{{ viewCount() }} Zeilen{{ filtered() ? ', gefiltert' : '' }}</span>
          </label>
          <label>
            <input
              type="radio"
              name="scope"
              value="all"
              [checked]="scope() === 'all'"
              (change)="scope.set('all')"
            />
            Ganze Datei <span class="dim">{{ allCount() }} Zeilen, ohne Filter</span>
          </label>
        </fieldset>
        <fieldset>
          <legend>Format</legend>
          @for (f of formats; track f.id) {
            <label>
              <input
                type="radio"
                name="format"
                [value]="f.id"
                [checked]="format() === f.id"
                (change)="format.set(f.id)"
              />
              {{ f.label }} <span class="dim">.{{ f.ext }}</span>
            </label>
          }
        </fieldset>
        @if (format() !== 'txt' && columns().length) {
          <fieldset class="columns">
            <legend>Spalten</legend>
            @for (c of columns(); track c.id) {
              <label>
                <input type="checkbox" [checked]="chosen().has(c.id)" (change)="toggle(c.id)" />
                {{ c.label }}
              </label>
            }
            <p class="dim note">
              Ohne Spalte: Zeile, Level und der ganze Text. Stacktrace-Zeilen stehen in der
              Nachricht.
            </p>
          </fieldset>
        }
        @if (format() === 'csv') {
          <p class="dim note">
            Felder in Anführungszeichen, UTF-8 mit BOM; Zellen, die mit = + - &#64; beginnen,
            bekommen ein ' davor (Schutz vor Formeln).
          </p>
        }
        @if (session().update().frozenStale) {
          <p class="warn" role="alert">
            Die Datei wurde während des Freeze geleert: der Text passt evtl. nicht mehr zur Anzeige.
          </p>
        }
        @if (error(); as message) {
          <p class="error" role="alert">{{ message }}</p>
        }
        <div class="actions">
          <button type="button" (click)="dialog.close()">Abbrechen</button>
          <button type="submit" class="primary" [disabled]="busy()">Speichern unter …</button>
        </div>
      </form>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(460px, 92vw);
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
      padding: 6px 10px 8px;
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
    label.off {
      color: var(--text-dim);
    }
    .columns {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    }
    .columns legend,
    .columns .note {
      grid-column: 1 / -1;
    }
    .dim {
      color: var(--text-dim);
    }
    .note {
      margin: 4px 0 8px;
      font-size: 11.5px;
    }
    .warn {
      margin: 4px 0 8px;
      color: var(--lv-warn-fg);
      font-size: 12px;
    }
    .error {
      margin: 4px 0 8px;
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
export class ExportDialogComponent implements OnInit {
  private readonly exports = inject(ExportService);
  private readonly settings = inject(SettingsService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  readonly session = input.required<SessionState>();
  readonly closed = output<void>();

  protected readonly formats = EXPORT_FORMATS;
  protected readonly selection = computed(() => this.session().selection());
  protected readonly scope = signal<ExportScope>('view');
  protected readonly format = signal<ExportFormat>('txt');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly viewCount = computed(() => formatCount(this.session().update().filteredLines));
  protected readonly allCount = computed(() => formatCount(this.session().update().totalLines));
  protected readonly filtered = computed(() => this.session().filterActive());
  protected readonly columns = computed(() => {
    const set = this.session().columns();
    const layout = set ? this.settings.settings().columnLayouts[set.profileId] : undefined;
    return exportColumns(set?.columns ?? null, layout?.order ?? []);
  });
  /** Unchecked by the user; everything else is exported (hidden columns of the layout start unchecked). */
  private readonly unchecked = signal<ReadonlySet<string> | null>(null);
  protected readonly chosen = computed(() => {
    const set = this.session().columns();
    const hidden =
      this.unchecked() ??
      new Set(set ? (this.settings.settings().columnLayouts[set.profileId]?.hidden ?? []) : []);
    return new Set(
      this.columns()
        .map((c) => c.id)
        .filter((id) => !hidden.has(id)),
    );
  });

  ngOnInit(): void {
    if (
      this.session().selection() &&
      this.session().selection()!.first !== this.session().selection()!.last
    ) {
      this.scope.set('selection');
    }
    if (this.settings.settings().columnMode === 'columns' && this.columns().length) {
      this.format.set('csv');
    }
    this.dialog().nativeElement.showModal();
  }

  protected toggle(id: string): void {
    const now = new Set(
      this.columns()
        .map((c) => c.id)
        .filter((c) => !this.chosen().has(c)),
    );
    if (now.has(id)) now.delete(id);
    else now.add(id);
    this.unchecked.set(now);
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    const session = this.session();
    const range = exportRange(this.scope(), session.selection());
    if (!range || this.busy()) return;
    const format = this.format();
    this.busy.set(true);
    this.error.set(null);
    try {
      const name = exportFileName(session.fileName, this.scope(), format);
      const folder = session.path ? dirName(session.path) : '';
      const chosen = await pickSaveFile(
        'Exportieren',
        folder ? `${folder}${folder.includes('\\') ? '\\' : '/'}${name}` : name,
        [
          {
            name: this.formats.find((f) => f.id === format)?.label ?? format,
            extensions: [extensionOf(format)],
          },
        ],
      );
      if (!chosen) return;
      const columns =
        format === 'txt'
          ? null
          : this.columns()
              .map((c) => c.id)
              .filter((id) => this.chosen().has(id));
      const failed = await this.exports.start(
        session,
        range,
        format,
        columns && columns.length ? columns : null,
        withExtension(chosen, format),
      );
      if (failed) this.error.set(failed);
      else this.dialog().nativeElement.close();
    } catch (e) {
      this.error.set(describeError(toAppError(e)));
    } finally {
      this.busy.set(false);
    }
  }
}
