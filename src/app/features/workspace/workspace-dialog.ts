import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  computed,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { baseName } from '../../shared/format';
import { WorkspaceService } from './workspace.service';

/**
 * Opening a workspace (prompt 015): files that are not where they were („Suchen …“ or „Überspringen“, the rest
 * opens anyway), and afterwards what did not come back (skipped files, marks not found).
 */
@Component({
  selector: 'app-workspace-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog aria-labelledby="ws-title" (cancel)="onCancel($event)">
      @if (kind() === 'confirm' && ws.confirm(); as c) {
        <h2 id="ws-title">Arbeitsstand „{{ c.name }}“ öffnen</h2>
        <p class="dim">
          Diese Dateien werden zum Lesen geöffnet. Nur angehakte werden gesucht und geöffnet;
          Netzwerkpfade nie.
        </p>
        <ul class="missing">
          @for (item of c.items; track item.file; let i = $index) {
            <li>
              <label class="file pick">
                <input
                  type="checkbox"
                  [checked]="item.checked"
                  [disabled]="item.network"
                  (change)="ws.toggleConfirmFile(i)"
                />
                <span class="name">{{ item.label }}</span>
                <span class="path dim"
                  ><bdi>{{ item.paths.join(' + ') }}</bdi></span
                >
                @if (item.network) {
                  <span class="state">nicht geöffnet (Netzwerkpfad)</span>
                }
              </label>
            </li>
          }
        </ul>
        @if (c.layouts.length) {
          <label class="layouts">
            <input type="checkbox" [checked]="c.applyLayouts" (change)="ws.toggleLayouts()" />
            Spaltenlayouts übernehmen ({{ c.layouts.join(', ') }}; ersetzt die eigenen)
          </label>
        }
        <div class="actions">
          <button type="button" (click)="ws.finishConfirm(false)">Abbrechen</button>
          <button type="button" class="primary" (click)="ws.finishConfirm(true)">Öffnen</button>
        </div>
      } @else if (kind() === 'missing') {
        <h2 id="ws-title">Dateien nicht gefunden</h2>
        <p class="dim">
          Weder am gespeicherten Ort noch neben dem Arbeitsstand. Eine andere Datei wählen oder
          überspringen, der Rest wird geöffnet.
        </p>
        <ul class="missing">
          @for (item of ws.missing() ?? []; track $index; let i = $index) {
            <li>
              <div class="file">
                <span class="name">{{ baseName(item.path) }}</span>
                <span class="path dim"
                  ><bdi>{{ item.chosen ?? item.path }}</bdi></span
                >
                @if (item.chosen) {
                  <span class="state">✓ ersetzt</span>
                } @else if (item.skipped) {
                  <span class="state dim">wird übersprungen</span>
                }
              </div>
              <button type="button" (click)="ws.pickFor(i)">Suchen …</button>
              <button type="button" [attr.aria-pressed]="item.skipped" (click)="ws.skip(i)">
                Überspringen
              </button>
            </li>
          }
        </ul>
        <div class="actions">
          <button type="button" (click)="ws.finishMissing(false)">Abbrechen</button>
          <button
            type="button"
            class="primary"
            [disabled]="!allDecided()"
            [title]="allDecided() ? '' : 'Für jede Datei „Suchen …“ oder „Überspringen“ wählen'"
            (click)="ws.finishMissing(true)"
          >
            Öffnen
          </button>
        </div>
      } @else if (ws.report(); as report) {
        <h2 id="ws-title">Arbeitsstand geöffnet</h2>
        @if (report.migratedFrom) {
          <p>Älteres Format (Version {{ report.migratedFrom }}) übernommen.</p>
        }
        @if (report.skipped.length) {
          <p>Nicht geöffnet:</p>
          <ul>
            @for (name of report.skipped; track $index) {
              <li>{{ name }}</li>
            }
          </ul>
        }
        @if (report.lost.length) {
          <p>
            Nicht wiedergefunden (die Zeilen passen nicht mehr; sie bleiben im Arbeitsstand, falls
            die Datei später wieder passt):
          </p>
          <ul>
            @for (lost of report.lost; track $index) {
              <li>
                {{ lost.file }}:
                @if (lost.bookmarks) {
                  {{ lost.bookmarks }} Lesezeichen
                }
                @if (lost.bookmarks && lost.notes) {
                  ·
                }
                @if (lost.notes) {
                  {{ lost.notes }} {{ lost.notes === 1 ? 'Notiz' : 'Notizen' }}
                }
                <span class="dim">(Zeile {{ lost.lines.join(', ') }})</span>
              </li>
            }
          </ul>
        }
        @if (report.dropped) {
          <p class="dim">{{ report.dropped }} ungültige Einträge der Datei wurden ignoriert.</p>
        }
        <div class="actions">
          <button type="button" class="primary" (click)="ws.report.set(null)">Schließen</button>
        </div>
      }
    </dialog>
  `,
  styles: `
    dialog {
      width: min(560px, 92vw);
      padding: 14px 16px;
      background: var(--bg-panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      font-size: 12.5px;
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 45%);
    }
    h2 {
      margin: 0 0 8px;
      font-size: 14px;
    }
    ul {
      margin: 4px 0 10px;
      padding-left: 18px;
    }
    .missing {
      padding: 0;
      list-style: none;
    }
    .missing li {
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 6px 0;
      border-top: 1px solid var(--border);
    }
    .file {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
    }
    .pick {
      display: grid;
      grid-template-columns: auto 1fr;
      column-gap: 6px;
    }
    .pick > :not(input) {
      grid-column: 2;
    }
    .layouts {
      display: flex;
      gap: 6px;
      align-items: baseline;
      margin-top: 4px;
    }
    .name {
      font-weight: 600;
    }
    .path {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      direction: rtl;
      text-align: left;
    }
    .dim {
      color: var(--text-dim);
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
export class WorkspaceDialogComponent implements OnInit {
  protected readonly ws = inject(WorkspaceService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  readonly kind = input.required<'confirm' | 'missing' | 'report'>();

  protected readonly baseName = baseName;
  protected readonly allDecided = computed(() =>
    (this.ws.missing() ?? []).every((m) => m.chosen !== null || m.skipped),
  );

  ngOnInit(): void {
    this.dialog().nativeElement.showModal();
  }

  /** Escape: cancel the restore, or close the report. */
  protected onCancel(event: Event): void {
    event.preventDefault();
    if (this.kind() === 'confirm') this.ws.finishConfirm(false);
    else if (this.kind() === 'missing') this.ws.finishMissing(false);
    else this.ws.report.set(null);
  }
}
