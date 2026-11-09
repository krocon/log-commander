import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { describeError, toAppError } from '../../core/errors/app-error';
import { McpApi } from '../../core/mcp/mcp-api';
import { McpSettings } from '../../core/settings/settings.models';
import { SettingsService } from '../../core/settings/settings.service';
import { McpService } from './mcp.service';
import { claudeCodeLine, desktopConfig, probeText } from './mcp-texts';

/**
 * Section „KI-Steuerung (MCP)“ of the settings (prompt 022): on/off, masking, asking, how to connect Claude Code,
 * Claude Desktop or Cursor, and a connection test that starts the sidecar like a client does.
 */
@Component({
  selector: 'app-mcp-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section>
      <h3>KI-Steuerung (MCP)</h3>
      <label class="check">
        <input type="checkbox" [checked]="mcp().enabled" (change)="set('enabled', $event)" />
        Eine KI (Claude Code, Claude Desktop, Cursor …) darf Log Commander lesen und steuern
      </label>
      <p class="hint">
        Die KI sieht die offenen Tabs und ihren Text; was sie liest, geht an den Anbieter der KI.
        Tabs lassen sich über „KI“ in der Statusleiste verbergen. Dateien öffnen und exportieren
        fragt hier im Fenster.
      </p>
      <label class="check">
        <input
          type="checkbox"
          [checked]="mcp().maskSecrets"
          (change)="set('maskSecrets', $event)"
        />
        Bekannte Geheimnisse maskieren (Bearer, JWT, password=, api_key= …)
      </label>
      <label class="check">
        <input
          type="checkbox"
          [checked]="mcp().skipConfirm"
          (change)="set('skipConfirm', $event)"
        />
        Exporte der KI ohne Rückfrage ausführen (Öffnen fragt immer)
      </label>
      @if (mcp().enabled) {
        <p class="state" role="status">{{ state() }}</p>
        @if (sidecar(); as path) {
          <label>
            Claude Code (Terminal)
            <span class="copy">
              <input
                type="text"
                readonly
                [value]="codeLine()"
                (focus)="$any($event.target).select()"
              />
              <button type="button" (click)="copy(codeLine())">Kopieren</button>
            </span>
          </label>
          <label>
            <span>Claude Desktop / Cursor (<code>mcpServers</code> in der Konfiguration)</span>
            <span class="copy">
              <textarea
                readonly
                rows="5"
                [value]="desktop()"
                (focus)="$any($event.target).select()"
              ></textarea>
              <button type="button" (click)="copy(desktop())">Kopieren</button>
            </span>
          </label>
          <p class="test">
            <button type="button" [disabled]="testing()" (click)="test()">Verbindung testen</button>
            @if (testResult(); as r) {
              <span role="status" [class.bad]="!r.ok">{{ r.text }}</span>
            }
          </p>
        } @else {
          <p class="bad" role="status">
            Das Hilfsprogramm <code>log-commander-mcp</code> fehlt neben der App.
            @if (mcpService.info()?.debug) {
              Im Entwicklungsstand: <code>cargo build -p lc-mcp</code> im Ordner
              <code>src-tauri</code>.
            }
          </p>
        }
      }
    </section>
  `,
  styles: `
    section {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    h3 {
      margin: 0;
      font-size: 13px;
    }
    label {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    label.check {
      flex-direction: row;
      align-items: center;
      gap: 6px;
    }
    .hint,
    .state {
      margin: 0;
      color: var(--text-dim);
      font-size: 12px;
    }
    .copy {
      display: flex;
      gap: 6px;
      align-items: flex-start;
    }
    .copy input,
    .copy textarea {
      flex: 1;
      min-width: 0;
      font-family: var(--font-mono, monospace);
      font-size: 11.5px;
      resize: none;
    }
    .test {
      display: flex;
      gap: 8px;
      align-items: center;
      margin: 0;
    }
    .bad {
      color: var(--danger);
    }
  `,
})
export class McpSettingsComponent {
  private readonly settings = inject(SettingsService);
  private readonly api = inject(McpApi);
  protected readonly mcpService = inject(McpService);
  protected readonly mcp = computed(() => this.settings.settings().mcp);
  protected readonly sidecar = computed(() => this.mcpService.info()?.sidecar ?? null);
  private readonly windows = /Win/i.test(globalThis.navigator?.userAgent ?? '');
  protected readonly codeLine = computed(() => claudeCodeLine(this.sidecar() ?? '', this.windows));
  protected readonly desktop = computed(() => desktopConfig(this.sidecar() ?? ''));
  protected readonly state = computed(() => {
    const n = this.mcpService.info()?.connections ?? 0;
    return n === 0
      ? 'An – noch keine KI verbunden.'
      : n === 1
        ? 'Eine KI ist verbunden.'
        : `${n} KIs sind verbunden.`;
  });
  protected readonly testing = signal(false);
  protected readonly testResult = signal<{ ok: boolean; text: string } | null>(null);

  protected set(key: keyof McpSettings, event: Event): void {
    const value = (event.target as HTMLInputElement).checked;
    this.settings.update({ mcp: { ...this.mcp(), [key]: value } });
  }

  protected async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.testResult.set({ ok: true, text: 'In die Zwischenablage kopiert.' });
    } catch {
      this.testResult.set({
        ok: false,
        text: 'Kopieren ging nicht – Text markieren und selbst kopieren.',
      });
    }
  }

  protected async test(): Promise<void> {
    this.testing.set(true);
    this.testResult.set(null);
    try {
      const p = await this.api.probe();
      this.testResult.set({ ok: p.ok, text: probeText(p) });
    } catch (e) {
      this.testResult.set({ ok: false, text: describeError(toAppError(e)) });
    } finally {
      this.testing.set(false);
    }
  }
}
