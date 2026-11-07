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
import { describeError, toAppError } from '../../core/errors/app-error';
import { LogApi } from '../../core/log/log-api';
import { ExtractRule, FieldSuggestion, LogLine, ValueKind } from '../../core/log/log.models';
import { MAX_EXTRACT_RULES } from '../../core/settings/settings.models';
import { FieldsRequest, LogSessionService } from '../sessions/log-session.service';
import {
  SuggestionPick,
  VALUE_KINDS,
  acceptSuggestions,
  formatColumns,
  formatShare,
  formatValue,
  freeName,
  newRuleId,
  picksOf,
  ruleIssues,
} from './fields-logic';
import { ruleFromSelection } from './rule-from-selection';

/** Loaded lines the preview of a new rule looks at. */
const PREVIEW_LINES = 400;
const PREVIEW_VALUES = 5;
const PREVIEW_DELAY_MS = 200;

interface Draft extends ExtractRule {
  /** The line the rule was built from, and what was marked in it. */
  sample: string;
  marked: string;
}

interface Preview {
  hits: number;
  lines: number;
  values: string[];
}

/**
 * The dialog „Felder“ (prompt 011): suggestions with checkboxes, the rules of the format (edit, delete), a new
 * rule from marked text with a preview over the loaded lines. Every change goes through the backend, which checks
 * the rule and applies it to all open tabs of the format; an error stays at its rule.
 */
@Component({
  selector: 'app-fields-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog (close)="closed.emit()" aria-labelledby="fields-title" class="fields">
      <h2 id="fields-title">Felder aus der Nachricht</h2>
      <p class="intro">
        Regeln holen Werte wie <code>cpu=72%</code> als eigene Spalte aus dem Text. Sie gelten für
        alle Dateien des Formats <b>{{ profileId() }}</b
        >, die Datei bleibt unverändert.
      </p>

      <section aria-labelledby="fields-suggestions">
        <h3 id="fields-suggestions">Vorschläge</h3>
        @if (suggesting()) {
          <p class="quiet" role="status">Suche Felder …</p>
        } @else if (picks().length) {
          <table class="grid">
            <thead>
              <tr>
                <th scope="col"><span class="sr">Übernehmen</span></th>
                <th scope="col">Name</th>
                <th scope="col">Typ</th>
                <th scope="col">Beispiele</th>
                <th scope="col" class="num">Anteil</th>
              </tr>
            </thead>
            <tbody>
              @for (pick of picks(); track pick.suggestion.rule.id; let i = $index) {
                <tr class="suggestion">
                  <td>
                    <input
                      type="checkbox"
                      [checked]="pick.picked"
                      [attr.aria-label]="'Vorschlag ' + pick.name + ' übernehmen'"
                      (change)="editPick(i, { picked: checked($event) })"
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      class="name"
                      aria-label="Name"
                      [value]="pick.name"
                      (input)="editPick(i, { name: value($event) })"
                    />
                  </td>
                  <td>
                    <select aria-label="Typ" (change)="editPick(i, { kind: kindOf($event) })">
                      @for (k of kinds; track k.kind) {
                        <option [value]="k.kind" [selected]="k.kind === pick.kind">
                          {{ k.label }}
                        </option>
                      }
                    </select>
                  </td>
                  <td class="mono examples">{{ pick.suggestion.examples.join(' · ') }}</td>
                  <td class="num">{{ share(pick.suggestion.share) }}</td>
                </tr>
              }
            </tbody>
          </table>
          @if (pickError(); as error) {
            <p class="error" role="alert">{{ error }}</p>
          }
          <div class="row">
            <button
              type="button"
              class="primary"
              [disabled]="busy() || !anyPicked()"
              (click)="acceptPicks()"
            >
              Ausgewählte übernehmen
            </button>
          </div>
        } @else {
          <p class="quiet">Keine Vorschläge für diese Datei.</p>
        }
      </section>

      <section aria-labelledby="fields-rules">
        <h3 id="fields-rules">Regeln ({{ rules().length }} von {{ maxRules }})</h3>
        @if (!rules().length) {
          <p class="quiet">Noch keine Regeln für dieses Format.</p>
        } @else {
          <table class="grid rules">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Quelle</th>
                <th scope="col">Muster (eine Gruppe)</th>
                <th scope="col">Typ</th>
                <th scope="col">Einheit</th>
                <th scope="col"><span class="sr">Aktion</span></th>
              </tr>
            </thead>
            <tbody>
              @for (rule of rules(); track rule.id; let i = $index) {
                <tr class="rule" [class.invalid]="issueOf(rule.id)">
                  <td>
                    <input
                      type="text"
                      class="name"
                      aria-label="Name"
                      [value]="rule.name"
                      (input)="editRule(i, { name: value($event) })"
                    />
                  </td>
                  <td>
                    <select
                      aria-label="Quellspalte"
                      (change)="editRule(i, { column: value($event) })"
                    >
                      @for (c of sourceColumns(); track c.id) {
                        <option [value]="c.id" [selected]="c.id === rule.column">
                          {{ c.label }}
                        </option>
                      }
                      @if (!hasSource(rule.column)) {
                        <option [value]="rule.column" selected>{{ rule.column }}</option>
                      }
                    </select>
                  </td>
                  <td>
                    <input
                      type="text"
                      class="mono pattern"
                      aria-label="Muster"
                      spellcheck="false"
                      [value]="rule.pattern"
                      (input)="editRule(i, { pattern: value($event) })"
                    />
                  </td>
                  <td>
                    <select aria-label="Typ" (change)="editRule(i, { kind: kindOf($event) })">
                      @for (k of kinds; track k.kind) {
                        <option [value]="k.kind" [selected]="k.kind === rule.kind">
                          {{ k.label }}
                        </option>
                      }
                    </select>
                  </td>
                  <td>
                    <input
                      type="text"
                      class="unit"
                      aria-label="Einheit ohne Angabe"
                      placeholder="–"
                      [value]="rule.unit ?? ''"
                      (input)="editRule(i, { unit: value($event) || null })"
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      [attr.aria-label]="'Regel ' + rule.name + ' löschen'"
                      [disabled]="busy()"
                      (click)="removeRule(i)"
                    >
                      Löschen
                    </button>
                  </td>
                </tr>
                @if (issueOf(rule.id); as issue) {
                  <tr class="issue">
                    <td colspan="6" role="alert">{{ rule.name || 'Regel' }}: {{ issue }}</td>
                  </tr>
                }
              }
            </tbody>
          </table>
        }
        @if (rulesError(); as error) {
          <p class="error" role="alert">{{ error }}</p>
        }
        <div class="row">
          <button
            type="button"
            [disabled]="busy() || !dirty() || localIssues().size > 0"
            (click)="saveRules()"
          >
            Änderungen speichern
          </button>
        </div>
      </section>

      <section aria-labelledby="fields-new">
        <h3 id="fields-new">Spalte aus Markierung</h3>
        <div class="form">
          <label for="fields-sample">Zeile</label>
          <input
            id="fields-sample"
            type="text"
            class="mono"
            spellcheck="false"
            [value]="sample()"
            (input)="sample.set(value($event))"
          />
          <label for="fields-marked">Markierter Text</label>
          <div class="inline">
            <input
              id="fields-marked"
              type="text"
              class="mono"
              spellcheck="false"
              [value]="marked()"
              (input)="marked.set(value($event))"
              (keydown.enter)="buildDraft(); $event.preventDefault()"
            />
            <button type="button" [disabled]="!marked().trim()" (click)="buildDraft()">
              Muster bauen
            </button>
          </div>
        </div>
        @if (buildError(); as error) {
          <p class="error" role="alert">{{ error }}</p>
        }
        @if (draft(); as d) {
          <div class="form draft">
            <label for="fields-draft-name">Name</label>
            <input
              id="fields-draft-name"
              type="text"
              [value]="d.name"
              (input)="editDraft({ name: value($event) })"
            />
            <label for="fields-draft-pattern">Muster</label>
            <input
              id="fields-draft-pattern"
              type="text"
              class="mono"
              spellcheck="false"
              [value]="d.pattern"
              (input)="editDraft({ pattern: value($event) })"
            />
            <label for="fields-draft-kind">Typ</label>
            <div class="inline">
              <select id="fields-draft-kind" (change)="editDraft({ kind: kindOf($event) })">
                @for (k of kinds; track k.kind) {
                  <option [value]="k.kind" [selected]="k.kind === d.kind">{{ k.label }}</option>
                }
              </select>
              <input
                type="text"
                class="unit"
                aria-label="Einheit ohne Angabe"
                placeholder="Einheit"
                [value]="d.unit ?? ''"
                (input)="editDraft({ unit: value($event) || null })"
              />
            </div>
          </div>
          <p class="preview" role="status">
            @if (draftError(); as error) {
              <span class="error">{{ error }}</span>
            } @else if (preview(); as p) {
              Treffer in {{ p.hits }} von {{ p.lines }} geladenen Zeilen
              @if (p.values.length) {
                : <span class="mono">{{ p.values.join(' · ') }}</span>
              }
            } @else {
              Vorschau …
            }
          </p>
          <div class="row">
            <button
              type="button"
              class="primary"
              [disabled]="busy() || !!draftError() || !preview()"
              (click)="addDraft()"
            >
              Als Spalte anlegen
            </button>
          </div>
        }
      </section>

      <div class="actions">
        <button type="button" (click)="dialog.close()">Schließen</button>
      </div>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(860px, 94vw);
      max-height: 88vh;
      padding: 16px 18px;
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
      margin: 0 0 6px;
      font-size: 15px;
    }
    h3 {
      margin: 16px 0 6px;
      font-size: 13px;
    }
    .intro,
    .quiet {
      margin: 0;
      color: var(--text-dim);
    }
    code,
    .mono {
      font-family: var(--font-mono);
    }
    .grid {
      width: 100%;
      border-collapse: collapse;
    }
    .grid th {
      text-align: left;
      font-weight: 600;
      color: var(--text-dim);
      padding: 2px 4px;
    }
    .grid td {
      padding: 2px 4px;
      vertical-align: middle;
    }
    .num {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .examples {
      max-width: 260px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    input[type='text'] {
      box-sizing: border-box;
      width: 100%;
    }
    .name {
      min-width: 90px;
    }
    .pattern {
      min-width: 220px;
    }
    .unit {
      width: 70px !important;
    }
    .rule.invalid input.name,
    .rule.invalid input.pattern {
      border-color: var(--danger);
    }
    .issue td,
    .error {
      color: var(--danger);
      overflow-wrap: anywhere;
    }
    .error {
      margin: 6px 0 0;
    }
    .row {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 8px;
    }
    .form {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 6px 10px;
      align-items: center;
    }
    .draft {
      margin-top: 10px;
    }
    .inline {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .preview {
      margin: 8px 0 0;
      color: var(--text-dim);
      overflow-wrap: anywhere;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      margin-top: 16px;
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
    .sr {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
  `,
})
export class FieldsDialogComponent implements OnInit {
  readonly request = input.required<FieldsRequest>();
  readonly closed = output<void>();

  private readonly sessions = inject(LogSessionService);
  private readonly api = inject(LogApi);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly kinds = VALUE_KINDS;
  protected readonly maxRules = MAX_EXTRACT_RULES;
  protected readonly share = formatShare;

  private readonly session = computed(() => this.request().session);
  protected readonly profileId = computed(() => this.session().columns()?.profileId ?? '–');
  private readonly formatCols = computed(() => formatColumns(this.session().columns()));
  protected readonly sourceColumns = computed(() =>
    this.formatCols().filter((c) => c.kind !== 'level' && c.kind !== 'timestamp'),
  );

  protected readonly suggesting = signal(false);
  protected readonly picks = signal<SuggestionPick[]>([]);
  protected readonly pickError = signal<string | null>(null);
  protected readonly anyPicked = computed(() => this.picks().some((p) => p.picked));

  /** The rules as edited here; `saved` is what the backend has. */
  protected readonly rules = signal<ExtractRule[]>([]);
  private readonly saved = signal<ExtractRule[]>([]);
  protected readonly dirty = computed(
    () => JSON.stringify(this.rules()) !== JSON.stringify(this.saved()),
  );
  /** Problems found here (names), and the backend's error at a rule. */
  protected readonly localIssues = computed(() => ruleIssues(this.rules(), this.formatCols()));
  private readonly backendIssue = signal<{ id: string; message: string } | null>(null);
  protected readonly rulesError = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected readonly sample = signal('');
  protected readonly marked = signal('');
  protected readonly buildError = signal<string | null>(null);
  protected readonly draft = signal<Draft | null>(null);
  protected readonly draftError = signal<string | null>(null);
  protected readonly preview = signal<Preview | null>(null);
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private previewToken = 0;

  ngOnInit(): void {
    const session = this.session();
    const rules = this.sessions.rulesOf(session);
    this.rules.set(rules.map((r) => ({ ...r })));
    this.saved.set(rules);
    const draft = this.request().draft;
    if (draft) {
      this.sample.set(draft.text);
      this.marked.set(draft.text.slice(draft.start, draft.end));
      this.buildDraft(draft.start, draft.end, draft.column);
    } else {
      const selected = session.selection();
      const line =
        (selected ? this.loaded().find((l) => l.line === selected.anchor) : undefined) ??
        this.loaded().find((l) => !l.isContinuation);
      if (line) this.sample.set(this.sourceText(line, 'message'));
    }
    const hint = session.fieldHint();
    session.fieldHint.set(null);
    if (hint) this.picks.set(picksOf(hint, rules));
    else void this.loadSuggestions();
    this.dialog().nativeElement.showModal();
  }

  private async loadSuggestions(): Promise<void> {
    this.suggesting.set(true);
    try {
      const found: FieldSuggestion[] = await this.api.suggestFields(this.session().id);
      this.picks.set(picksOf(found, this.rules()));
    } catch (e) {
      this.pickError.set(describeError(toAppError(e)));
    } finally {
      this.suggesting.set(false);
    }
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected kindOf(event: Event): ValueKind {
    return this.value(event) as ValueKind;
  }

  protected hasSource(id: string): boolean {
    return this.sourceColumns().some((c) => c.id === id);
  }

  protected issueOf(id: string): string | null {
    const backend = this.backendIssue();
    if (backend?.id === id) return backend.message;
    return this.localIssues().get(id) ?? null;
  }

  protected editPick(index: number, change: Partial<SuggestionPick>): void {
    this.picks.update((all) => all.map((p, i) => (i === index ? { ...p, ...change } : p)));
  }

  protected editRule(index: number, change: Partial<ExtractRule>): void {
    this.backendIssue.set(null);
    this.rules.update((all) => all.map((r, i) => (i === index ? { ...r, ...change } : r)));
  }

  /** Saves a rule list; on an error the list stays as edited and the error at its rule. */
  private async store(rules: ExtractRule[]): Promise<boolean> {
    const issues = ruleIssues(rules, this.formatCols());
    const [firstIssue] = issues;
    if (firstIssue) {
      this.rules.set(rules);
      return false;
    }
    this.busy.set(true);
    this.rulesError.set(null);
    this.backendIssue.set(null);
    try {
      const error = await this.sessions.setExtractRules(this.session(), rules);
      if (error) {
        this.rules.set(rules);
        if (error.nodeId) this.backendIssue.set({ id: error.nodeId, message: error.message });
        else this.rulesError.set(describeError(error));
        return false;
      }
      this.rules.set(rules.map((r) => ({ ...r })));
      this.saved.set(rules);
      return true;
    } finally {
      this.busy.set(false);
    }
  }

  protected async acceptPicks(): Promise<void> {
    const picks = this.picks();
    const rules = acceptSuggestions(this.saved(), picks);
    if (rules.length > MAX_EXTRACT_RULES) {
      this.pickError.set(`Höchstens ${MAX_EXTRACT_RULES} Regeln je Format`);
      return;
    }
    const issues = ruleIssues(rules, this.formatCols());
    const [first] = issues;
    if (first) {
      this.pickError.set(first[1]);
      return;
    }
    this.pickError.set(null);
    if (await this.store(rules)) this.picks.set(picks.filter((p) => !p.picked));
  }

  protected async saveRules(): Promise<void> {
    await this.store(this.rules());
  }

  protected async removeRule(index: number): Promise<void> {
    // Deleting saves what was saved minus this rule; other edits stay open.
    const id = this.rules()[index]?.id;
    const edited = this.rules().filter((_, i) => i !== index);
    if (await this.store(this.saved().filter((r) => r.id !== id))) {
      this.rules.set(edited);
    }
  }

  // ---------------------------------------------------------------- new rule from marked text

  private loaded(): LogLine[] {
    return this.session().cache.loadedLines(PREVIEW_LINES);
  }

  /** The text of a column of a line (the whole line if the format has no such column or it is empty). */
  private sourceText(line: LogLine, column: string): string {
    const index = this.session()
      .columns()
      ?.columns.findIndex((c) => c.id === column);
    const span = index !== undefined && index >= 0 ? line.fields[index] : undefined;
    if (!span || span[1] <= span[0]) return line.isContinuation ? '' : line.text;
    return line.text.slice(span[0], span[1]);
  }

  protected buildDraft(start?: number, end?: number, column = 'message'): void {
    const text = this.sample();
    const marked = this.marked();
    if (start === undefined || end === undefined) {
      const at = text.indexOf(marked.trim());
      if (!marked.trim() || at < 0) {
        this.buildError.set('Der markierte Text kommt in der Zeile nicht vor');
        this.draft.set(null);
        return;
      }
      start = at;
      end = at + marked.trim().length;
    }
    const built = ruleFromSelection(text, start, end);
    if (!built) {
      this.buildError.set('Nichts markiert');
      this.draft.set(null);
      return;
    }
    this.buildError.set(null);
    this.draft.set({
      id: newRuleId(this.rules()),
      name: freeName(built.name, this.saved(), this.formatCols()),
      column: this.hasSource(column) || !this.sourceColumns().length ? column : 'message',
      pattern: built.pattern,
      kind: built.kind,
      unit: built.unit,
      sample: text,
      marked,
    });
    this.schedulePreview();
  }

  protected editDraft(change: Partial<ExtractRule>): void {
    this.draft.update((d) => (d ? { ...d, ...change } : d));
    this.schedulePreview();
  }

  private schedulePreview(): void {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.preview.set(null);
    this.previewTimer = setTimeout(() => void this.runPreview(), PREVIEW_DELAY_MS);
  }

  /** The draft on the loaded lines (their source column): the backend checks it and finds the values. */
  private async runPreview(): Promise<void> {
    const draft = this.draft();
    if (!draft) return;
    const token = ++this.previewToken;
    const name = draft.name.trim();
    const local = ruleIssues([...this.saved(), { ...draft, name }], this.formatCols()).get(
      draft.id,
    );
    if (local) {
      this.draftError.set(local);
      return;
    }
    const lines = this.loaded()
      .filter((l) => !l.isContinuation)
      .map((l) => this.sourceText(l, draft.column));
    const texts = lines.length ? lines : [draft.sample];
    try {
      const result = await this.api.previewExtractRule(this.ruleOf(draft), texts);
      if (token !== this.previewToken) return;
      const values: string[] = [];
      let hits = 0;
      result.spans.forEach((span, i) => {
        if (!span) return;
        hits++;
        if (values.length < PREVIEW_VALUES) {
          const raw = texts[i].slice(span[0], span[1]);
          const number = result.values[i];
          values.push(
            draft.kind === 'text' || draft.kind === 'number'
              ? raw
              : `${raw} (${formatValue(number, draft.kind)})`,
          );
        }
      });
      this.draftError.set(null);
      this.preview.set({ hits, lines: texts.length, values });
    } catch (e) {
      if (token !== this.previewToken) return;
      this.draftError.set(describeError(toAppError(e)));
    }
  }

  private ruleOf(draft: Draft): ExtractRule {
    return {
      id: draft.id,
      name: draft.name.trim(),
      column: draft.column,
      pattern: draft.pattern,
      kind: draft.kind,
      unit: draft.unit,
    };
  }

  protected async addDraft(): Promise<void> {
    const draft = this.draft();
    if (!draft) return;
    const rules = [...this.saved(), this.ruleOf(draft)];
    const issue = ruleIssues(rules, this.formatCols()).get(draft.id);
    if (issue) {
      this.draftError.set(issue);
      return;
    }
    if (await this.store(rules)) {
      this.draft.set(null);
      this.preview.set(null);
      this.marked.set('');
    } else {
      const backend = this.backendIssue();
      if (backend?.id === draft.id) {
        this.draftError.set(backend.message);
        // The draft is not a rule yet: the list shows what is saved.
        this.backendIssue.set(null);
        this.rules.set(this.saved().map((r) => ({ ...r })));
      }
    }
  }
}
