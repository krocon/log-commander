import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  input,
  viewChild,
} from '@angular/core';
import { McpProposal } from './mcp.service';

/**
 * A proposal of the AI (prompt 022, design E6): what it wants to do, in full, and the user decides. Enter does not
 * confirm (only a click or ⌘/Strg+Enter): a proposal can come in while the user types elsewhere. Escape declines.
 */
@Component({
  selector: 'app-mcp-proposal-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown)': 'onKey($event)' },
  template: `
    <dialog
      #dialog
      aria-labelledby="mcp-proposal-title"
      aria-describedby="mcp-proposal-details"
      (cancel)="$event.preventDefault(); decide(false)"
    >
      <p class="badge">Vorschlag der KI</p>
      <h2 id="mcp-proposal-title">{{ proposal().title }}</h2>
      <ul id="mcp-proposal-details" class="details">
        @for (line of proposal().details; track $index) {
          <li>{{ line }}</li>
        }
      </ul>
      @if (proposal().note; as note) {
        <p class="note">{{ note }}</p>
      }
      <p class="hint">Escape lehnt ab · ⌘/Strg+Enter erlaubt</p>
      <div class="actions">
        <button #decline type="button" (click)="decide(false)">Ablehnen</button>
        <button type="button" class="primary" (click)="decide(true)">Erlauben</button>
      </div>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(560px, 92vw);
      padding: 16px;
      background: var(--bg-panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 45%);
    }
    .badge {
      display: inline-block;
      margin: 0 0 6px;
      padding: 1px 8px;
      border: 1px solid var(--accent);
      border-radius: 999px;
      color: var(--accent);
      font-size: 11px;
      font-weight: 600;
    }
    h2 {
      margin: 0 0 10px;
      font-size: 15px;
    }
    .details {
      max-height: 40vh;
      overflow: auto;
      margin: 0;
      padding: 8px 10px;
      list-style: none;
      background: var(--bg-app);
      border: 1px solid var(--border);
      border-radius: 6px;
      font-family: var(--font-mono, monospace);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .note {
      margin: 10px 0 0;
      white-space: pre-wrap;
      font-size: 12px;
    }
    .hint {
      margin: 10px 0 0;
      color: var(--text-dim);
      font-size: 11.5px;
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
export class McpProposalDialogComponent implements OnInit {
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly decline = viewChild.required<ElementRef<HTMLButtonElement>>('decline');

  readonly proposal = input.required<McpProposal>();
  private returnTo: HTMLElement | null = null;
  private done = false;

  ngOnInit(): void {
    this.returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.dialog().nativeElement.showModal();
    // The safe choice has the focus: a stray Enter declines.
    this.decline().nativeElement.focus();
  }

  protected onKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      this.decide(true);
    }
  }

  protected decide(yes: boolean): void {
    if (this.done) return;
    this.done = true;
    this.dialog().nativeElement.close();
    this.returnTo?.focus();
    this.proposal().answer(yes);
  }
}
