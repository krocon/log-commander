import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  computed,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { LogApi } from '../../core/log/log-api';
import { Profile } from '../../core/log/log.models';
import { describeError, toAppError } from '../../core/errors/app-error';
import {
  COLOR_TOKENS,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  ThemeChoice,
} from '../../core/settings/settings.models';
import { SettingsService } from '../../core/settings/settings.service';
import { LogSessionService } from '../sessions/log-session.service';
import { formatMapping, newProfileId, parseMapping } from './profile-logic';
import { draftFromInference, parseLayouts } from '../sessions/format-logic';

@Component({
  selector: 'app-settings-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog (close)="closed.emit()" aria-label="Einstellungen">
      <header>
        <h2>Einstellungen</h2>
        <button type="button" aria-label="Schließen" (click)="dialog.close()">×</button>
      </header>
      <div class="body">
        <section>
          <h3>Darstellung</h3>
          <label>
            Theme
            <select (change)="setTheme($event)">
              <option value="system" [selected]="settings().theme === 'system'">
                System folgen
              </option>
              <option value="dark" [selected]="settings().theme === 'dark'">Dunkel</option>
              <option value="light" [selected]="settings().theme === 'light'">Hell</option>
            </select>
          </label>
          <label>
            Schriftgröße
            <input
              type="number"
              [min]="minFont"
              [max]="maxFont"
              [value]="settings().fontSize"
              (change)="setFont($event)"
            />
          </label>
          <label class="check">
            <input
              type="checkbox"
              [checked]="settings().showLineNumbers"
              (change)="setCheck('showLineNumbers', $event)"
            />
            Zeilennummern anzeigen
          </label>
        </section>

        <section>
          <h3>Verhalten</h3>
          <label class="check">
            <input type="checkbox" [checked]="settings().keepOnRotate" (change)="setKeep($event)" />
            Bei Rotation alte Zeilen behalten (sonst neu beginnen)
          </label>
        </section>

        <section>
          <h3>Farben</h3>
          <div class="colors">
            @for (item of colorTokens; track item.token) {
              <label>
                <input
                  type="color"
                  [value]="colorOf(item.token)"
                  (input)="setColor(item.token, $event)"
                />
                {{ item.label }}
              </label>
            }
          </div>
          <button type="button" (click)="resetColors()">Farben zurücksetzen</button>
        </section>

        <section>
          <h3>Eigene Profile</h3>
          @for (profile of settings().customProfiles; track profile.id) {
            <div class="profile-row">
              <span class="name">{{ profile.name }}</span>
              <code>{{ profile.patterns[0] ?? profile.layouts?.[0] }}</code>
              <button type="button" (click)="editProfile(profile)">Bearbeiten</button>
              <button type="button" (click)="deleteProfile(profile.id)">Löschen</button>
            </div>
          }
          <div class="profile-form">
            <label>
              Name
              <input #name type="text" [value]="draft().name" />
            </label>
            <label>
              Regex mit Gruppe (?P&lt;level&gt;…)
              <input
                #pattern
                type="text"
                spellcheck="false"
                [value]="draft().pattern"
                placeholder="^\\[(?P<level>\\w+)\\]"
              />
            </label>
            <label>
              Level-Zuordnung, je Zeile WORT=LEVEL (optional)
              <textarea #mapping rows="3" spellcheck="false" [value]="draft().mapping"></textarea>
            </label>
            <label>
              Layouts für Spalten, je Zeile eine Regex mit benannten Gruppen (optional)
              <textarea
                #layouts
                rows="3"
                spellcheck="false"
                [value]="draft().layouts"
                placeholder="^(?P<timestamp>S+ S+) (?P<level>w+) (?P<message>.*)$"
              ></textarea>
            </label>
            <div class="preview-input">
              <label>
                Beispielzeile
                <input #sampleLine type="text" spellcheck="false" />
              </label>
              <button
                type="button"
                (click)="
                  testLayout(
                    name.value,
                    pattern.value,
                    mapping.value,
                    layouts.value,
                    sampleLine.value
                  )
                "
              >
                Testen
              </button>
            </div>
            @if (preview(); as p) {
              <div class="preview" role="status" aria-label="Vorschau der Felder">
                @if (!p.matched) {
                  <p class="hint">Die Zeile passt zu keinem Layout, sie bleibt eine Nachricht.</p>
                }
                <dl>
                  @for (f of p.fields; track f.label) {
                    <dt>{{ f.label }}</dt>
                    <dd>{{ f.value }}</dd>
                  }
                </dl>
              </div>
            }
            @if (inferredLayout(); as layout) {
              <button type="button" (click)="adoptInference(layout)">
                Erkanntes Format als eigenes Profil übernehmen
              </button>
            }
            @if (profileError(); as error) {
              <p class="error" role="alert">{{ error }}</p>
            }
            <button
              type="button"
              (click)="saveProfile(name.value, pattern.value, mapping.value, layouts.value)"
            >
              {{ draft().id ? 'Profil speichern' : 'Profil hinzufügen' }}
            </button>
          </div>
        </section>
      </div>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(620px, calc(100vw - 32px));
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
      background: rgb(0 0 0 / 45%);
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
    }
    h2 {
      margin: 0;
      font-size: 14px;
    }
    h3 {
      margin: 0 0 8px;
      font-size: 12px;
      color: var(--text-dim);
    }
    .body {
      overflow: auto;
      padding: 14px;
      display: grid;
      gap: 18px;
    }
    label {
      display: flex;
      flex-direction: column;
      gap: 3px;
      margin-bottom: 8px;
      font-size: 12px;
    }
    label.check {
      flex-direction: row;
      align-items: center;
      gap: 6px;
    }
    .colors {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
      gap: 2px 10px;
    }
    .colors label {
      flex-direction: row;
      align-items: center;
      gap: 6px;
      margin-bottom: 4px;
    }
    input[type='color'] {
      width: 28px;
      height: 22px;
      padding: 0;
    }
    .profile-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }
    .profile-row code {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-dim);
    }
    .profile-form {
      margin-top: 8px;
      padding: 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    .profile-form input,
    .profile-form textarea {
      font-family: var(--font-mono);
    }
    .profile-form button {
      border-color: var(--border);
    }
    .preview-input {
      display: flex;
      align-items: flex-end;
      gap: 8px;
    }
    .preview-input label {
      flex: 1;
    }
    .preview-input button {
      margin-bottom: 8px;
    }
    .preview {
      margin: 0 0 8px;
      font-size: 12px;
    }
    .preview dl {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 2px 10px;
      margin: 0;
    }
    .preview dt {
      color: var(--text-dim);
    }
    .preview dd {
      margin: 0;
      font-family: var(--font-mono);
      white-space: pre;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .hint {
      margin: 0 0 4px;
      color: var(--text-dim);
    }
    .error {
      color: var(--danger);
      margin: 0 0 8px;
      font-size: 12px;
    }
  `,
})
export class SettingsDialogComponent implements OnInit {
  private readonly settingsService = inject(SettingsService);
  private readonly sessions = inject(LogSessionService);
  private readonly api = inject(LogApi);
  protected readonly settings = this.settingsService.settings;
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  readonly closed = output<void>();

  protected readonly colorTokens = COLOR_TOKENS;
  protected readonly minFont = MIN_FONT_SIZE;
  protected readonly maxFont = MAX_FONT_SIZE;
  protected readonly profileError = signal<string | null>(null);
  protected readonly draft = signal({ id: '', name: '', pattern: '', mapping: '', layouts: '' });
  protected readonly preview = signal<{
    matched: boolean;
    fields: { label: string; value: string }[];
  } | null>(null);
  /** The active tab's file fits no built-in format, but the inference found one. */
  protected readonly inferredLayout = computed(
    () => this.sessions.active()?.columns()?.inferredLayout ?? null,
  );

  private readonly computedColors = computed(() => {
    this.settings();
    return getComputedStyle(document.documentElement);
  });

  ngOnInit(): void {
    this.dialog().nativeElement.showModal();
  }

  protected setTheme(event: Event): void {
    this.settingsService.update({
      theme: (event.target as HTMLSelectElement).value as ThemeChoice,
    });
  }

  protected setFont(event: Event): void {
    this.settingsService.update({ fontSize: Number((event.target as HTMLInputElement).value) });
  }

  protected setCheck(key: 'showLineNumbers', event: Event): void {
    this.settingsService.update({ [key]: (event.target as HTMLInputElement).checked });
  }

  protected setKeep(event: Event): void {
    const keep = (event.target as HTMLInputElement).checked;
    this.settingsService.update({ keepOnRotate: keep });
    for (const session of this.sessions.sessions()) {
      void this.api.setKeepOnRotate(session.id, keep);
    }
  }

  protected colorOf(token: string): string {
    return this.computedColors().getPropertyValue(`--${token}`).trim() || '#000000';
  }

  protected setColor(token: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.settingsService.update({
      colorOverrides: { ...this.settings().colorOverrides, [token]: value },
    });
  }

  protected resetColors(): void {
    this.settingsService.update({ colorOverrides: {} });
  }

  protected editProfile(profile: Profile): void {
    this.profileError.set(null);
    this.draft.set({
      id: profile.id,
      name: profile.name,
      pattern: profile.patterns[0] ?? '',
      mapping: formatMapping(profile.mapping),
      layouts: (profile.layouts ?? []).join('\n'),
    });
    this.preview.set(null);
  }

  protected adoptInference(layout: string): void {
    const fileName = this.sessions.active()?.fileName ?? '';
    this.profileError.set(null);
    this.preview.set(null);
    this.draft.set({ id: '', mapping: '', ...draftFromInference(layout, fileName) });
  }

  /** Shows how the backend splits the sample line; its error message if the profile is broken. */
  protected async testLayout(
    name: string,
    pattern: string,
    mappingText: string,
    layoutsText: string,
    line: string,
  ): Promise<void> {
    const parsed = parseMapping(mappingText);
    if ('error' in parsed) {
      this.profileError.set(parsed.error);
      return;
    }
    const profile: Profile = {
      id: 'preview',
      name: name.trim() || 'Profil',
      patterns: pattern.trim() ? [pattern] : [],
      mapping: parsed.mapping,
      layouts: parseLayouts(layoutsText),
    };
    try {
      const result = await this.api.previewFields(profile, line);
      this.profileError.set(null);
      this.preview.set({
        matched: result.matched,
        fields: result.columns
          .map((column, i) => {
            const [start, end] = result.fields[i] ?? [0, 0];
            return { label: column.label, value: line.slice(start, end) };
          })
          .filter((f) => f.value.length > 0),
      });
    } catch (e) {
      this.preview.set(null);
      this.profileError.set(describeError(toAppError(e)));
    }
  }

  protected async deleteProfile(id: string): Promise<void> {
    await this.storeProfiles(this.settings().customProfiles.filter((p) => p.id !== id));
  }

  protected async saveProfile(
    name: string,
    pattern: string,
    mappingText: string,
    layoutsText: string,
  ): Promise<void> {
    const custom = this.settings().customProfiles;
    const layouts = parseLayouts(layoutsText);
    if (!name.trim() || (!pattern.trim() && layouts.length === 0)) {
      this.profileError.set('Name und eine Regex für Level oder Layout sind Pflicht.');
      return;
    }
    const parsed = parseMapping(mappingText);
    if ('error' in parsed) {
      this.profileError.set(parsed.error);
      return;
    }
    const id = this.draft().id || newProfileId(custom);
    const profile: Profile = {
      id,
      name: name.trim(),
      patterns: pattern.trim() ? [pattern] : [],
      mapping: parsed.mapping,
      layouts,
    };
    const next = this.draft().id
      ? custom.map((p) => (p.id === id ? profile : p))
      : [...custom, profile];
    if (await this.storeProfiles(next)) {
      this.draft.set({ id: '', name: '', pattern: '', mapping: '', layouts: '' });
      this.preview.set(null);
    }
  }

  /** The backend validates first; only what it accepts is kept. */
  private async storeProfiles(profiles: Profile[]): Promise<boolean> {
    try {
      await this.api.setCustomProfiles(profiles);
      this.settingsService.update({ customProfiles: profiles });
      this.sessions.profiles.set(await this.api.listProfiles());
      this.profileError.set(null);
      return true;
    } catch (e) {
      this.profileError.set(describeError(toAppError(e)));
      return false;
    }
  }
}
