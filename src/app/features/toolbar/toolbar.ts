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

const SEARCH_DEBOUNCE_MS = 200;

@Component({
  selector: 'app-toolbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let s = session();
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
        title="Format-Profil"
        [disabled]="!s"
        (change)="onProfile($event)"
      >
        @for (profile of sessions.profiles(); track profile.id) {
          <option [value]="profile.id" [selected]="s?.update()?.profileId === profile.id">
            {{ profile.name }}
          </option>
        }
      </select>
      <button
        type="button"
        title="Zeilen umbrechen"
        [attr.aria-pressed]="settings().wrapLines"
        (click)="toggleWrap()"
      >
        ⏎
      </button>
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

  readonly openSettings = output<void>();

  private readonly searchInput = viewChild.required<ElementRef<HTMLInputElement>>('search');
  protected readonly session = this.sessions.active;
  private debounce: ReturnType<typeof setTimeout> | null = null;

  /** UNKNOWN only takes up room where it occurs. */
  protected readonly visibleLevels = computed<Level[]>(() => {
    const update = this.session()?.update();
    return LEVELS.filter((l) => l !== 'UNKNOWN' || (update?.counts.UNKNOWN ?? 0) > 0);
  });

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

  protected onSearchInput(text: string): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      const session = this.session();
      if (session) void this.sessions.setQuery(session, { ...session.query(), text });
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

  protected toggleWrap(): void {
    this.settingsService.update({ wrapLines: !this.settings().wrapLines });
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
