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
import { NgTemplateOutlet } from '@angular/common';
import { FieldOp, FilterCondType, LEVELS, Level } from '../../core/log/log.models';
import { describeLevels } from '../sessions/filter-logic';
import {
  COND_TYPE_LABELS,
  FIELD_OP_LABELS,
  FilterCondNode,
  ROOT_ID,
  addNode,
  findNode,
  removeNode,
  updateNode,
} from '../sessions/filter-tree';
import { LogSessionService } from '../sessions/log-session.service';
import { SessionState } from '../sessions/session-state';
import { ConditionForm, emptyForm, formOf, toCond } from './condition-form';

/** What the dialog works on: a new condition for a group, or an existing one. */
export interface ConditionEdit {
  /** The id the condition has (or gets) in the tree. */
  nodeId: string;
  parentId: string;
  /** The node before editing; null for a new one. */
  original: FilterCondNode | null;
}

const TYPES: readonly FilterCondType[] = ['text', 'level', 'field', 'time', 'range', 'lines'];
const OPS: readonly FieldOp[] = ['eq', 'contains', 'regex', 'gt', 'lt', 'between'];

/**
 * Form for a condition of the filter tree (prompt 010). Every change goes into the tree right away (the
 * service bundles them into one filter job), so the view and the backend's check follow while typing; the
 * error the backend names for this node shows here. Cancel puts the old condition back (or removes a new one).
 */
@Component({
  selector: 'app-condition-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog (cancel)="cancel($event)" aria-labelledby="cond-title" aria-modal="true">
      <form (submit)="done($event)">
        <h2 id="cond-title">
          {{ edit().original ? 'Bedingung bearbeiten' : 'Bedingung hinzufügen' }}
        </h2>
        <div class="row">
          <label for="cond-type">Art</label>
          <select id="cond-type" [value]="form().type" (change)="setType(value($event))">
            @for (t of types; track t) {
              <option [value]="t" [selected]="t === form().type">{{ typeLabels[t] }}</option>
            }
          </select>
          <label class="check">
            <input
              type="checkbox"
              [checked]="form().negate"
              (change)="set('negate', checked($event))"
            />
            Nicht (ausschließen)
          </label>
        </div>
        @switch (form().type) {
          @case ('text') {
            <div class="row">
              <label for="cond-text">Text</label>
              <input
                id="cond-text"
                class="grow mono"
                autocomplete="off"
                spellcheck="false"
                [value]="form().text"
                (input)="set('text', value($event))"
              />
            </div>
            <ng-container *ngTemplateOutlet="flags" />
          }
          @case ('level') {
            <fieldset class="levels">
              <legend>Level (eine Zeile des Eintrags)</legend>
              @for (level of levels; track level) {
                <label class="check">
                  <input
                    type="checkbox"
                    [checked]="form().levels.includes(level)"
                    (change)="toggleLevel(level, checked($event))"
                  />
                  {{ levelLabel(level) }}
                </label>
              }
            </fieldset>
          }
          @case ('field') {
            <div class="row">
              <label for="cond-column">Spalte</label>
              <select id="cond-column" (change)="set('column', value($event))">
                @for (c of columns(); track c.id) {
                  <option [value]="c.id" [selected]="c.id === form().column">{{ c.label }}</option>
                }
              </select>
              <label for="cond-op" class="visually-hidden">Operator</label>
              <select id="cond-op" (change)="setOp(value($event))">
                @for (op of ops; track op) {
                  <option [value]="op" [selected]="op === form().op">{{ opLabels[op] }}</option>
                }
              </select>
            </div>
            <div class="row">
              <label for="cond-value">Wert</label>
              <input
                id="cond-value"
                class="grow mono"
                autocomplete="off"
                spellcheck="false"
                [value]="form().value"
                (input)="set('value', value($event))"
              />
              @if (form().op === 'between') {
                <label for="cond-value2">und</label>
                <input
                  id="cond-value2"
                  class="grow mono"
                  autocomplete="off"
                  [value]="form().value2"
                  (input)="set('value2', value($event))"
                />
              }
            </div>
            <p class="hint">Gilt für den Kopf des Eintrags. Zahlenspalten vergleichen als Zahl.</p>
          }
          @case ('time') {
            <div class="row">
              <label for="cond-from">Von</label>
              <input
                id="cond-from"
                class="grow mono"
                placeholder="2024-01-15 10:00:00"
                [value]="form().from"
                (input)="set('from', value($event))"
              />
            </div>
            <div class="row">
              <label for="cond-to">Bis</label>
              <input
                id="cond-to"
                class="grow mono"
                placeholder="2024-01-15 11:00"
                [value]="form().to"
                (input)="set('to', value($event))"
              />
            </div>
            <p class="hint">Zeitstempel des Eintragskopfs; ein Ende darf offen bleiben.</p>
          }
          @case ('range') {
            <div class="row">
              <label for="cond-start">Start</label>
              <input
                id="cond-start"
                class="grow mono"
                autocomplete="off"
                spellcheck="false"
                [value]="form().text"
                (input)="set('text', value($event))"
              />
            </div>
            <div class="row">
              <label for="cond-end">Ende</label>
              <input
                id="cond-end"
                class="grow mono"
                autocomplete="off"
                spellcheck="false"
                placeholder="leer: bis zum Dateiende"
                [value]="form().end"
                (input)="set('end', value($event))"
              />
            </div>
            <ng-container *ngTemplateOutlet="flags" />
            <label class="check">
              <input
                type="checkbox"
                [checked]="form().inclusive"
                (change)="set('inclusive', checked($event))"
              />
              Start- und Endzeile zeigen
            </label>
          }
          @case ('lines') {
            <div class="row">
              <label for="cond-first">Von Zeile</label>
              <input
                id="cond-first"
                class="num"
                inputmode="numeric"
                [value]="form().firstLine"
                (input)="set('firstLine', value($event))"
              />
              <label for="cond-last">bis</label>
              <input
                id="cond-last"
                class="num"
                inputmode="numeric"
                [value]="form().lastLine"
                (input)="set('lastLine', value($event))"
              />
            </div>
          }
        }
        <ng-template #flags>
          <div class="row">
            <label class="check">
              <input
                type="checkbox"
                [checked]="form().isRegex"
                (change)="set('isRegex', checked($event))"
              />
              Regex
            </label>
            <label class="check">
              <input
                type="checkbox"
                [checked]="form().caseSensitive"
                (change)="set('caseSensitive', checked($event))"
              />
              Groß-/Kleinschreibung
            </label>
          </div>
        </ng-template>
        @if (problem(); as message) {
          <p class="error" role="alert">{{ message }}</p>
        }
        <div class="actions">
          <button type="button" (click)="cancel()">Abbrechen</button>
          <button type="submit" class="primary" [disabled]="!complete()">Fertig</button>
        </div>
      </form>
    </dialog>
  `,
  imports: [NgTemplateOutlet],
  styles: `
    dialog {
      width: min(480px, 92vw);
      padding: 14px;
      background: var(--bg-panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      font-size: 12px;
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 45%);
    }
    h2 {
      margin: 0 0 10px;
      font-size: 13px;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 8px;
    }
    .row > label:not(.check) {
      min-width: 56px;
    }
    .grow {
      flex: 1;
      min-width: 0;
    }
    .mono {
      font-family: var(--font-mono);
    }
    .num {
      width: 90px;
    }
    .check {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-right: 8px;
    }
    fieldset {
      margin: 0 0 8px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    .hint {
      margin: 0 0 8px;
      color: var(--text-dim);
    }
    .error {
      margin: 0 0 8px;
      color: var(--danger);
      overflow-wrap: anywhere;
    }
    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 6px;
    }
    .primary {
      background: var(--accent);
      color: var(--accent-text);
      font-weight: 600;
    }
  `,
})
export class ConditionDialogComponent implements OnInit {
  readonly session = input.required<SessionState>();
  readonly edit = input.required<ConditionEdit>();
  /** True when the condition was kept, false when cancelled. */
  readonly closed = output<boolean>();

  private readonly sessions = inject(LogSessionService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly types = TYPES;
  protected readonly ops = OPS;
  protected readonly typeLabels = COND_TYPE_LABELS;
  protected readonly opLabels = FIELD_OP_LABELS;
  protected readonly levels: readonly Level[] = [...LEVELS].reverse();

  protected readonly form = signal<ConditionForm>(emptyForm());
  protected readonly columns = computed(() => this.session().columns()?.columns ?? []);
  private readonly result = computed(() => toCond(this.form()));
  protected readonly complete = computed(() => 'cond' in this.result());
  /** What is missing, or what the backend said about this node. */
  protected readonly problem = computed(() => {
    const result = this.result();
    if ('missing' in result) return this.touched() ? result.missing : null;
    const error = this.session().treeError();
    return error?.nodeId === this.edit().nodeId ? error.message : null;
  });
  private readonly touched = signal(false);
  private finished = false;

  ngOnInit(): void {
    const { original } = this.edit();
    const column = this.columns().find((c) => c.id === 'message')?.id ?? this.columns()[0]?.id;
    this.form.set(original ? formOf(original.cond, original.negate, column) : emptyForm(column));
    this.dialog().nativeElement.showModal();
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected levelLabel(level: Level): string {
    return describeLevels(new Set([level]));
  }

  protected set<K extends keyof ConditionForm>(key: K, value: ConditionForm[K]): void {
    this.touched.set(true);
    this.form.update((f) => ({ ...f, [key]: value }));
    this.apply();
  }

  protected setType(type: string): void {
    if (TYPES.includes(type as FilterCondType)) this.set('type', type as FilterCondType);
  }

  protected setOp(op: string): void {
    if (OPS.includes(op as FieldOp)) this.set('op', op as FieldOp);
  }

  protected toggleLevel(level: Level, on: boolean): void {
    const levels = this.form().levels.filter((l) => l !== level);
    if (on) levels.push(level);
    this.set('levels', levels);
  }

  /** The condition as typed so far into the tree; an incomplete one waits. */
  private apply(): void {
    const result = this.result();
    if (!('cond' in result)) return;
    const { nodeId, parentId } = this.edit();
    const session = this.session();
    const tree = session.filterTree();
    const existing = findNode(tree, nodeId);
    const negate = this.form().negate;
    const next = existing
      ? updateNode(tree, nodeId, (n) => ({ ...n, negate, cond: result.cond }) as FilterCondNode)
      : addNode(tree, findNode(tree, parentId) ? parentId : ROOT_ID, {
          kind: 'cond',
          id: nodeId,
          negate,
          enabled: true,
          cond: result.cond,
        });
    this.sessions.setTree(session, next);
  }

  protected done(event: Event): void {
    event.preventDefault();
    if (!this.complete()) {
      this.touched.set(true);
      return;
    }
    this.apply();
    this.close(true);
  }

  protected cancel(event?: Event): void {
    event?.preventDefault();
    const { nodeId, original } = this.edit();
    const session = this.session();
    const tree = session.filterTree();
    if (original) {
      if (findNode(tree, nodeId)) {
        this.sessions.setTree(
          session,
          updateNode(tree, nodeId, () => original),
        );
      }
    } else if (findNode(tree, nodeId)) {
      this.sessions.setTree(session, removeNode(tree, nodeId));
    }
    this.close(false);
  }

  private close(kept: boolean): void {
    if (this.finished) return;
    this.finished = true;
    this.dialog().nativeElement.close();
    this.closed.emit(kept);
  }
}
