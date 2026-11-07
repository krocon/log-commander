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
import { homeDir } from '@tauri-apps/api/path';
import { describeError, toAppError } from '../../core/errors/app-error';
import { LogSessionService } from '../sessions/log-session.service';
import { cleanPathInput, expandHome, usesHome } from './open-path-logic';

/** Opens a file by its typed or pasted path. A path that fails stays in the field to be corrected. */
@Component({
  selector: 'app-open-path-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog (close)="closed.emit()" aria-labelledby="open-path-label">
      <form (submit)="submit($event)">
        <label id="open-path-label" for="open-path-input">Pfad der Logdatei</label>
        <input
          #input
          id="open-path-input"
          type="text"
          placeholder="/var/log/app.log"
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          [class.invalid]="error()"
          (input)="onInput($event)"
        />
        @if (error(); as message) {
          <p class="error" role="alert">{{ message }}</p>
        }
        <div class="actions">
          <button type="button" (click)="dialog.close()">Abbrechen</button>
          <button type="submit" class="primary" [disabled]="!canSubmit()">Öffnen</button>
        </div>
      </form>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(560px, 90vw);
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
    input {
      width: 100%;
      box-sizing: border-box;
      font-family: var(--font-mono);
    }
    .error {
      margin: 8px 0 0;
      color: var(--danger);
      font-size: 12px;
      overflow-wrap: anywhere;
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
export class OpenPathDialogComponent implements OnInit {
  private readonly sessions = inject(LogSessionService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly input = viewChild.required<ElementRef<HTMLInputElement>>('input');

  readonly closed = output<void>();

  private readonly path = signal('');
  private readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly canSubmit = computed(() => this.path() !== '' && !this.busy());

  ngOnInit(): void {
    this.dialog().nativeElement.showModal();
  }

  protected onInput(event: Event): void {
    this.path.set(cleanPathInput((event.target as HTMLInputElement).value));
    this.error.set(null);
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.canSubmit()) return;
    this.busy.set(true);
    try {
      const path = this.path();
      const error = await this.sessions.tryOpen(
        usesHome(path) ? expandHome(path, await homeDir()) : path,
      );
      if (error) this.showError(describeError(error));
      else this.dialog().nativeElement.close();
    } catch (e) {
      this.showError(describeError(toAppError(e)));
    } finally {
      this.busy.set(false);
    }
  }

  private showError(message: string): void {
    this.error.set(message);
    this.input().nativeElement.select();
  }
}
