import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  computed,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { SettingsService } from '../../core/settings/settings.service';
import { Theme } from '../../core/theme/theme.models';
import { ThemeService } from '../../core/theme/theme.service';
import { CardBox, PickerCard, moveInGrid, pickerSections } from './theme-picker-logic';
import { ThemeThumb } from './theme-thumb';

/** Cards per row assumed when there is no layout (tests). */
const FALLBACK_COLUMNS = 4;

/**
 * The colour scheme picker (prompt 020): a grid of thumbnails, „System folgen“ first, then the dark and the
 * light schemes. Arrow keys and the pointer show a scheme at once (the preview of the `ThemeService`),
 * `Enter`/OK keeps it, `Esc`/Abbrechen/× go back to the scheme from before. A filter narrows the cards.
 */
@Component({
  selector: 'app-theme-picker',
  imports: [ThemeThumb],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog
      #dialog
      class="picker"
      aria-labelledby="theme-picker-title"
      (cancel)="$event.preventDefault(); cancel()"
      (close)="closed.emit()"
    >
      <header>
        <h2 id="theme-picker-title">Farbschema</h2>
        <button type="button" aria-label="Schließen" (click)="cancel()">×</button>
      </header>
      <div class="filter">
        <label for="theme-filter">Filter</label>
        <input
          #filterInput
          id="theme-filter"
          type="search"
          spellcheck="false"
          autocomplete="off"
          placeholder="Name, „hell“ oder „dunkel“"
          [value]="filter()"
          (input)="onFilter(filterInput.value)"
          (keydown)="onFilterKey($event)"
        />
        <span class="count" role="status">{{ shown() }} von {{ total() }} Schemata</span>
      </div>
      @if (overridesActive()) {
        <p class="note" role="note">
          Eigene Level-Farben sind aktiv und liegen über jedem Schema, auch in der Vorschau
          (Einstellungen ▸ Farben zurücksetzen).
        </p>
      }
      <div
        #grid
        class="grid"
        role="listbox"
        tabindex="-1"
        aria-label="Farbschemata"
        [attr.aria-activedescendant]="current() ? optionId(current()!) : null"
        (keydown)="onGridKey($event)"
        (pointerleave)="hover(null)"
      >
        @for (section of sections(); track section.key) {
          <div class="section" role="group" [attr.aria-label]="section.label">
            @if (section.key !== 'system') {
              <div class="section-head" aria-hidden="true">{{ section.label }}</div>
            }
            <div class="cards">
              @for (card of section.cards; track card.id) {
                <div
                  class="card"
                  role="option"
                  [id]="optionId(card.id)"
                  [attr.data-id]="card.id"
                  [attr.aria-selected]="card.id === current()"
                  [class.chosen]="card.id === current()"
                  [tabindex]="card.id === current() ? 0 : -1"
                  (click)="choose(card.id)"
                  (keydown.space)="$event.preventDefault(); choose(card.id)"
                  (dblclick)="ok()"
                  (pointerenter)="hover(card.id)"
                >
                  @if (card.id === 'system') {
                    <div class="split">
                      @if (pairThemes(); as pair) {
                        <app-theme-thumb [theme]="pair.light" />
                        <app-theme-thumb [theme]="pair.dark" />
                      }
                    </div>
                  } @else if (themeOf(card.id); as theme) {
                    <app-theme-thumb [theme]="theme" />
                  }
                  <span class="name">{{ card.name }}</span>
                  @if (card.id !== 'system') {
                    <span class="kind">{{ card.dark ? 'dunkel' : 'hell' }}</span>
                  }
                </div>
              }
            </div>
          </div>
        }
        @if (shown() === 0 && !systemShown()) {
          <p class="none" role="status">Kein Schema passt zum Filter.</p>
        }
      </div>
      @if (current() === 'system') {
        <div class="pair">
          <label>
            Hell
            <select id="theme-pair-light" (change)="setPair('light', $event)">
              @for (t of lightThemes(); track t.id) {
                <option [value]="t.id" [selected]="t.id === pair().light">{{ t.name }}</option>
              }
            </select>
          </label>
          <label>
            Dunkel
            <select id="theme-pair-dark" (change)="setPair('dark', $event)">
              @for (t of darkThemes(); track t.id) {
                <option [value]="t.id" [selected]="t.id === pair().dark">{{ t.name }}</option>
              }
            </select>
          </label>
        </div>
      }
      <footer>
        <span class="hint"
          >Pfeiltasten zeigen ein Schema sofort, Enter behält es, Esc kehrt zurück.</span
        >
        <button type="button" (click)="cancel()">Abbrechen</button>
        <button type="button" class="primary" [disabled]="current() === null" (click)="ok()">
          OK
        </button>
      </footer>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(880px, calc(100vw - 32px));
      max-height: calc(100vh - 48px);
      padding: 0;
      background: var(--bg-panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    dialog[open] {
      display: flex;
      flex-direction: column;
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 35%);
    }
    header,
    footer {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
    }
    header {
      justify-content: space-between;
      border-bottom: 1px solid var(--border);
    }
    footer {
      border-top: 1px solid var(--border);
    }
    h2 {
      margin: 0;
      font-size: 14px;
    }
    .filter {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px 4px;
      font-size: 12px;
    }
    .filter input {
      flex: 1;
      max-width: 320px;
    }
    .count,
    .hint,
    .section-head,
    .kind {
      color: var(--text-dim);
      font-size: 11.5px;
    }
    .hint {
      flex: 1;
    }
    .note {
      margin: 4px 14px 0;
      font-size: 12px;
      color: var(--text-dim);
    }
    .grid {
      overflow: auto;
      padding: 8px 14px 12px;
      outline: none;
    }
    .section-head {
      margin: 10px 0 4px;
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      gap: 10px;
    }
    .card {
      display: grid;
      gap: 3px;
      padding: 6px;
      border: 2px solid transparent;
      border-radius: 7px;
      cursor: pointer;
    }
    .card:hover {
      background: var(--bg-hover);
    }
    .card.chosen {
      border-color: var(--accent);
      background: var(--bg-raised);
    }
    .card:focus-visible {
      outline-offset: 2px;
    }
    .split {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 3px;
    }
    .name {
      font-size: 12.5px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .none {
      color: var(--text-dim);
    }
    .pair {
      display: flex;
      gap: 16px;
      padding: 8px 14px;
      border-top: 1px solid var(--border);
    }
    .pair label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
    }
    .primary {
      background: var(--accent);
      color: var(--accent-text);
    }
  `,
})
export class ThemePickerComponent implements OnInit {
  protected readonly theme = inject(ThemeService);
  private readonly settings = inject(SettingsService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly grid = viewChild.required<ElementRef<HTMLElement>>('grid');
  private readonly filterInput = viewChild.required<ElementRef<HTMLInputElement>>('filterInput');

  readonly closed = output<void>();

  /** The card of the scheme on screen before the picker opened. */
  private readonly before =
    this.theme.selection().mode === 'system' ? 'system' : this.theme.activeId();
  protected readonly filter = signal('');
  /** The chosen card (keyboard, click). */
  protected readonly current = signal<string | null>(this.before);
  /** The pair „System folgen“ uses, as chosen here. */
  protected readonly pair = signal({
    light: this.theme.selection().light,
    dark: this.theme.selection().dark,
  });
  private readonly hovered = signal<string | null>(null);
  private done = false;

  private readonly themes = computed(() => this.theme.catalog()?.themes ?? []);
  protected readonly sections = computed(() => pickerSections(this.themes(), this.filter()));
  protected readonly visible = computed<PickerCard[]>(() =>
    this.sections().flatMap((s) => [...s.cards]),
  );
  protected readonly shown = computed(() => this.visible().filter((c) => c.id !== 'system').length);
  protected readonly systemShown = computed(() => this.visible().some((c) => c.id === 'system'));
  protected readonly total = computed(() => this.themes().length);
  protected readonly lightThemes = computed(() => this.themes().filter((t) => !t.dark));
  protected readonly darkThemes = computed(() => this.themes().filter((t) => t.dark));
  protected readonly overridesActive = computed(
    () => Object.keys(this.settings.settings().colorOverrides).length > 0,
  );
  protected readonly pairThemes = computed(() => {
    const light = this.theme.find(this.pair().light) ?? this.theme.find('light');
    const dark = this.theme.find(this.pair().dark) ?? this.theme.find('dark');
    return light && dark ? { light, dark } : null;
  });

  constructor() {
    const preview = this.theme.preview;
    inject(DestroyRef).onDestroy(() => preview.set(null));
  }

  async ngOnInit(): Promise<void> {
    this.dialog().nativeElement.showModal();
    await this.theme.loadCatalog();
    // after the cards are drawn
    setTimeout(() => this.focusCurrent());
  }

  protected themeOf(id: string): Theme | undefined {
    return this.theme.find(id);
  }

  protected optionId(id: string): string {
    return `theme-option-${id}`;
  }

  protected onFilter(value: string): void {
    this.filter.set(value);
    const cards = this.visible();
    if (cards.length > 0 && !cards.some((c) => c.id === this.current())) this.try(cards[0].id);
  }

  protected onFilterKey(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' && this.visible().length > 0) {
      event.preventDefault();
      this.focusCurrent();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      this.ok();
    }
  }

  protected onGridKey(event: KeyboardEvent): void {
    const cards = this.visible();
    const index = cards.findIndex((c) => c.id === this.current());
    const next = moveInGrid(index, event.key, this.boxes(cards), FALLBACK_COLUMNS);
    if (next !== null) {
      event.preventDefault();
      if (next < 0) {
        this.filterInput().nativeElement.focus();
        return;
      }
      this.try(cards[next].id);
      this.focusCurrent();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (event.key === 'Enter' && !event.repeat) this.ok();
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // typing in the grid goes on in the filter
      event.preventDefault();
      this.onFilter(this.filter() + event.key);
      this.filterInput().nativeElement.focus();
    }
  }

  protected choose(id: string): void {
    this.try(id);
    this.focusCurrent();
  }

  /** The pointer shows a scheme while it is over its card; leaving shows the chosen one again. */
  protected hover(id: string | null): void {
    this.hovered.set(id);
    this.theme.preview.set(this.draftOf(id ?? this.current()));
  }

  protected setPair(kind: 'light' | 'dark', event: Event): void {
    const id = (event.target as HTMLSelectElement).value;
    this.pair.update((p) => ({ ...p, [kind]: id }));
    this.theme.preview.set(this.draftOf('system'));
  }

  /** Enter / OK: keeps the chosen scheme. */
  protected ok(): void {
    const id = this.current();
    if (id === null) return;
    this.done = true;
    this.theme.preview.set(null);
    if (id === 'system') this.theme.followSystem(this.pair());
    else this.theme.select(id);
    this.dialog().nativeElement.close();
  }

  /** Esc / Abbrechen / ×: the scheme from before stays. */
  protected cancel(): void {
    if (!this.done) this.theme.preview.set(null);
    this.dialog().nativeElement.close();
  }

  private try(id: string): void {
    this.current.set(id);
    this.theme.preview.set(this.draftOf(id));
  }

  private draftOf(id: string | null): Theme | null {
    if (id === null) return null;
    if (id !== 'system') return this.theme.find(id) ?? null;
    const pair = this.pairThemes();
    return pair ? (this.theme.systemDark() ? pair.dark : pair.light) : null;
  }

  /** Where each visible card is drawn, in the order of `cards`. */
  private boxes(cards: readonly PickerCard[]): CardBox[] {
    const host = this.grid().nativeElement;
    return cards.map((c) => {
      const el = host.querySelector<HTMLElement>(`[data-id="${CSS.escape(c.id)}"]`);
      return { top: el?.offsetTop ?? 0, left: el?.offsetLeft ?? 0 };
    });
  }

  private focusCurrent(): void {
    const id = this.current();
    const el = id
      ? this.grid().nativeElement.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)
      : null;
    el?.focus();
    el?.scrollIntoView?.({ block: 'nearest' });
  }
}
