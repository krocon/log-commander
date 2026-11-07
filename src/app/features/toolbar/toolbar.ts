import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  output,
  untracked,
  viewChild,
} from '@angular/core';
import { LEVELS, Level, SearchMode } from '../../core/log/log.models';
import { MAX_FONT_SIZE, MIN_FONT_SIZE } from '../../core/settings/settings.models';
import { SettingsService } from '../../core/settings/settings.service';
import { formatCount } from '../../shared/format';
import {
  ALL_LEVELS,
  levelAndSevere,
  onlyLevel,
  sameLevels,
  toggleLevel,
} from '../sessions/filter-logic';
import { LogSessionService } from '../sessions/log-session.service';
import { formatSummary } from '../sessions/format-logic';
import { columnsActive, columnsAvailable } from '../log-table/columns-logic';
import { SidebarState } from '../sidebar/sidebar-state';
import { isVisible, onlySource, sourceColor, toggleSource } from '../merge/merge-logic';

const SEARCH_DEBOUNCE_MS = 200;

@Component({
  selector: 'app-toolbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let s = session();
    <div class="group" [hidden]="!s">
      <button
        type="button"
        class="sidebar-toggle"
        aria-controls="sidebar"
        [attr.aria-pressed]="sidebar.shown()"
        [title]="
          sidebar.shown()
            ? 'Seitenleiste ausblenden (⌘/Strg+B)'
            : 'Seitenleiste: Dateien, Filter, Statistik (⌘/Strg+B)'
        "
        (click)="sidebar.toggle()"
      >
        ◧ Leiste
      </button>
      <button
        type="button"
        class="freeze"
        [disabled]="!s?.canFreeze()"
        [attr.aria-pressed]="s?.frozen() ?? false"
        [title]="
          s?.frozen()
            ? 'Fortsetzen und Verpasstes nachlesen (P)'
            : 'Aufnahme neuer Zeilen anhalten, zum Lesen in Ruhe (P)'
        "
        (click)="toggleFreeze()"
      >
        {{ s?.frozen() ? '▶ Fortsetzen' : '⏸ Freeze' }}
      </button>
      <button
        type="button"
        class="columns"
        [disabled]="!columnsAvailable()"
        [attr.aria-pressed]="columnsOn()"
        [title]="
          !columnsAvailable()
            ? 'Spaltenansicht: Format nicht in Spalten erkannt'
            : columnsOn()
              ? 'Rohansicht: ganze Zeilen ohne Spalten (T)'
              : 'Spaltenansicht mit Kopfzeile (T)'
        "
        (click)="toggleColumns()"
      >
        ▦ Spalten
      </button>
      <button
        type="button"
        class="fields-button"
        aria-haspopup="dialog"
        [disabled]="!s"
        title="Felder: Messwerte aus der Nachricht als eigene Spalten"
        (click)="openFields()"
      >
        ƒ Felder
      </button>
      <button
        type="button"
        class="detail-toggle"
        aria-controls="detail-panel"
        [attr.aria-pressed]="settings().detailVisible"
        [title]="
          settings().detailVisible
            ? 'Detail-Panel ausblenden (D)'
            : 'Detail-Panel: ganzer Eintrag der gewählten Zeile (D, Doppelklick auf eine Zeile)'
        "
        (click)="toggleDetail()"
      >
        ▤ Detail
      </button>
    </div>
    <div class="group chips" role="group" [hidden]="!s" aria-label="Log-Level">
      @for (level of visibleLevels(); track level) {
        <button
          type="button"
          class="chip"
          [class]="'chip chip-' + level"
          [attr.aria-pressed]="s ? s.levels().has(level) : true"
          [disabled]="!s"
          [title]="
            level + ': Klick an/aus · Alt-Klick nur dieses · Doppelklick dieses und schwerer'
          "
          (click)="onChip($event, level)"
          (dblclick)="onChipDouble(level)"
        >
          {{ level }} <span class="count">{{ count(level) }}</span>
        </button>
      }
    </div>
    @if (s?.isMerge) {
      <div class="group chips sources" role="group" aria-label="Quellen">
        @for (source of s!.sources; track source.index) {
          <button
            type="button"
            [class]="'chip src src-' + color(source.index)"
            [attr.aria-pressed]="sourceVisible(source.index)"
            [title]="source.path + ': Klick an/aus · Alt-Klick nur diese Datei'"
            (click)="onSource($event, source.index)"
          >
            <span class="swatch" aria-hidden="true"></span>{{ s!.sourceLabels[source.index] }}
          </button>
        }
      </div>
    }
    <div class="group" role="group" aria-label="Presets" [hidden]="!s">
      <button type="button" [disabled]="!s" [attr.aria-pressed]="isAll()" (click)="preset(null)">
        Alle
      </button>
      <button
        type="button"
        [disabled]="!s"
        [attr.aria-pressed]="isPreset('WARN')"
        (click)="preset('WARN')"
      >
        WARN+
      </button>
      <button
        type="button"
        [disabled]="!s"
        [attr.aria-pressed]="isPreset('ERROR')"
        (click)="preset('ERROR')"
      >
        ERROR+
      </button>
    </div>
    @if (s?.keptFilter()) {
      <div class="group">
        <button
          type="button"
          class="full-log"
          title="Zurück zum gemerkten Filter, die gewählte Zeile bleibt (G)"
          (click)="toggleFullLog()"
        >
          ↩ Zurück zum Filter
        </button>
      </div>
    } @else if (s?.filterActive() && s?.selection()) {
      <div class="group">
        <button
          type="button"
          class="full-log"
          title="Gewählte Zeile im ungefilterten Log zeigen, der Filter wird gemerkt (G)"
          (click)="toggleFullLog()"
        >
          ⇱ Im Gesamtlog
        </button>
      </div>
    }
    <div class="group search" role="search" [hidden]="!s">
      <input
        #search
        type="search"
        placeholder="Suchen … (⌘/Strg+F)"
        aria-label="Suchtext"
        [disabled]="!s"
        [class.invalid]="s?.searchError()"
        [title]="s?.searchError() ?? ''"
        [value]="s?.query()?.text ?? ''"
        (input)="onSearchInput(search.value)"
        (keydown)="onSearchKey($event)"
      />
      <button
        type="button"
        title="Regulärer Ausdruck"
        [disabled]="!s"
        [attr.aria-pressed]="s?.query()?.isRegex ?? false"
        (click)="toggleRegex()"
      >
        .*
      </button>
      <button
        type="button"
        title="Groß-/Kleinschreibung beachten"
        [disabled]="!s"
        [attr.aria-pressed]="s?.query()?.caseSensitive ?? false"
        (click)="toggleCase()"
      >
        Aa
      </button>
      <select
        aria-label="Suchmodus"
        [disabled]="!s"
        [value]="s?.searchMode() ?? 'filter'"
        (change)="onMode($event)"
      >
        <option value="filter" [selected]="s?.searchMode() === 'filter'">Filtern</option>
        <option value="highlight" [selected]="s?.searchMode() === 'highlight'">Hervorheben</option>
      </select>
      <button
        type="button"
        title="Vorheriger Treffer (Shift+Enter)"
        [disabled]="!s"
        (click)="find(false)"
      >
        ▲
      </button>
      <button type="button" title="Nächster Treffer (Enter)" [disabled]="!s" (click)="find(true)">
        ▼
      </button>
      @if (s?.findMessage(); as message) {
        <span class="find-message" role="status">{{ message }}</span>
      }
    </div>
    <div class="group end">
      <select
        aria-label="Profil"
        [hidden]="!s"
        [title]="
          s?.isMerge
            ? 'Ein Merge hat ein Profil je Datei, gewählt beim Zusammenführen'
            : profileTitle()
        "
        [disabled]="!s || s.isMerge"
        (change)="onProfile($event)"
      >
        @for (profile of sessions.profiles(); track profile.id) {
          <option [value]="profile.id" [selected]="s?.update()?.profileId === profile.id">
            {{ profile.name }}
          </option>
        }
      </select>
      <button type="button" title="Schrift kleiner" (click)="changeFont(-1)">A−</button>
      <button type="button" title="Schrift größer" (click)="changeFont(1)">A+</button>
      <button type="button" [title]="'Theme: ' + themeLabel()" (click)="cycleTheme()">◐</button>
      <button type="button" title="Einstellungen" (click)="openSettings.emit()">⚙</button>
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 5px 14px;
      padding: 6px 10px;
      background: var(--bg-panel);
      border-bottom: 1px solid var(--border);
      font-size: 12px;
    }
    .group {
      display: flex;
      align-items: center;
      gap: 3px;
    }
    .group[hidden],
    select[hidden] {
      display: none;
    }
    .search {
      flex: 1 1 430px;
      min-width: 0;
    }
    .search input {
      flex: 1;
      min-width: 110px;
    }
    .end {
      margin-left: auto;
    }
    .end select {
      max-width: 150px;
    }
    .chip {
      border: 1px solid var(--border);
      font-family: var(--font-mono);
      font-size: 11px;
      opacity: 0.55;
      background: transparent;
      color: var(--text-dim);
    }
    .chip[aria-pressed='true'] {
      opacity: 1;
      background: var(--bg-raised);
      color: var(--chip);
      border-color: var(--chip);
    }
    .chip:hover {
      background: var(--bg-hover);
    }
    .count {
      font-variant-numeric: tabular-nums;
      opacity: 0.85;
    }
    .chip.src {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      --chip: var(--text);
    }
    .chip.src[aria-pressed='true'] {
      border-color: var(--src);
    }
    .swatch {
      width: 8px;
      height: 8px;
      border-radius: 2px;
      background: var(--src);
    }
    .chip-UNKNOWN {
      --chip: var(--text-dim);
    }
    .chip-TRACE {
      --chip: var(--lv-trace-fg);
    }
    .chip-DEBUG {
      --chip: var(--lv-debug-fg);
    }
    .chip-INFO {
      --chip: var(--lv-info-badge);
    }
    .chip-WARN {
      --chip: var(--lv-warn-fg);
    }
    .chip-ERROR {
      --chip: var(--lv-error-fg);
    }
    .chip-FATAL {
      --chip: var(--lv-error-edge);
    }
    .sidebar-toggle,
    .full-log,
    .freeze,
    .columns,
    .fields-button,
    .detail-toggle {
      white-space: nowrap;
    }
    .find-message {
      color: var(--text-dim);
      white-space: nowrap;
    }
  `,
})
export class ToolbarComponent implements OnInit, OnDestroy {
  protected readonly sessions = inject(LogSessionService);
  private readonly settingsService = inject(SettingsService);
  protected readonly settings = this.settingsService.settings;
  protected readonly sidebar = inject(SidebarState);

  readonly openSettings = output<void>();

  private readonly searchInput = viewChild.required<ElementRef<HTMLInputElement>>('search');
  protected readonly session = this.sessions.active;
  private debounce: ReturnType<typeof setTimeout> | null = null;

  /** Prompt 011: rules that take fields out of the message. */
  protected openFields(): void {
    const session = this.session();
    if (session) this.sessions.openFields(session);
  }

  /** UNKNOWN only takes up room where it occurs. */
  protected readonly visibleLevels = computed<Level[]>(() => {
    const update = this.session()?.update();
    return LEVELS.filter((l) => l !== 'UNKNOWN' || (update?.counts.UNKNOWN ?? 0) > 0);
  });

  /** The profile plus how well the detected format fits, e.g. „Log4j · 97 %“. */
  protected readonly profileTitle = computed(() => {
    const summary = formatSummary(this.session()?.columns() ?? null, this.sessions.profiles());
    return summary ? `Format-Profil: ${summary}` : 'Format-Profil';
  });

  protected readonly columnsAvailable = computed(() =>
    columnsAvailable(this.session()?.columns() ?? null),
  );
  /** Column view or raw view (prompt 009); a format without columns is always raw. */
  protected readonly columnsOn = computed(() =>
    columnsActive(this.settings().columnMode, this.session()?.columns() ?? null),
  );

  protected readonly themeLabel = computed(() => {
    const theme = this.settings().theme;
    return theme === 'system' ? 'System' : theme === 'dark' ? 'Dunkel' : 'Hell';
  });

  protected readonly isAll = computed(() => {
    const levels = this.session()?.levels();
    return !!levels && sameLevels(levels, ALL_LEVELS);
  });

  constructor() {
    // The input shows the text of the tab that came to the front.
    effect(() => {
      const text = this.session()?.query().text ?? '';
      const input = this.searchInput().nativeElement;
      if (input.value !== text && !this.debounce) input.value = text;
    });
    // A filter from the sidebar wins over a search still being typed (prompt 005).
    effect(() => {
      const session = this.session();
      if (!session || session.presetRevision() === 0) return;
      untracked(() => {
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = null;
        this.searchInput().nativeElement.value = session.query().text;
      });
    });
  }

  ngOnInit(): void {
    document.addEventListener('keydown', this.onGlobalKey);
  }

  ngOnDestroy(): void {
    document.removeEventListener('keydown', this.onGlobalKey);
  }

  private readonly onGlobalKey = (event: KeyboardEvent): void => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      this.searchInput().nativeElement.focus();
      this.searchInput().nativeElement.select();
    }
  };

  protected count(level: Level): string {
    return formatCount(this.session()?.update().counts[level] ?? 0);
  }

  protected isPreset(level: Level): boolean {
    const levels = this.session()?.levels();
    return !!levels && sameLevels(levels, levelAndSevere(level));
  }

  /** A double click also fires two clicks; it sets an absolute state afterwards, which wins. */
  protected onChip(event: MouseEvent, level: Level): void {
    const session = this.session();
    if (!session) return;
    const next = event.altKey ? onlyLevel(level) : toggleLevel(session.levels(), level);
    void this.sessions.setLevels(session, next);
  }

  protected color(index: number): number {
    return sourceColor(index);
  }

  protected sourceVisible(index: number): boolean {
    const session = this.session();
    return !session || isVisible(session.sourceMask(), index);
  }

  /** Like the level chips: a click switches the file, Alt-click shows only it. */
  protected onSource(event: MouseEvent, index: number): void {
    const session = this.session();
    if (!session) return;
    const count = session.sources.length;
    const mask = session.sourceMask();
    const next = event.altKey ? onlySource(mask, index, count) : toggleSource(mask, index, count);
    void this.sessions.setSources(session, next);
  }

  protected onChipDouble(level: Level): void {
    const session = this.session();
    if (session) void this.sessions.setLevels(session, levelAndSevere(level));
  }

  protected preset(level: Level | null): void {
    const session = this.session();
    if (session) {
      void this.sessions.setLevels(session, level ? levelAndSevere(level) : ALL_LEVELS);
    }
  }

  protected toggleFullLog(): void {
    const session = this.session();
    if (session) void this.sessions.toggleFullLog(session);
  }

  protected toggleFreeze(): void {
    const session = this.session();
    if (session) void this.sessions.toggleFreeze(session);
  }

  protected toggleDetail(): void {
    this.settingsService.update({ detailVisible: !this.settings().detailVisible });
  }

  protected toggleColumns(): void {
    if (!this.columnsAvailable()) return;
    this.settingsService.update({
      columnMode: this.settings().columnMode === 'columns' ? 'raw' : 'columns',
    });
  }

  protected onSearchInput(text: string): void {
    if (this.debounce) clearTimeout(this.debounce);
    const typedIn = this.session();
    const revision = typedIn?.presetRevision();
    this.debounce = setTimeout(() => {
      this.debounce = null;
      const session = this.session();
      // Another tab or a filter from the sidebar in the meantime: the typing belonged to before.
      if (!session || session !== typedIn || session.presetRevision() !== revision) return;
      void this.sessions.setQuery(session, { ...session.query(), text });
    }, SEARCH_DEBOUNCE_MS);
  }

  protected onSearchKey(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void this.find(!event.shiftKey);
    } else if (event.key === 'Escape') {
      const input = this.searchInput().nativeElement;
      input.value = '';
      this.onSearchInput('');
      input.blur();
    }
  }

  protected toggleRegex(): void {
    const session = this.session();
    if (session) {
      const query = session.query();
      void this.sessions.setQuery(session, { ...query, isRegex: !query.isRegex });
    }
  }

  protected toggleCase(): void {
    const session = this.session();
    if (session) {
      const query = session.query();
      void this.sessions.setQuery(session, { ...query, caseSensitive: !query.caseSensitive });
    }
  }

  protected onMode(event: Event): void {
    const session = this.session();
    if (session) {
      const mode = (event.target as HTMLSelectElement).value as SearchMode;
      void this.sessions.setSearchMode(session, mode);
    }
  }

  protected async find(forward: boolean): Promise<void> {
    const session = this.session();
    if (!session) return;
    // Enter right after typing: the search must not wait for the debounce.
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = null;
      const text = this.searchInput().nativeElement.value;
      await this.sessions.setQuery(session, { ...session.query(), text });
    }
    await this.sessions.find(session, forward);
  }

  protected onProfile(event: Event): void {
    const session = this.session();
    if (session) void this.sessions.setProfile(session, (event.target as HTMLSelectElement).value);
  }

  protected changeFont(step: number): void {
    const fontSize = Math.min(
      MAX_FONT_SIZE,
      Math.max(MIN_FONT_SIZE, this.settings().fontSize + step),
    );
    this.settingsService.update({ fontSize });
  }

  protected cycleTheme(): void {
    const order = ['system', 'dark', 'light'] as const;
    const next = order[(order.indexOf(this.settings().theme) + 1) % order.length];
    this.settingsService.update({ theme: next });
  }
}
