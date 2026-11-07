import { ChangeDetectionStrategy, Component, OnDestroy, input, output } from '@angular/core';
import { SplitPane, clampSize, dragSize, keySize } from './splitter-logic';

/**
 * A bar between two panes that sets the size of one of them (prompt 004, reused by the sidebar of 005).
 * Mouse and pen through Pointer Events, keyboard on focus: arrows move (Shift: 10 times), Home/End to the
 * bounds, double click back to the default. `sizeChange` reports every step, `sizeCommit` the end of a
 * gesture: store settings only on the latter.
 */
@Component({
  selector: 'app-splitter',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'separator',
    tabindex: '0',
    class: 'splitter',
    '[class.horizontal]': "orientation() === 'horizontal'",
    '[class.vertical]': "orientation() === 'vertical'",
    '[attr.aria-orientation]': 'orientation()',
    '[attr.aria-valuenow]': 'size()',
    '[attr.aria-valuemin]': 'min()',
    '[attr.aria-valuemax]': 'max()',
    '[attr.aria-label]': 'label()',
    '[attr.aria-controls]': 'controls()',
    '[attr.title]': 'title()',
    '(pointerdown)': 'onPointerDown($event)',
    '(keydown)': 'onKey($event)',
    '(dblclick)': 'reset()',
  },
  template: '',
  styles: `
    /* A slim visible bar with a centred grip; the hit area reaches 4 px further on both sides. */
    :host {
      position: relative;
      z-index: 2;
      flex: none;
      background: var(--splitter-bg);
      touch-action: none;
      outline: none;
    }
    :host::before {
      content: '';
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      border-radius: 1px;
      background: var(--splitter-grip);
      pointer-events: none;
    }
    :host::after {
      content: '';
      position: absolute;
    }
    :host(.horizontal) {
      height: 6px;
      cursor: row-resize;
      border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
    }
    :host(.horizontal)::before {
      width: 32px;
      height: 2px;
    }
    :host(.horizontal)::after {
      inset: -5px 0;
    }
    :host(.vertical) {
      width: 6px;
      cursor: col-resize;
      border-left: 1px solid var(--border);
      border-right: 1px solid var(--border);
    }
    :host(.vertical)::before {
      width: 2px;
      height: 32px;
    }
    :host(.vertical)::after {
      inset: 0 -5px;
    }
    :host(:hover),
    :host(.dragging) {
      background: var(--splitter-hover-bg);
    }
    :host(.dragging)::before {
      background: var(--accent);
    }
    :host(:focus-visible) {
      background: var(--accent);
    }
    :host(:focus-visible)::before {
      background: var(--accent-text);
    }
  `,
})
export class SplitterComponent implements OnDestroy {
  /** `horizontal`: a bar between a top and a bottom pane (the ARIA meaning). */
  readonly orientation = input<'horizontal' | 'vertical'>('horizontal');
  /** The pane whose size this is: before (top/left) or after (bottom/right) the bar. */
  readonly pane = input<SplitPane>('after');
  readonly size = input.required<number>();
  readonly min = input(0);
  readonly max = input(Number.MAX_SAFE_INTEGER);
  /** Double click goes back to this. */
  readonly defaultSize = input<number | null>(null);
  readonly label = input('Größe ändern');
  readonly title = input<string | null>(null);
  /** Id of the pane it resizes. */
  readonly controls = input<string | null>(null);

  readonly sizeChange = output<number>();
  readonly sizeCommit = output<number>();

  private drag: { pointerId: number; startPos: number; startSize: number; last: number } | null =
    null;
  private host: HTMLElement | null = null;

  ngOnDestroy(): void {
    this.endDrag(false);
  }

  protected onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || this.drag) return;
    event.preventDefault();
    const host = event.currentTarget as HTMLElement;
    this.host = host;
    host.focus({ preventScroll: true });
    try {
      host.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic events have no active pointer; the window listeners below still follow it.
    }
    this.drag = {
      pointerId: event.pointerId,
      startPos: this.posOf(event),
      startSize: this.size(),
      last: this.size(),
    };
    host.classList.add('dragging');
    document.body.classList.add('resizing', `resizing-${this.orientation()}`);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const next = dragSize(
      drag.startSize,
      drag.startPos,
      this.posOf(event),
      this.pane(),
      this.min(),
      this.max(),
    );
    if (next === drag.last) return;
    drag.last = next;
    this.sizeChange.emit(next);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.drag && event.pointerId === this.drag.pointerId) this.endDrag(true);
  };

  private endDrag(commit: boolean): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    document.body.classList.remove('resizing', 'resizing-horizontal', 'resizing-vertical');
    if (this.host) {
      this.host.classList.remove('dragging');
      try {
        if (this.host.hasPointerCapture(drag.pointerId)) {
          this.host.releasePointerCapture(drag.pointerId);
        }
      } catch {
        // Nothing captured.
      }
    }
    if (commit && drag.last !== drag.startSize) this.sizeCommit.emit(drag.last);
  }

  protected onKey(event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const next = keySize(
      this.size(),
      event.key,
      event.shiftKey,
      this.orientation(),
      this.pane(),
      this.min(),
      this.max(),
    );
    if (next === null) return;
    // The keys must not also scroll the log behind it.
    event.preventDefault();
    event.stopPropagation();
    this.emit(next);
  }

  protected reset(): void {
    const fallback = this.defaultSize();
    if (fallback !== null) this.emit(clampSize(fallback, this.min(), this.max()));
  }

  private emit(size: number): void {
    this.sizeChange.emit(size);
    this.sizeCommit.emit(size);
  }

  private posOf(event: PointerEvent): number {
    return this.orientation() === 'horizontal' ? event.clientY : event.clientX;
  }
}
