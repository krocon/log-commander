import { Injectable, inject, signal } from '@angular/core';
import { describeError, toAppError } from '../../core/errors/app-error';
import { LogApi } from '../../core/log/log-api';
import { ExportFormat, ExportProgress, ExportRange } from '../../core/log/log.models';
import { baseName, formatCount } from '../../shared/format';
import { SessionState } from '../sessions/session-state';
import { LogSessionService } from '../sessions/log-session.service';

/** A running export as the status bar shows it. */
export interface ExportJob {
  jobId: number;
  fileName: string;
  progress: ExportProgress;
}

/**
 * Exports (prompt 015): the backend writes the file as a job; progress comes through a channel. The status bar
 * shows running jobs with „Abbrechen“ and a message at the end.
 */
@Injectable({ providedIn: 'root' })
export class ExportService {
  private readonly api = inject(LogApi);
  private readonly sessions = inject(LogSessionService);

  readonly jobs = signal<readonly ExportJob[]>([]);

  /** Starts an export; a refused target (or the open log itself) comes back as text. */
  async start(
    session: SessionState,
    range: ExportRange,
    format: ExportFormat,
    columns: readonly string[] | null,
    target: string,
  ): Promise<string | null> {
    const early: ExportProgress[] = [];
    let jobId: number | null = null;
    try {
      jobId = await this.api.exportView(
        session.sessionId,
        session.viewId,
        range,
        format,
        columns,
        target,
        (p) => {
          if (jobId === null) early.push(p);
          else this.onProgress(p);
        },
      );
    } catch (e) {
      return describeError(toAppError(e));
    }
    this.jobs.update((all) => [
      ...all,
      {
        jobId: jobId as number,
        fileName: baseName(target),
        progress: {
          jobId: jobId as number,
          state: 'running',
          lines: 0,
          total: 0,
          bytes: 0,
          path: target,
          error: null,
        },
      },
    ]);
    for (const p of early) this.onProgress(p);
    return null;
  }

  async cancel(jobId: number): Promise<void> {
    try {
      await this.api.cancelExport(jobId);
    } catch (e) {
      this.sessions.showError(toAppError(e));
    }
  }

  private onProgress(p: ExportProgress): void {
    const job = this.jobs().find((j) => j.jobId === p.jobId);
    if (!job) return;
    if (p.state === 'running') {
      this.jobs.update((all) => all.map((j) => (j.jobId === p.jobId ? { ...j, progress: p } : j)));
      return;
    }
    this.jobs.update((all) => all.filter((j) => j.jobId !== p.jobId));
    if (p.state === 'done') {
      this.sessions.showNotice(`Exportiert: ${job.fileName} (${formatCount(p.lines)} Zeilen)`);
    } else if (p.state === 'cancelled') {
      this.sessions.showNotice(`Export abgebrochen: ${job.fileName}`);
    } else {
      this.sessions.showError(
        p.error ? describeError(toAppError(p.error)) : `Export fehlgeschlagen: ${job.fileName}`,
      );
    }
  }
}
