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
import { LogSessionService } from '../sessions/log-session.service';
import { SessionState } from '../sessions/session-state';
import { MAX_NOTE_LENGTH } from '../workspace/workspace-model';

/** A short note on an entry (prompt 015, `Shift+M`): write, change or delete it. */
@Component({
  selector: 'app-note-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog (close)="closed.emit()" aria-labelledby="note-label">
      <form (submit)="save($event)">
        <label id="note-label" for="note-text">Notiz zu Zeile {{ line() + 1 }}</label>
        <textarea
          #text
          id="note-text"
          rows="4"
          [attr.maxlength]="max"
          placeholder="Was ist hier los?"
          [value]="initial()"
          (input)="value.set(text.value)"
          (keydown)="onKey($event)"
        ></textarea>
        <p class="hint">
          {{ value().length }}/{{ max }} · ⌘/Strg+Enter speichert · gehört zur Datei, der
          Arbeitsstand nimmt sie mit
        </p>
        <div class="actions">
          @if (initial()) {
            <button type="button" class="delete" (click)="remove()">Löschen</button>
          }
          <span class="spring"></span>
          <button type="button" (click)="dialog.close()">Abbrechen</button>
          <button type="submit" class="primary">Speichern</button>
        </div>
      </form>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(460px, 92vw);
      padding: 14px;
      background: var(--bg-panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 45%);
    }
    label {
      display: block;
      margin-bottom: 6px;
      font-size: 12px;
      font-weight: 600;
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      resize: vertical;
      font: inherit;
    }
    .hint {
      margin: 4px 0 0;
      color: var(--text-dim);
      font-size: 11.5px;
    }
    .actions {
      display: flex;
      gap: 8px;
      margin-top: 12px;
    }
    .spring {
      flex: 1;
    }
    .delete {
      color: var(--danger);
    }
    .primary {
      background: var(--accent);
      color: var(--accent-text);
      font-weight: 600;
    }
  `,
})
export class NoteDialogComponent implements OnInit {
  private readonly sessions = inject(LogSessionService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly text = viewChild.required<ElementRef<HTMLTextAreaElement>>('text');

  readonly session = input.required<SessionState>();
  readonly line = input.required<number>();
  readonly closed = output<void>();

  protected readonly max = MAX_NOTE_LENGTH;
  protected readonly initial = computed(() => this.session().notes().get(this.line()) ?? '');
  protected readonly value = signal('');
  /** Focus goes back where it was (the log) when the dialog closes. */
  private returnTo: HTMLElement | null = null;

  ngOnInit(): void {
    this.value.set(this.initial());
    this.returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.dialog().nativeElement.showModal();
    this.text().nativeElement.focus();
    this.dialog().nativeElement.addEventListener('close', () => this.returnTo?.focus(), {
      once: true,
    });
  }

  protected onKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) this.save(event);
  }

  protected save(event: Event): void {
    event.preventDefault();
    this.sessions.setNote(this.session(), this.line(), this.value());
    this.dialog().nativeElement.close();
  }

  protected remove(): void {
    this.sessions.setNote(this.session(), this.line(), '');
    this.dialog().nativeElement.close();
  }
}
