import {
  Injectable,
  Injector,
  computed,
  effect,
  inject,
  runInInjectionContext,
  signal,
  untracked,
} from '@angular/core';
import { toAppError } from '../../core/errors/app-error';
import { McpApi } from '../../core/mcp/mcp-api';
import { McpEvent, McpInfo } from '../../core/mcp/mcp.models';
import { SettingsService } from '../../core/settings/settings.service';
import { LogSessionService } from '../sessions/log-session.service';
import { SessionState } from '../sessions/session-state';
import { HistoryEntry, pushHistory } from './mcp-history';
import type { McpTools } from './mcp-tools';

/** A proposal waiting for the user (design E6); the dialog shows it, `answer` closes it. */
export interface McpProposal {
  kind: 'open' | 'export' | 'field_rule';
  title: string;
  /** What will happen, line by line (paths, format, rule); shown as plain text. */
  details: string[];
  /** Notice under the details, e.g. a preview of the rule. */
  note: string | null;
  answer: (yes: boolean) => void;
}

/**
 * AI control (prompt 022): listens to the MCP bridge, follows the setting, keeps the history (in memory only,
 * never log text) and the proposal waiting for the user. The tools themselves (`mcp-tools.ts`) load with the first
 * call, so the start bundle stays under its budget.
 */
@Injectable({ providedIn: 'root' })
export class McpService {
  private readonly mcp = inject(McpApi);
  private readonly sessions = inject(LogSessionService);
  private readonly settings = inject(SettingsService);
  private readonly injector = inject(Injector);

  readonly info = signal<McpInfo | null>(null);
  readonly history = signal<readonly HistoryEntry[]>([]);
  readonly proposal = signal<McpProposal | null>(null);
  /** The panel of the badge in the status bar (action `MCP_SHOW_HISTORY`). */
  readonly panelOpen = signal(false);
  /** The badge in the status bar: on, or a history to look at. */
  readonly visible = computed(() => !!this.info()?.enabled || this.history().length > 0);
  readonly connected = computed(() => (this.info()?.connections ?? 0) > 0);

  private started = false;
  private tools: Promise<McpTools> | null = null;

  /** Subscribes once the settings are loaded and opens or closes the bridge with the setting. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.mcp
      .subscribe((e) => this.onEvent(e))
      .then((info) => this.info.set(info))
      .catch(() => undefined);
    // Only a change of the switch reaches the backend, not every other setting.
    const enabled = computed(() => this.settings.loaded() && this.settings.settings().mcp.enabled);
    runInInjectionContext(this.injector, () => {
      effect(() => {
        const on = enabled();
        untracked(() => void this.apply(on));
      });
      // A filter tab opened below a hidden tab is hidden itself, so it stays hidden when its parents close.
      effect(() => {
        for (const tab of this.sessions.sessions()) {
          if (!tab.aiHidden() && this.isHidden(tab)) untracked(() => tab.aiHidden.set(true));
        }
      });
    });
  }

  private async apply(enabled: boolean): Promise<void> {
    try {
      this.info.set(await this.mcp.setEnabled(enabled));
    } catch (e) {
      this.sessions.showError(toAppError(e));
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.mcp.disconnect();
    } catch (e) {
      this.sessions.showError(toAppError(e));
    }
  }

  clearHistory(): void {
    this.history.set([]);
  }

  /** „Vor der KI verbergen“ for the tab in front (design E1). */
  toggleHidden(session: SessionState | null = this.sessions.active()): void {
    if (!session) return;
    const hide = !session.aiHidden();
    // The tabs below follow, and keep it when this one closes (review 022 #2).
    for (const tab of this.sessions.sessions()) {
      if (tab === session || this.below(tab, session)) tab.aiHidden.set(hide);
    }
    this.sessions.showNotice(
      session.aiHidden()
        ? `„${session.tabLabel()}“ ist vor der KI verborgen`
        : `„${session.tabLabel()}“ ist für die KI wieder sichtbar`,
    );
  }

  private below(tab: SessionState, ancestor: SessionState): boolean {
    for (let s = tab.parent(); s; s = s.parent()) if (s === ancestor) return true;
    return false;
  }

  /** A tab is hidden when it or its file's tab or a parent is (design E1). */
  isHidden(session: SessionState): boolean {
    for (let s: SessionState | null = session; s; s = s.parent()) if (s.aiHidden()) return true;
    return this.sessions
      .sessions()
      .some((t) => t.sessionId === session.sessionId && t.viewId === 0 && t.aiHidden());
  }

  private loadTools(): Promise<McpTools> {
    this.tools ??= import('./mcp-tools').then(({ McpTools }) =>
      runInInjectionContext(this.injector, () => new McpTools(this)),
    );
    return this.tools;
  }

  private onEvent(e: McpEvent): void {
    if (e.kind === 'status') {
      this.info.set(e.info);
      return;
    }
    void this.run(e.callId, e.tool, e.args);
  }

  /** Runs a call and answers the bridge; every call lands in the history. */
  async run(callId: number, tool: string, args: unknown): Promise<void> {
    const started = Date.now();
    // Turned off meanwhile: whatever still arrives is refused here too (review 022 #3).
    const off = !this.settings.settings().mcp.enabled;
    const out = off
      ? {
          result: null,
          error: { code: 'not_running', message: 'AI control is off in Log Commander' },
          tab: null,
        }
      : await this.loadTools()
          .then((tools) => tools.run(tool, args))
          .catch((e) => ({ result: null, error: toAppError(e), tab: null }));
    const error = out.error ? { code: out.error.code, message: out.error.message } : null;
    const outcome = (out.result as { outcome?: string } | null)?.outcome;
    this.history.update((all) =>
      pushHistory(all, {
        at: started,
        tool,
        tab: out.tab?.tabLabel() ?? null,
        result: error ? error.code : (outcome ?? 'ok'),
        ms: Date.now() - started,
      }),
    );
    try {
      await this.mcp.reply(callId, out.result, error);
    } catch {
      // The bridge timed the call out or went away: nothing to answer.
    }
  }
}
