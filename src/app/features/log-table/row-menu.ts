import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  inject,
  input,
  output,
} from '@angular/core';

export interface RowMenuItem {
  id: RowMenuAction;
  label: string;
  /** Key that does the same in the log, shown on the right. */
  key?: string;
  /** Not possible now; `title` says why. */
  disabled?: boolean;
  title?: string;
}

export type RowMenuAction =
  | 'filter-text'
  | 'exclude-text'
  | 'filter-text-tab'
  | 'filter-value'
  | 'filter-value-tab'
  | 'same-event-id'
  | 'column-from-selection'
  | 'from-here'
  | 'to-here'
  | 'note'
  | 'share-markdown'
  | 'share-jira';

/** Where the menu was opened: marked text, a cell with a value (column view), a line. */
export interface RowMenuContext {
  selectedText: string;
  /** Column label and value of the cell, for a head line in the column view. */
  cell: { label: string; value: string } | null;
  hasLine: boolean;
  /** Why no filter tab can open (prompt 013: 8 per file), or null. */
  tabLimit?: string | null;
  /** The entry under the pointer has a note (prompt 015). */
  hasNote?: boolean;
  /** Prompt 018: the event ID of a Windows event under the pointer, for the quick filter. */
  eventId?: string | null;
}

const short = (text: string): string => (text.length > 30 ? `${text.slice(0, 30)}…` : text);

/** The quick ways that fit where the menu was opened (prompt 010). */
export function rowMenuItems(context: RowMenuContext): RowMenuItem[] {
  const items: RowMenuItem[] = [];
  const text = context.selectedText.trim().replace(/\s+/g, ' ');
  if (text) {
    items.push({ id: 'filter-text', label: `Filtern auf „${short(text)}“`, key: 'I' });
    items.push({ id: 'exclude-text', label: `Ausschließen: „${short(text)}“`, key: 'Shift+I' });
    // Prompt 013: the same as a filter tab, the view of this tab stays.
    items.push({
      id: 'filter-text-tab',
      label: `In neuem Tab filtern auf „${short(text)}“`,
      ...tabState(context),
    });
    // Prompt 011: the marked value as a column of its own.
    if (context.hasLine) items.push({ id: 'column-from-selection', label: 'Spalte aus Auswahl …' });
  }
  if (context.cell) {
    const value = context.cell.value.trim();
    items.push({
      id: 'filter-value',
      label: `Filtern nach ${context.cell.label} = „${short(value)}“`,
    });
    items.push({
      id: 'filter-value-tab',
      label: `In neuem Tab: ${context.cell.label} = „${short(value)}“`,
      ...tabState(context),
    });
  }
  // Prompt 018: Windows events, the same event ID wherever the line was clicked.
  const eventId = context.eventId?.trim();
  if (eventId) items.push({ id: 'same-event-id', label: `Gleiche Event-ID (${short(eventId)})` });
  if (context.hasLine) {
    items.push({ id: 'from-here', label: 'Abschnitt ab hier', key: '>' });
    items.push({ id: 'to-here', label: 'Abschnitt bis hier', key: '<' });
    // Prompt 015: a note on the entry, the selection for a ticket.
    items.push({
      id: 'note',
      label: context.hasNote ? 'Notiz bearbeiten …' : 'Notiz …',
      key: 'Shift+M',
    });
    items.push({ id: 'share-markdown', label: 'Als Markdown kopieren' });
    items.push({ id: 'share-jira', label: 'Als Jira kopieren' });
  }
  return items;
}

function tabState(context: RowMenuContext): Pick<RowMenuItem, 'disabled' | 'title'> {
  return context.tabLimit ? { disabled: true, title: context.tabLimit } : {};
}

/**
 * The context menu of a log line (prompt 010): quick ways into the filter tree. Not a native menu: a list of
 * menu items, arrows move, Enter chooses, Escape closes; the view gives the focus back.
 */
@Component({
  selector: 'app-row-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'menu',
    'aria-label': 'Zeile',
    class: 'lt-rowmenu',
    '[style.left.px]': 'x()',
    '[style.top.px]': 'y()',
    '(keydown)': 'onKey($event)',
  },
  template: `
    @for (item of items(); track item.id) {
      <button
        type="button"
        role="menuitem"
        tabindex="-1"
        [disabled]="item.disabled ?? false"
        [attr.aria-disabled]="item.disabled ? true : null"
        [title]="item.title ?? ''"
        (click)="choose.emit(item.id)"
      >
        <span class="label">{{ item.label }}</span>
        @if (item.key) {
          <kbd>{{ item.key }}</kbd>
        }
      </button>
    }
  `,
  styles: `
    :host {
      position: absolute;
      z-index: 3;
      display: flex;
      flex-direction: column;
      min-width: 220px;
      max-width: min(420px, calc(100% - 8px));
      padding: 4px;
      background: var(--bg-raised);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: 0 4px 16px rgb(0 0 0 / 35%);
      font-family: var(--font-ui);
      font-size: 12px;
    }
    button {
      display: flex;
      gap: 12px;
      align-items: center;
      padding: 4px 8px;
      border: none;
      background: none;
      color: inherit;
      text-align: left;
    }
    button:hover,
    button:focus-visible {
      background: var(--bg-hover);
    }
    button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    .label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    kbd {
      color: var(--text-dim);
      font-family: var(--font-ui);
    }
  `,
})
export class RowMenuComponent {
  readonly items = input.required<RowMenuItem[]>();
  readonly x = input(0);
  readonly y = input(0);

  readonly choose = output<RowMenuAction>();
  readonly closed = output<void>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    afterNextRender(() => this.buttons()[0]?.focus());
  }

  private buttons(): HTMLButtonElement[] {
    return [
      ...this.host.nativeElement.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
    ];
  }

  protected onKey(event: KeyboardEvent): void {
    const buttons = this.buttons();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    switch (event.key) {
      case 'Escape':
      case 'Tab':
        this.closed.emit();
        break;
      case 'ArrowDown':
        next = (index + 1) % buttons.length;
        break;
      case 'ArrowUp':
        next = (index - 1 + buttons.length) % buttons.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = buttons.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (next >= 0) buttons[next]?.focus();
  }
}
