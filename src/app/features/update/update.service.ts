import { Injectable, inject, signal } from '@angular/core';
import { call } from '../../core/backend/call';
import { toAppError } from '../../core/errors/app-error';
import { SettingsService } from '../../core/settings/settings.service';
import { LogSessionService } from '../sessions/log-session.service';
import { UpdateInfo, dueAtStart, hintVersion, resultText } from './update-logic';

/**
 * Update check: asks GitHub (through the backend, `update.rs`) whether a newer release exists and points to it
 * in the status bar. Nothing is downloaded. Runs on the action `CHECK_UPDATE`, and at start only when the
 * setting is on (off by default), at most once a day.
 */
@Injectable({ providedIn: 'root' })
export class UpdateService {
  private readonly settings = inject(SettingsService);
  private readonly sessions = inject(LogSessionService);

  /** A newer version to point to in the status bar. */
  readonly available = signal<string | null>(null);
  readonly checking = signal(false);
  /** Outcome of the last check by hand, for the settings dialog (the status bar is behind it). */
  readonly result = signal<string | null>(null);

  /** At start, after the settings are loaded. */
  startCheck(): void {
    if (dueAtStart(this.settings.settings().update, Date.now())) void this.check(false);
  }

  /** `manual`: asked for by the user, so the outcome is always said; a check at start fails silently. */
  async check(manual: boolean): Promise<void> {
    if (this.checking()) return;
    this.checking.set(true);
    if (manual) this.result.set(null);
    try {
      const info = await call<UpdateInfo>('check_for_update');
      const update = this.settings.settings().update;
      this.settings.update({ update: { ...update, lastCheck: Date.now() } });
      this.available.set(hintVersion(info, update.dismissed, manual));
      if (manual) this.say(resultText(info));
    } catch (e) {
      const text = `Update-Prüfung fehlgeschlagen: ${toAppError(e).message}`;
      if (manual) {
        this.result.set(text);
        this.sessions.showError(text);
      } else {
        console.warn(text);
      }
    } finally {
      this.checking.set(false);
    }
  }

  /** The page of the release in the browser; the backend builds the address from the version. */
  async open(): Promise<void> {
    try {
      await call('open_release_page', { version: this.available() });
    } catch (e) {
      this.sessions.showError(toAppError(e));
    }
  }

  /** Hides the hint; the check at start stays quiet about this version from now on. */
  dismiss(): void {
    const version = this.available();
    if (!version) return;
    this.settings.update({ update: { ...this.settings.settings().update, dismissed: version } });
    this.available.set(null);
  }

  private say(text: string): void {
    this.result.set(text);
    this.sessions.showNotice(text);
  }
}
