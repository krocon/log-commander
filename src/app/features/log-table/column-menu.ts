import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  untracked,
} from '@angular/core';
import { MESSAGE_ID, ViewColumn, canMove, lastShown } from './columns-logic';

/**
 * The column menu of the column view (prompt 009): right click on the header or `Shift+F10`. Not a native
 * menu: show/hide, move left/right and width per column, reset. Every function by keyboard (Tab, Space,
 * Enter, Escape closes); the view gives the focus back.
 */
@Component({
  selector: 'app-column-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'dialog',
    'aria-label': 'Spalten',
    class: 'lt-colmenu',
    '[style.left.px]': 'x()',
    '[style.top.px]': 'y()',
    '(keydown)': 'onKey($event)',
  },
  template: `
    <div class="title">Spalten</div>
    <ul>
      @for (c of columns(); track c.id) {
        <li [class.current]="c.id === focusId()" [attr.data-col]="c.id">
          <label>
            <input
              type="checkbox"
              [checked]="!c.hidden"
              [disabled]="c.id === messageId"
              [title]="c.id === messageId ? 'Die Nachricht bleibt immer sichtbar' : ''"
              (change)="hide.emit({ id: c.id, hidden: !$any($event.target).checked })"
            />
            {{ c.label }}
          </label>
          <button
            type="button"
            title="Nach links"
            [attr.aria-label]="c.label + ' nach links'"
            [disabled]="!movable(c.id, -1)"
            (click)="moveBy(c.id, -1)"
          >
            ◀
          </button>
          <button
            type="button"
            title="Nach rechts"
            [attr.aria-label]="c.label + ' nach rechts'"
            [disabled]="!movable(c.id, 1)"
            (click)="moveBy(c.id, 1)"
          >
            ▶
          </button>
          <button
            type="button"
            title="Schmaler"
            [attr.aria-label]="c.label + ' schmaler'"
            [disabled]="c.hidden || c.id === fillId()"
            (click)="widthChange.emit({ id: c.id, direction: -1 })"
          >
            −
          </button>
          <span class="width" [title]="c.id === fillId() ? 'Die letzte Spalte füllt den Rest' : ''">
            {{ c.id === fillId() ? 'Rest' : c.width + ' px' }}
          </span>
          <button
            type="button"
            title="Breiter"
            [attr.aria-label]="c.label + ' breiter'"
            [disabled]="c.hidden || c.id === fillId()"
            (click)="widthChange.emit({ id: c.id, direction: 1 })"
          >
            +
          </button>
        </li>
      }
    </ul>
    <div class="actions">
      <button type="button" (click)="resetLayout.emit()">Zurücksetzen</button>
      <button type="button" (click)="closed.emit()">Schließen</button>
    </div>
  `,
  styles: `
    :host {
      position: absolute;
      z-index: 3;
      min-width: 300px;
      max-height: calc(100% - 8px);
      overflow: auto;
      padding: 6px;
      background: var(--bg-raised);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: 0 4px 16px rgb(0 0 0 / 35%);
      font-family: var(--font-ui);
      font-size: 12px;
    }
    .title {
      padding: 2px 4px 6px;
      font-weight: 600;
    }
    ul {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li {
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 1px 2px;
      border-radius: var(--radius);
    }
    li.current {
      background: var(--bg-hover);
    }
    label {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      white-space: nowrap;
    }
    li button {
      padding: 1px 6px;
    }
    .width {
      min-width: 52px;
      text-align: right;
      color: var(--text-dim);
      font-variant-numeric: tabular-nums;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 4px;
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid var(--border);
    }
  `,
})
export class ColumnMenuComponent {
  readonly columns = input.required<ViewColumn[]>();
  readonly x = input(0);
  readonly y = input(0);
  /** The column the menu was opened for: its checkbox gets the focus. */
  readonly focusId = input<string | null>(null);

  readonly hide = output<{ id: string; hidden: boolean }>();
  readonly move = output<{ id: string; direction: -1 | 1 }>();
  readonly widthChange = output<{ id: string; direction: -1 | 1 }>();
  readonly resetLayout = output<void>();
  readonly closed = output<void>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly messageId = MESSAGE_ID;
  /** The last shown column fills the view: no width of its own. */
  protected readonly fillId = computed(() => lastShown(this.columns())?.id ?? null);
  /** After a move the focus follows the column (its button, or the checkbox at an end). */
  private moved: { id: string; label: string } | null = null;

  constructor() {
    afterNextRender(() => this.focus(this.focusId() ?? this.columns()[0]?.id));
    effect(() => {
      this.columns();
      const moved = untracked(() => this.moved);
      if (!moved) return;
      this.moved = null;
      setTimeout(() => this.focus(moved.id, moved.label));
    });
  }

  protected movable(id: string, direction: -1 | 1): boolean {
    return canMove(this.columns(), id, direction);
  }

  protected moveBy(id: string, direction: -1 | 1): void {
    this.moved = { id, label: direction < 0 ? 'nach links' : 'nach rechts' };
    this.move.emit({ id, direction });
  }

  private focus(id: string | undefined, button?: string): void {
    if (!id) return;
    const row = this.host.nativeElement.querySelector<HTMLElement>(
      `li[data-col="${CSS.escape(id)}"]`,
    );
    const target =
      (button &&
        row?.querySelector<HTMLButtonElement>(`button[aria-label$="${button}"]:not(:disabled)`)) ||
      row?.querySelector<HTMLInputElement>('input:not(:disabled)') ||
      row?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    target?.focus();
  }

  protected onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.closed.emit();
    }
  }
}
