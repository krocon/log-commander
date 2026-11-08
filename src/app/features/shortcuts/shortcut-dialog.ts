import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { ActionService } from '../../core/actions/action.service';
import { ActionId, actionDef } from '../../core/actions/action-catalog';
import { assignShortcut, checkCandidate, pruneOverride } from '../../core/actions/keymap';
import { formatShortcut, strokeFromEvent, strokeToString } from '../../core/actions/shortcut';
import { Pending, shortcutGroups } from './shortcut-logic';

/**
 * Prompt 021: every shortcut of the app; search, record, remove, reset. `?` opens it as an overview (read mode),
 * „Bearbeiten“ switches to editing. Changes go to the settings at once (only the differences from the default).
 */
@Component({
  selector: 'app-shortcut-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog
      #dialog
      tabindex="-1"
      class="shortcuts"
      aria-labelledby="sc-title"
      aria-modal="true"
      (close)="closed.emit()"
      (cancel)="onCancel($event)"
      (keydown)="onKey($event)"
    >
      <header>
        <h2 id="sc-title">Tastenkürzel</h2>
        <button type="button" aria-label="Schließen" (click)="dialog.close()">×</button>
      </header>
      <div class="bar">
        <input
          #search
          type="search"
          aria-label="Aktionen suchen"
          placeholder="Suchen: Name, Id oder Kürzel"
          [value]="query()"
          (input)="query.set(search.value)"
        />
        @if (editing()) {
          <button type="button" [disabled]="!changedCount()" (click)="confirmAll.set(true)">
            Alle zurücksetzen
          </button>
        } @else {
          <button type="button" class="primary" (click)="editing.set(true)">Bearbeiten</button>
        }
      </div>
      @if (confirmAll()) {
        <div class="ask" role="alert">
          <span>{{ changedCount() }} eigene Belegung(en) verwerfen und die Vorgaben nehmen?</span>
          <button type="button" class="primary" (click)="resetAll()">Alle zurücksetzen</button>
          <button type="button" (click)="confirmAll.set(false)">Abbrechen</button>
        </div>
      }
      @if (pending(); as p) {
        <div class="ask" role="alert">
          @if (p.kind === 'conflict') {
            <span> {{ show(p.shortcut) }} ist belegt durch „{{ label(p.owner) }}“. </span>
            <button type="button" class="primary" (click)="replace(p)">Ersetzen</button>
            <button type="button" (click)="pending.set(null)">Abbrechen</button>
          } @else {
            <span>{{ show(p.shortcut) }} ist reserviert: {{ p.reason }}.</span>
            <button type="button" (click)="pending.set(null)">OK</button>
          }
        </div>
      }
      <div class="list">
        @for (group of groups(); track group.name) {
          <h3>{{ group.name }}</h3>
          <ul>
            @for (row of group.rows; track row.id) {
              <li [class.unavailable]="!actions.isRegistered(row.id)" [attr.data-action]="row.id">
                <span class="name">
                  {{ row.label }}
                  <code>{{ row.id }}</code>
                </span>
                <span class="keys">
                  @if (recording()?.id === row.id) {
                    <em aria-live="assertive">Tasten drücken … (Esc bricht ab)</em>
                  } @else {
                    @for (key of row.keys; track key.value) {
                      <span class="chip">
                        <kbd>{{ key.text }}</kbd>
                        @if (editing()) {
                          <button
                            type="button"
                            [attr.aria-label]="key.text + ' entfernen'"
                            (click)="remove(row.id, key.value)"
                          >
                            ×
                          </button>
                        }
                      </span>
                    } @empty {
                      <span class="none">–</span>
                    }
                  }
                </span>
                @if (editing()) {
                  <span class="edit">
                    @if (recording()?.id === row.id) {
                      <button type="button" (click)="stopRecording()">Abbrechen</button>
                    } @else {
                      <button
                        type="button"
                        [attr.aria-label]="'Neu belegen: ' + row.label"
                        (click)="record(row.id, 'replace')"
                      >
                        Aufnehmen
                      </button>
                      <button
                        type="button"
                        title="Weiteres Kürzel"
                        [attr.aria-label]="'Weiteres Kürzel: ' + row.label"
                        (click)="record(row.id, 'add')"
                      >
                        +
                      </button>
                    }
                    @if (row.changed) {
                      <button
                        type="button"
                        [attr.aria-label]="'Zurücksetzen: ' + row.label"
                        (click)="reset(row.id)"
                      >
                        Zurücksetzen
                      </button>
                    }
                  </span>
                }
              </li>
            }
          </ul>
        } @empty {
          <p class="none">Keine Aktion passt.</p>
        }
      </div>
      @if (actions.keymap().problems.length) {
        <ul class="problems" role="status">
          @for (problem of actions.keymap().problems; track $index) {
            <li>{{ problem }}</li>
          }
        </ul>
      }
      <p class="note">
        Gedimmt: hier gerade ohne Wirkung. Während der Aufnahme sind auch die Kürzel der Menüleiste
        aus. Tasten in Baum, Zeitstrahl, Panels und Dialogen sind fest.
      </p>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(720px, 94vw);
      max-height: 86vh;
      padding: 14px;
      background: var(--bg-panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    dialog[open] {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 45%);
    }
    header,
    .bar,
    .ask {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    header h2 {
      flex: 1;
      margin: 0;
      font-size: 15px;
    }
    .bar input {
      flex: 1;
    }
    .ask {
      padding: 6px 8px;
      border: 1px solid var(--accent);
      border-radius: 6px;
    }
    .ask span {
      flex: 1;
    }
    .list {
      overflow: auto;
      min-height: 0;
    }
    h3 {
      margin: 10px 0 4px;
      font-size: 12px;
      color: var(--text-dim);
    }
    ul {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 3px 4px;
      border-bottom: 1px solid var(--border);
    }
    li.unavailable .name {
      color: var(--text-dim);
    }
    .name {
      flex: 1;
      min-width: 0;
    }
    code {
      margin-left: 6px;
      font-size: 10.5px;
      color: var(--text-dim);
    }
    .keys {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .edit {
      display: flex;
      flex-shrink: 0;
      gap: 4px;
      width: 19em;
      white-space: nowrap;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg-raised);
    }
    kbd {
      padding: 1px 6px;
      font: inherit;
    }
    .chip button {
      padding: 0 5px;
      border: 0;
      background: none;
      color: var(--text-dim);
    }
    .none,
    .note,
    .problems {
      color: var(--text-dim);
      font-size: 11.5px;
    }
    .note,
    .problems {
      margin: 0;
    }
    .primary {
      background: var(--accent);
      color: var(--accent-text);
      font-weight: 600;
    }
  `,
})
export class ShortcutDialogComponent implements OnInit, OnDestroy {
  protected readonly actions = inject(ActionService);
  readonly startMode = input<'edit' | 'read'>('edit');
  readonly closed = output<void>();
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly search = viewChild.required<ElementRef<HTMLInputElement>>('search');
  private returnFocus: HTMLElement | null = null;

  protected readonly query = signal('');
  protected readonly editing = signal(true);
  protected readonly recording = signal<{ id: ActionId; mode: 'replace' | 'add' } | null>(null);
  protected readonly pending = signal<Pending | null>(null);
  protected readonly confirmAll = signal(false);

  protected readonly groups = computed(() =>
    shortcutGroups(
      this.actions.keymap(),
      this.actions.override(),
      this.query(),
      this.actions.platform(),
    ),
  );
  protected readonly changedCount = computed(() => Object.keys(this.actions.override()).length);

  ngOnInit(): void {
    this.editing.set(this.startMode() === 'edit');
    this.returnFocus = document.activeElement as HTMLElement | null;
    this.dialog().nativeElement.showModal();
    this.search().nativeElement.focus();
  }

  ngOnDestroy(): void {
    this.actions.recording.set(false);
    this.returnFocus?.focus?.();
  }

  protected label(id: ActionId): string {
    return actionDef(id).label;
  }

  protected show(shortcut: string): string {
    return formatShortcut(shortcut, this.actions.platform());
  }

  protected record(id: ActionId, mode: 'replace' | 'add'): void {
    this.pending.set(null);
    this.confirmAll.set(false);
    this.recording.set({ id, mode });
    this.actions.recording.set(true);
    // Off the button: Space or Enter would press it again instead of being recorded.
    this.dialog().nativeElement.focus();
  }

  protected stopRecording(): void {
    const id = this.recording()?.id;
    this.recording.set(null);
    this.actions.recording.set(false);
    if (id) {
      setTimeout(() =>
        this.dialog()
          .nativeElement.querySelector<HTMLElement>(`li[data-action="${id}"] .edit button`)
          ?.focus(),
      );
    }
  }

  protected remove(id: ActionId, shortcut: string): void {
    const rest = this.actions.shortcuts(id).filter((s) => s !== shortcut);
    this.store({ ...this.actions.override(), [id]: rest });
  }

  protected reset(id: ActionId): void {
    const next = { ...this.actions.override() };
    delete next[id];
    this.actions.setOverride(next);
  }

  protected resetAll(): void {
    this.confirmAll.set(false);
    this.actions.setOverride({});
  }

  protected replace(p: Extract<Pending, { kind: 'conflict' }>): void {
    this.pending.set(null);
    this.assign(p.id, p.shortcut, p.owner, p.mode);
  }

  /** While recording, every key is the shortcut; only Esc (and the button) stop it. */
  protected onKey(event: KeyboardEvent): void {
    const rec = this.recording();
    if (!rec) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      this.stopRecording();
      return;
    }
    const platform = this.actions.platform();
    const stroke = strokeFromEvent(event, platform);
    if (!stroke) return; // a modifier alone: wait for the key
    this.stopRecording();
    const shortcut = strokeToString(stroke);
    const candidate = checkCandidate(rec.id, shortcut, this.actions.keymap(), platform);
    if (candidate.kind === 'ok') this.assign(rec.id, shortcut, null, rec.mode);
    else if (candidate.kind === 'same' && rec.mode === 'replace') {
      this.assign(rec.id, shortcut, null, rec.mode);
    } else if (candidate.kind === 'reserved') {
      this.pending.set({ ...candidate, id: rec.id, mode: rec.mode });
    } else if (candidate.kind === 'conflict') {
      this.pending.set({ ...candidate, id: rec.id, mode: rec.mode });
    }
  }

  /** Esc while recording stops the recording, not the dialog. */
  protected onCancel(event: Event): void {
    if (this.recording()) {
      event.preventDefault();
      this.stopRecording();
    }
  }

  private assign(
    id: ActionId,
    shortcut: string,
    loser: ActionId | null,
    mode: 'replace' | 'add',
  ): void {
    const platform = this.actions.platform();
    this.actions.setOverride(
      assignShortcut(
        this.actions.override(),
        this.actions.keymap(),
        id,
        shortcut,
        platform,
        loser,
        mode,
      ),
    );
  }

  private store(next: Record<string, readonly string[]>): void {
    this.actions.setOverride(pruneOverride(next, this.actions.platform()));
  }
}
