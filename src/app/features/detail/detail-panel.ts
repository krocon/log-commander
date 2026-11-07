import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { describeError, toAppError } from '../../core/errors/app-error';
import { LogApi } from '../../core/log/log-api';
import { EntryDetail } from '../../core/log/log.models';
import { SettingsService } from '../../core/settings/settings.service';
import { formatBytes, formatCount } from '../../shared/format';
import { sourceColor } from '../merge/merge-logic';
import { TextSegment } from '../log-table/highlight';
import { LogSessionService } from '../sessions/log-session.service';
import { SessionState } from '../sessions/session-state';
import { formatDetail, rawSegments } from './detail-format';
import { EntryKey, lineRangeLabel, needsReload } from './detail-logic';

/**
 * The whole entry of the selected line below the log (prompt 004): head and continuations from the index,
 * without filter and without the 128 KB cut of the view, raw or with JSON/XML formatted. What it shows is
 * `selection().anchor`, so click, Shift-click, search and Escape need no code of their own.
 */
@Component({
  selector: 'app-detail-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'detail',
    role: 'region',
    'aria-label': 'Detail des Eintrags',
    '[style.--detail-font-size.px]': 'fontSize()',
  },
  template: `
    <div class="head">
      @if (entry(); as e) {
        <span class="badge" [attr.data-level]="e.level">{{ e.level }}</span>
        <span class="range">{{ rangeLabel() }}</span>
        <span class="size">{{ sizeLabel() }}</span>
        @if (sourceLabel(); as source) {
          <span
            class="source"
            [class]="'source src-' + sourceColorOf(e.source)"
            [title]="sourcePath()"
            >{{ source }}</span
          >
        }
      } @else {
        <span class="title">Detail</span>
      }
      @if (loading()) {
        <span class="loading" aria-hidden="true">…</span>
      }
      <span class="spacer"></span>
      <div class="group" role="group" aria-label="Darstellung">
        <button type="button" [attr.aria-pressed]="!showFormatted()" (click)="formatted.set(false)">
          Roh
        </button>
        <button
          type="button"
          [attr.aria-pressed]="showFormatted()"
          [disabled]="!formattedView()"
          [title]="
            formattedView()
              ? formattedView()!.kind.toUpperCase() + ' eingerückt'
              : 'Kein JSON oder XML erkannt'
          "
          (click)="formatted.set(true)"
        >
          Formatiert
        </button>
      </div>
      <button
        type="button"
        title="Lange Zeilen umbrechen"
        [attr.aria-pressed]="wrap()"
        (click)="toggleWrap()"
      >
        ↵ Umbruch
      </button>
      @if (session().keptFilter()) {
        <button
          type="button"
          class="full-log"
          title="Zurück zum gemerkten Filter (G)"
          (click)="toggleFullLog()"
        >
          ↩ Zurück zum Filter
        </button>
      } @else if (session().filterActive() && session().selection()) {
        <button
          type="button"
          class="full-log"
          title="Diese Zeile im ungefilterten Log zeigen, der Filter wird gemerkt (G)"
          (click)="toggleFullLog()"
        >
          ⇱ Im Gesamtlog
        </button>
      }
      <button type="button" title="Ganzen Eintrag kopieren" [disabled]="!entry()" (click)="copy()">
        Kopieren
      </button>
      <button
        type="button"
        class="close"
        aria-label="Detail schließen (D)"
        title="Schließen (D)"
        (click)="close()"
      >
        ×
      </button>
    </div>
    @if (notice(); as text) {
      <div class="notice" role="status">{{ text }}</div>
    }
    @if (!entry()) {
      <div class="empty">{{ emptyText() }}</div>
    }
    <pre
      #body
      class="body"
      tabindex="0"
      aria-label="Text des Eintrags"
      [class.wrap]="wrap()"
      [hidden]="!entry()"
    ></pre>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow: hidden;
      background: var(--bg-app);
    }
    .head {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: none;
      padding: 3px 8px;
      background: var(--bg-panel);
      border-bottom: 1px solid var(--border);
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
    }
    .title,
    .size {
      color: var(--text-dim);
    }
    .source {
      padding-left: 6px;
      border-left: 3px solid var(--src);
      color: var(--text-dim);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .range {
      font-variant-numeric: tabular-nums;
    }
    .spacer {
      flex: 1;
    }
    .group {
      display: flex;
      gap: 2px;
    }
    .badge {
      padding: 0 6px;
      border-radius: var(--radius);
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--lv-unknown-fg);
      background: var(--lv-unknown-bg);
      border: 1px solid var(--border);
    }
    .badge[data-level='TRACE'] {
      color: var(--lv-trace-fg);
      background: var(--lv-trace-bg);
    }
    .badge[data-level='DEBUG'] {
      color: var(--lv-debug-fg);
      background: var(--lv-debug-bg);
    }
    .badge[data-level='INFO'] {
      color: var(--lv-info-fg);
      background: var(--lv-info-bg);
    }
    .badge[data-level='WARN'] {
      color: var(--lv-warn-fg);
      background: var(--lv-warn-bg);
    }
    .badge[data-level='ERROR'] {
      color: var(--lv-error-fg);
      background: var(--lv-error-bg);
      border-color: var(--lv-error-edge);
    }
    .badge[data-level='FATAL'] {
      color: var(--lv-fatal-fg);
      background: var(--lv-fatal-bg);
    }
    .notice {
      flex: none;
      padding: 2px 8px;
      background: var(--bg-panel);
      color: var(--text-dim);
      font-size: 12px;
      border-bottom: 1px solid var(--border);
    }
    .empty {
      padding: 12px;
      color: var(--text-dim);
    }
    .body {
      flex: 1;
      min-height: 0;
      margin: 0;
      padding: 6px 10px;
      overflow: auto;
      font-family: var(--font-mono);
      font-size: var(--detail-font-size, 13px);
      line-height: 1.45;
      white-space: pre;
      color: var(--text);
      user-select: text;
      -webkit-user-select: text;
    }
    .body[hidden] {
      display: none;
    }
    .body.wrap {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .body:focus-visible {
      outline-offset: -2px;
    }
    .body .t-time,
    .body .f-comment,
    .body .f-punct {
      color: var(--tok-time);
    }
    .body .t-number,
    .body .f-number {
      color: var(--tok-number);
    }
    .body .t-string,
    .body .f-string,
    .body .f-cdata {
      color: var(--tok-string);
    }
    .body .t-id,
    .body .f-attr,
    .body .f-literal,
    .body .f-meta {
      color: var(--tok-id);
    }
    .body .t-url,
    .body .f-key,
    .body .f-tag {
      color: var(--tok-url);
    }
    .body .hit {
      background: var(--hit-bg);
      color: var(--hit-text);
    }
  `,
})
export class DetailPanelComponent {
  readonly session = input.required<SessionState>();

  private readonly api = inject(LogApi);
  private readonly sessions = inject(LogSessionService);
  private readonly settingsService = inject(SettingsService);
  private readonly body = viewChild.required<ElementRef<HTMLPreElement>>('body');

  /** The line whose entry is shown: the anchor of the selection, nothing else. */
  protected readonly anchor = computed(() => this.session().selection()?.anchor ?? null);
  protected readonly entry = signal<EntryDetail | null>(null);
  protected readonly loading = signal(false);
  private readonly error = signal<string | null>(null);
  /** Raw or formatted; formatted wins whenever a block is found. */
  protected readonly formatted = signal(true);
  protected readonly wrap = computed(() => this.settingsService.settings().detailWrap);
  protected readonly fontSize = computed(() => this.settingsService.settings().fontSize);

  protected readonly formattedView = computed(() => {
    const entry = this.entry();
    return entry ? formatDetail(entry.text) : null;
  });
  protected readonly showFormatted = computed(() => this.formatted() && !!this.formattedView());
  private readonly segments = computed<TextSegment[]>(() => {
    const entry = this.entry();
    if (!entry) return [];
    const formatted = this.showFormatted() ? this.formattedView() : null;
    return formatted ? formatted.segments : rawSegments(entry.text, this.session().query());
  });

  protected readonly rangeLabel = computed(() => {
    const entry = this.entry();
    return entry ? lineRangeLabel(entry.first, entry.last) : '';
  });
  protected readonly sizeLabel = computed(() => {
    const entry = this.entry();
    if (!entry) return '';
    const lines = entry.lineCount === 1 ? '1 Zeile' : `${formatCount(entry.lineCount)} Zeilen`;
    return `${lines} · ${formatBytes(entry.totalBytes)}`;
  });
  /** A merge: the file of the entry and where its head starts in it (no line number of that file). */
  protected readonly sourceLabel = computed(() => {
    const entry = this.entry();
    const session = this.session();
    if (!entry || !session.isMerge) return '';
    const file = session.sources[entry.source]?.fileName ?? '?';
    return `${file} @ Byte ${formatCount(entry.byteOffset)}`;
  });
  protected readonly sourcePath = computed(() => {
    const entry = this.entry();
    return entry ? (this.session().sources[entry.source]?.path ?? '') : '';
  });

  protected sourceColorOf(index: number): number {
    return sourceColor(index);
  }

  protected readonly notice = computed(() => {
    const notes: string[] = [];
    const error = this.error();
    if (error) notes.push(error);
    if (this.entry()?.truncated) notes.push('Anzeige nach 1 MB gekürzt, Kopieren liefert alles');
    if (this.session().update().frozenStale) {
      notes.push('Datei wurde im Freeze geleert: der Text kann abweichen');
    }
    return notes.join(' · ');
  });
  protected readonly emptyText = computed(() =>
    this.anchor() === null ? 'Zeile anklicken, um den Eintrag zu sehen' : 'Eintrag wird geladen …',
  );

  /** What the shown entry was asked for, and its last line once the answer is in. */
  private loaded: EntryKey | null = null;
  private loadedLast: number | null = null;
  private inFlight = false;
  private again = false;
  /** Entry (tab + first line) the text was drawn for: another one starts at the top. */
  private drawnFor = '';

  constructor() {
    effect(() => {
      // Tab, line and every update of the backend.
      this.anchor();
      this.session().update();
      untracked(() => this.sync());
    });
    effect(() => {
      const segments = this.segments();
      const entry = this.entry();
      const pre = this.body().nativeElement;
      untracked(() => this.render(pre, segments, entry));
    });
  }

  private current(): EntryKey | null {
    const session = this.session();
    const anchor = this.anchor();
    if (anchor === null) return null;
    const update = session.update();
    return {
      sessionId: session.id,
      anchor,
      epoch: update.epoch,
      viewGeneration: update.viewGeneration,
      totalLines: update.totalLines,
      fileSize: update.fileSize,
    };
  }

  /** Loads when the line, tab or view changed, or when an entry at the end may have grown. */
  private sync(): void {
    const now = this.current();
    if (!now) {
      this.loaded = null;
      this.loadedLast = null;
      this.entry.set(null);
      this.error.set(null);
      return;
    }
    if (!needsReload(this.loaded, this.loadedLast, now)) return;
    // One call at a time: updates while it runs ask once more afterwards.
    if (this.inFlight) {
      this.again = true;
      return;
    }
    const sameEntry =
      this.loaded?.sessionId === now.sessionId &&
      this.loaded.anchor === now.anchor &&
      this.loaded.epoch === now.epoch;
    if (!sameEntry) this.entry.set(null);
    this.loaded = now;
    this.loadedLast = null;
    this.inFlight = true;
    this.loading.set(true);
    // `now.sessionId` is the tab; the backend knows the session of the file (prompt 013).
    this.api
      .getEntry(this.session().sessionId, now.anchor)
      .then((entry) => {
        // An answer for a line that is no longer selected is overtaken.
        if (!sameKey(this.current(), now)) return;
        this.entry.set(entry);
        this.loadedLast = entry.last;
        this.error.set(null);
      })
      .catch((e) => {
        if (!sameKey(this.current(), now)) return;
        this.loadedLast = now.anchor;
        this.error.set(describeError(toAppError(e)));
      })
      .finally(() => {
        this.inFlight = false;
        this.loading.set(false);
        const again = this.again;
        this.again = false;
        if (again || !sameKey(this.current(), now)) this.sync();
      });
  }

  /** Text nodes only: the entry is foreign data. */
  private render(pre: HTMLPreElement, segments: TextSegment[], entry: EntryDetail | null): void {
    const fragment = document.createDocumentFragment();
    for (const seg of segments) {
      if (!seg.cls) {
        fragment.appendChild(document.createTextNode(seg.text));
        continue;
      }
      const span = document.createElement('span');
      span.className = seg.cls;
      span.textContent = seg.text;
      fragment.appendChild(span);
    }
    pre.replaceChildren(fragment);
    const key = entry ? `${this.session().id}:${entry.first}` : '';
    if (key !== this.drawnFor) {
      this.drawnFor = key;
      pre.scrollTop = 0;
      pre.scrollLeft = 0;
    }
  }

  protected toggleWrap(): void {
    this.settingsService.update({ detailWrap: !this.wrap() });
  }

  protected toggleFullLog(): void {
    void this.sessions.toggleFullLog(this.session());
  }

  protected copy(): void {
    const entry = this.entry();
    if (entry) void this.sessions.copyEntry(this.session(), entry.first, entry.last);
  }

  protected close(): void {
    this.settingsService.update({ detailVisible: false });
  }
}

function sameKey(a: EntryKey | null, b: EntryKey): boolean {
  return (
    !!a &&
    a.sessionId === b.sessionId &&
    a.anchor === b.anchor &&
    a.epoch === b.epoch &&
    a.viewGeneration === b.viewGeneration
  );
}
