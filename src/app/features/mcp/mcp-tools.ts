import { effect, inject } from '@angular/core';
import { ActionService } from '../../core/actions/action.service';
import { ActionId, ACTIONS } from '../../core/actions/action-catalog';
import { AppError, toAppError } from '../../core/errors/app-error';
import { LogApi } from '../../core/log/log-api';
import {
  ExportFormat,
  ExportRange,
  ExtractRule,
  LEVELS,
  Level,
  LogLine,
  SessionUpdate,
  ValueKind,
} from '../../core/log/log.models';
import { McpReplyError } from '../../core/mcp/mcp.models';
import { SettingsService } from '../../core/settings/settings.service';
import { ExportService } from '../export/export.service';
import { ALL_LEVELS } from '../sessions/filter-logic';
import { compileTree, emptyTree } from '../sessions/filter-tree';
import { LogSessionService } from '../sessions/log-session.service';
import { SessionState } from '../sessions/session-state';
import { MCP_ACTIONS } from './mcp-actions';
import { MCP_LIMITS as L } from './mcp-limits';
import {
  Args,
  McpError,
  asArgs,
  bool,
  fail,
  int,
  isSecretColumn,
  isoOf,
  maskSecrets,
  maskValue,
  levelsArg,
  oneOf,
  optInt,
  optStr,
  reqInt,
  searchArg,
  str,
  textOut,
  timeArg,
  treeForAi,
  treeFromAi,
} from './mcp-logic';
import type { McpProposal, McpService } from './mcp.service';

const NOTE_PREFIX = 'KI: ';
/** Longest a search or level loop runs before it answers with what it has (review 022 #6). */
const LOOP_MS = 20_000;

/** Characters a path to show the user must not contain: controls and bidi overrides could hide its real end. */
// eslint-disable-next-line no-control-regex
const HIDING = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/;

/**
 * A path the AI wants opened (review 022 #5): absolute, local, no `.`/`..` segments (the dialog shows what is
 * opened, not where it starts), no characters that hide text, no UNC or device paths (Windows would contact
 * another host).
 */
export function checkOpenPath(p: string): void {
  if (HIDING.test(p)) fail('invalid_args', 'the path contains control or direction characters');
  if (/^(\\\\|\/\/)/.test(p))
    fail('invalid_args', `${p}: network and device paths are not allowed`);
  if (!/^(\/|[A-Za-z]:[\\/])/.test(p)) fail('invalid_args', `${p} is not an absolute path`);
  if (p.split(/[\\/]/).some((part) => part === '.' || part === '..')) {
    fail('invalid_args', `${p}: write the path without . and .. segments`);
  }
}
const MAX_LINE = 2 ** 32;

/** Waits for a condition on signals the backend updates; `false` after `ms`. */
function waitFor(test: () => boolean, ms: number, step = 100): Promise<boolean> {
  return new Promise((resolve) => {
    const end = Date.now() + ms;
    const tick = () => {
      if (test()) resolve(true);
      else if (Date.now() >= end) resolve(false);
      else setTimeout(tick, step);
    };
    tick();
  });
}

/** The outcome of one call for the bridge and the history. */
export interface ToolRun {
  result: unknown;
  error: McpReplyError | null;
  tab: SessionState | null;
}

/**
 * The tools of AI control (prompt 022), a lazy chunk: loaded with the first call, so the start bundle stays small.
 * Every tool goes through the services keyboard and menu use. Created by `McpService` in an injection context.
 */
export class McpTools {
  private readonly api = inject(LogApi);
  private readonly sessions = inject(LogSessionService);
  private readonly settings = inject(SettingsService);
  private readonly actions = inject(ActionService);
  private readonly exporter = inject(ExportService);

  /** Filter tabs this app session's AI opened (only those it may close). */
  private readonly ownTabs = new Set<number>();
  /** Bookmarks and notes the AI set, per file (keyed by the shared signal of the file's tabs). */
  private readonly ownMarks = new WeakMap<object, { epoch: number; lines: Set<number> }>();

  constructor(private readonly host: McpService) {
    // A mark the user removes is forgotten at once, so a later mark of the user on that line is never taken for
    // the AI's (review 022 #9).
    effect(() => {
      for (const tab of this.sessions.sessions()) {
        if (this.ownMarks.has(tab.bookmarks)) this.own(tab, 'b');
        if (this.ownMarks.has(tab.notes)) this.own(tab, 'n');
      }
    });
  }

  async run(tool: string, raw: unknown): Promise<ToolRun> {
    let tab: SessionState | null = null;
    try {
      const result = await this.dispatch(tool, asArgs(raw), (s) => (tab = s));
      // Hidden while the call ran (a long wait, a filter job): nothing of it goes out (review 022 #8).
      const seen = tab as SessionState | null;
      if (seen && (this.host.isHidden(seen) || !this.sessions.sessions().includes(seen))) {
        return {
          result: null,
          error: { code: 'tab_not_found', message: 'the tab is gone – call get_workspace' },
          tab,
        };
      }
      return { result, error: null, tab };
    } catch (e) {
      if (e instanceof McpError)
        return { result: null, error: { code: e.code, message: e.message }, tab };
      const app: AppError = toAppError(e);
      return { result: null, error: { code: app.code, message: app.message }, tab };
    }
  }

  // ---------------------------------------------------------------- dispatch

  private dispatch(
    tool: string,
    a: Args,
    seen: (s: SessionState) => void,
  ): Promise<unknown> | unknown {
    const tab = (): SessionState => {
      const s = this.tab(a);
      seen(s);
      return s;
    };
    switch (tool) {
      case 'get_workspace':
        return this.getWorkspace();
      case 'get_tab':
        return this.getTab(tab());
      case 'get_stats':
        return this.getStats(tab());
      case 'read_lines':
        return this.readLines(tab(), a);
      case 'get_entry':
        return this.getEntry(tab(), a);
      case 'search':
        return this.search(tab(), a);
      case 'find_level':
        return this.findLevel(tab(), a);
      case 'get_timeline':
        return this.getTimeline(tab(), a);
      case 'line_at_time':
        return this.lineAtTime(tab(), a);
      case 'report_schema':
        return this.reportSchema(tab());
      case 'run_sql':
        return this.runSql(tab(), a);
      case 'preview_field_rule':
        return this.previewRule(tab(), a);
      case 'list_actions':
        return this.listActions();
      case 'wait_for_lines':
        return this.waitForLines(tab(), a);
      case 'activate_tab':
        return this.activateTab(tab());
      case 'reveal_line':
        return this.revealLine(tab(), a);
      case 'set_filter':
        return this.setFilter(tab(), a);
      case 'open_filter_tab':
        return this.openFilterTab(tab(), a);
      case 'close_tab':
        return this.closeTab(tab());
      case 'set_bookmark':
        return this.setBookmark(tab(), a, true);
      case 'remove_bookmark':
        return this.setBookmark(tab(), a, false);
      case 'add_note':
        return this.setNote(tab(), a, true);
      case 'remove_note':
        return this.setNote(tab(), a, false);
      case 'set_frozen':
        return this.setFrozen(tab(), a);
      case 'set_follow':
        return this.setFollow(tab(), a);
      case 'set_column_mode':
        return this.setColumnMode(tab(), a);
      case 'run_action':
        return this.runAction(a);
      case 'propose_open':
        return this.proposeOpen(a);
      case 'propose_export':
        return this.proposeExport(tab(), a);
      case 'propose_field_rule':
        return this.proposeFieldRule(tab(), a);
      default:
        fail('unknown_tool', `unknown tool ${tool}`);
    }
  }

  // ---------------------------------------------------------------- tabs

  private visibleTabs(): SessionState[] {
    return this.sessions.sessions().filter((s) => !this.host.isHidden(s));
  }

  private tab(a: Args): SessionState {
    const id = optInt(a, 'tab_id', { min: 0, max: Number.MAX_SAFE_INTEGER });
    const visible = this.visibleTabs();
    const found =
      id === undefined
        ? visible.find((s) => s.id === this.sessions.activeId())
        : visible.find((s) => s.id === id);
    if (!found) {
      fail(
        'tab_not_found',
        id === undefined
          ? visible.length
            ? 'no tab is in front – pass tab_id from get_workspace'
            : 'no tab is open – ask the user to open a log (or use propose_open)'
          : `no tab ${id} – call get_workspace`,
      );
    }
    this.checkEpoch(found, a);
    return found;
  }

  private checkEpoch(s: SessionState, a: Args): void {
    const epoch = optInt(a, 'epoch', { min: 0, max: Number.MAX_SAFE_INTEGER });
    if (epoch !== undefined && epoch !== s.update().epoch) {
      fail(
        'stale_view',
        `line numbers changed (epoch ${epoch} → ${s.update().epoch}: truncated, rotated or re-sorted) – fetch lines again`,
      );
    }
  }

  private mask(): boolean {
    return this.settings.settings().mcp.maskSecrets;
  }

  private summary(s: SessionState) {
    const u = s.update();
    const kind = s.isSource ? 'source' : s.isMerge ? 'merge' : 'file';
    return {
      tab_id: s.id,
      title: s.tabLabel(),
      kind,
      filter_tab: s.viewId !== 0,
      parent_tab_id: s.parent()?.id ?? null,
      path: s.isSource ? null : s.isMerge ? null : s.path,
      files: s.isMerge ? s.sources.map((x) => x.path) : undefined,
      source: s.source ? { kind: s.source.kind, label: s.source.label } : undefined,
      profile: u.profileId,
      lines: u.totalLines,
      view_lines: u.filteredLines,
      frozen: u.frozen,
      following: s.follow(),
      status: s.status().kind,
      epoch: u.epoch,
      active: s.id === this.sessions.activeId(),
    };
  }

  private getWorkspace() {
    const tabs = this.visibleTabs().map((s) => this.summary(s));
    const active = tabs.find((t) => t.active)?.tab_id ?? null;
    return { tabs, active_tab_id: active, hint: tabs.length ? undefined : 'no tab is open' };
  }

  private async getTab(s: SessionState) {
    const u = s.update();
    const columns = s.columns() ?? (await this.api.getColumns(s.sessionId).catch(() => null));
    const selection = s.selection();
    const notes = [...s.notes()].map(([line, text]) => ({
      line: line + 1,
      text: textOut(text, L.noteCharsMax, this.mask()).text,
    }));
    return {
      ...this.summary(s),
      view_generation: u.viewGeneration,
      filter: {
        levels: [...s.levels()],
        search: s.query().text
          ? {
              text: s.query().text,
              regex: s.query().isRegex,
              case_sensitive: s.query().caseSensitive,
              mode: s.searchMode(),
            }
          : null,
        tree: s.filterTree().children.length ? treeForAi(s.filterTree()) : null,
        pending: u.filterPending,
        progress: u.filterProgress,
      },
      columns: (columns?.columns ?? []).map((c) => ({
        id: c.id,
        label: c.label,
        kind: c.kind,
        ...(c.unit ? { unit: c.unit } : {}),
        ...(c.rule ? { rule: true } : {}),
      })),
      selection: selection
        ? { line: selection.anchor + 1, first: selection.first + 1, last: selection.last + 1 }
        : null,
      bookmarks: [...s.bookmarks()].sort((x, y) => x - y).map((l) => l + 1),
      notes,
      encoding: u.encoding,
      file_size: u.fileSize,
    };
  }

  private async getStats(s: SessionState) {
    const u = s.update();
    const t = await this.api.getTimeline(s.sessionId, null, null, 1).catch(() => null);
    return {
      tab_id: s.id,
      epoch: u.epoch,
      lines: u.totalLines,
      view_lines: u.filteredLines,
      file_size: u.fileSize,
      counts_file: u.counts,
      counts_view: u.viewCounts,
      entries: t?.entries ?? null,
      time_span: t?.hasTimes
        ? { from: isoOf(t.from), to: isoOf(t.to), note: '1st to 99th percentile' }
        : null,
      filter_pending: u.filterPending,
    };
  }

  // ---------------------------------------------------------------- reading

  private async lineOut(
    s: SessionState,
    line: LogLine,
    pos: number | null,
    max: number,
    fields: boolean,
  ): Promise<Record<string, unknown>> {
    const t = textOut(line.text, max, this.mask());
    const out: Record<string, unknown> = {
      line: line.line + 1,
      ...(pos !== null ? { pos: pos + 1 } : {}),
      level: line.level,
      ...(line.isContinuation ? { continuation: true } : {}),
      ...(s.isMerge ? { source: s.sourceLabels[line.source] ?? line.source } : {}),
      text: t.text,
      ...(t.truncatedChars ? { truncated_chars: t.truncatedChars } : {}),
      ...(t.masked ? { masked: t.masked } : {}),
    };
    if (fields) {
      const cols = s.columns()?.columns ?? [];
      const values: Record<string, string> = {};
      line.fields.forEach(([start, end], i) => {
        if (end > start && cols[i]) {
          // A column named like a secret is masked as a whole: its value alone matches no pattern (review 022 #1).
          values[cols[i].id] =
            this.mask() && isSecretColumn(cols[i].id)
              ? '«masked»'
              : textOut(line.text.slice(start, end), max, this.mask()).text;
        }
      });
      out['fields'] = values;
    }
    return out;
  }

  private async readLines(s: SessionState, a: Args) {
    const count = int(a, 'count', { min: 1, max: L.readLinesMax, def: L.readLinesDefault });
    const max = int(a, 'max_line_chars', {
      min: L.lineCharsMin,
      max: L.lineCharsMax,
      def: L.lineCharsDefault,
    });
    const fields = bool(a, 'fields');
    const total = s.update().filteredLines;
    const around = optInt(a, 'around_line', { min: 1, max: MAX_LINE });
    let start: number;
    if (around !== undefined) {
      const pos = await this.api.getPosition(s.sessionId, around - 1, s.viewId);
      start = Math.max(0, pos - Math.floor(count / 2));
    } else {
      const given = optInt(a, 'start', { min: -MAX_LINE, max: MAX_LINE });
      start = given === undefined ? total - count : given < 0 ? total + given : given - 1;
    }
    start = Math.max(0, Math.min(start, Math.max(0, total - 1)));
    const lines = total
      ? await this.api.getLines(s.sessionId, 'filtered', start, count, s.viewId)
      : [];
    const out = [];
    for (let i = 0; i < lines.length; i++)
      out.push(await this.lineOut(s, lines[i], start + i, max, fields));
    const u = s.update();
    return {
      tab_id: s.id,
      epoch: u.epoch,
      view_generation: u.viewGeneration,
      view_lines: total,
      from_pos: start + 1,
      lines: out,
      more_before: start > 0,
      more_after: start + lines.length < total,
    };
  }

  private async getEntry(s: SessionState, a: Args) {
    const line = reqInt(a, 'line', { min: 1, max: MAX_LINE });
    const max = int(a, 'max_chars', {
      min: L.entryCharsMin,
      max: L.entryCharsMax,
      def: L.entryCharsDefault,
    });
    const e = await this.api.getEntry(s.sessionId, line - 1);
    const t = textOut(e.text, max, this.mask());
    return {
      tab_id: s.id,
      epoch: s.update().epoch,
      first_line: e.first + 1,
      last_line: e.last + 1,
      line_count: e.lineCount,
      level: e.level,
      ...(s.isMerge ? { source: s.sourceLabels[e.source] ?? e.source } : {}),
      text: t.text,
      ...(t.truncatedChars || e.truncated ? { truncated: true } : {}),
      ...(t.masked ? { masked: t.masked } : {}),
    };
  }

  private async hitsOut(
    s: SessionState,
    hits: { line: number; position: number }[],
    max: number,
  ): Promise<Record<string, unknown>[]> {
    const out = [];
    for (const h of hits) {
      const [l] = await this.api.getLines(s.sessionId, 'filtered', h.position, 1, s.viewId);
      out.push(
        l
          ? await this.lineOut(s, l, h.position, max, false)
          : { line: h.line + 1, pos: h.position + 1 },
      );
    }
    return out;
  }

  private async search(s: SessionState, a: Args) {
    const query = {
      text: str(a, 'query', L.patternCharsMax),
      isRegex: bool(a, 'regex'),
      caseSensitive: bool(a, 'case_sensitive'),
    };
    const limit = int(a, 'limit', { min: 1, max: L.hitsMax, def: L.hitsDefault });
    const max = int(a, 'max_line_chars', { min: L.lineCharsMin, max: L.lineCharsMax, def: 300 });
    const forward = !bool(a, 'backwards');
    const fromLine = optInt(a, 'from_line', { min: 1, max: MAX_LINE });
    let from: number | null = fromLine === undefined ? null : fromLine - 1;
    const hits: { line: number; position: number }[] = [];
    let wrapped = false;
    const until = Date.now() + LOOP_MS;
    while (hits.length < limit && Date.now() < until) {
      const hit = await this.api.find(s.sessionId, from, query, forward, s.viewId);
      if (!hit || hit.wrapped || hits.some((h) => h.line === hit.line)) {
        wrapped = !!hit;
        break;
      }
      hits.push(hit);
      from = hit.line;
    }
    return {
      tab_id: s.id,
      epoch: s.update().epoch,
      hits: await this.hitsOut(s, hits, max),
      complete: hits.length < limit,
      ...(wrapped ? { note: 'reached the end of the view' } : {}),
    };
  }

  private async findLevel(s: SessionState, a: Args) {
    const levels = levelsArg(a, 'levels') ?? (['ERROR', 'FATAL'] as Level[]);
    const limit = int(a, 'limit', { min: 1, max: L.hitsMax, def: L.hitsDefault });
    const max = int(a, 'max_line_chars', { min: L.lineCharsMin, max: L.lineCharsMax, def: 300 });
    const forward = !bool(a, 'backwards');
    const fromLine = optInt(a, 'from_line', { min: 1, max: MAX_LINE });
    let from: number | null =
      fromLine === undefined
        ? null
        : await this.api.getPosition(s.sessionId, fromLine - 1, s.viewId);
    // `find_level` is strictly after/before `from`: step one back so the line itself counts.
    if (from !== null) from = forward ? from - 1 : from + 1;
    if (from !== null && from < 0) from = null;
    const hits: { line: number; position: number }[] = [];
    const until = Date.now() + LOOP_MS;
    while (hits.length < limit && Date.now() < until) {
      const hit = await this.api.findLevel(s.sessionId, from, forward, levels, s.viewId);
      if (!hit || hits.some((h) => h.position === hit.position)) break;
      hits.push(hit);
      from = hit.position;
    }
    return {
      tab_id: s.id,
      epoch: s.update().epoch,
      levels,
      hits: await this.hitsOut(s, hits, max),
      complete: hits.length < limit,
    };
  }

  private async getTimeline(s: SessionState, a: Args) {
    const from = timeArg(a, 'from');
    const to = timeArg(a, 'to');
    const buckets = int(a, 'buckets', { min: 1, max: L.bucketsMax, def: L.bucketsDefault });
    const t = await this.api.getTimeline(s.sessionId, from ?? null, to ?? null, buckets);
    if (!t.hasTimes) return { tab_id: s.id, has_times: false, entries: t.entries };
    const width = (t.to - t.from) / Math.max(1, t.buckets.length);
    return {
      tab_id: s.id,
      epoch: t.epoch,
      has_times: true,
      entries: t.entries,
      from: isoOf(t.from),
      to: isoOf(t.to),
      bucket_seconds: Math.round(width / 1e6),
      buckets: t.buckets.map((b, i) => ({
        start: isoOf(t.from + i * width),
        all: Math.round(b.all),
        warn: Math.round(b.warn),
        error: Math.round(b.error),
        fatal: Math.round(b.fatal),
      })),
      gaps: t.gaps.map((g) => ({ from: isoOf(g.from), to: isoOf(g.to) })),
      note: 'counts are approximate; gaps are stretches without any entry',
    };
  }

  private async lineAtTime(s: SessionState, a: Args) {
    const ts = timeArg(a, 'time', true);
    const hit = await this.api.positionAtTime(s.sessionId, ts, s.viewId);
    if (!hit) return { tab_id: s.id, found: false, note: 'the view has no times' };
    return {
      tab_id: s.id,
      epoch: s.update().epoch,
      found: true,
      line: hit.line + 1,
      pos: hit.position + 1,
      exact: hit.exact,
    };
  }

  // ---------------------------------------------------------------- SQL

  private reportCalls = 0;

  /** Opens the dashboard database if needed and waits until it is ready (design A10). */
  private async withReport<T>(s: SessionState, work: () => Promise<T>): Promise<T> {
    // The backend counts who has the report open: this opening never closes the dashboard the user looks
    // at, nor the report of another call that runs at the same time.
    const user = `mcp:${++this.reportCalls}`;
    await this.api.openReport(s.sessionId, null, user, true);
    try {
      const ready = await waitFor(() => s.update().report?.state === 'ready', L.filterWaitMs, 200);
      const r = s.update().report;
      if (!ready) {
        if (r?.state === 'error')
          fail('invalid_query', r.message ?? 'the table could not be built');
        fail(
          'report_building',
          `the SQL table is still being built (${Math.round((r?.progress ?? 0) * 100)} %) – try again in a few seconds`,
        );
      }
      return await work();
    } finally {
      void this.api.closeReport(s.sessionId, user).catch(() => undefined);
    }
  }

  private async reportSchema(s: SessionState) {
    return this.withReport(s, async () => {
      const schema = await this.api.getReportSchema(s.sessionId);
      return {
        tab_id: s.id,
        table: schema.table,
        columns: schema.columns.map((c) => ({
          name: c.name,
          type: c.sqlType,
          description: c.description,
          ...(c.unit ? { unit: c.unit } : {}),
        })),
        sources: schema.sources,
        rows: schema.status?.rows ?? null,
      };
    });
  }

  private async runSql(s: SessionState, a: Args) {
    const sql = str(a, 'sql', L.sqlBytesMax);
    if (new TextEncoder().encode(sql).length > L.sqlBytesMax)
      fail('invalid_args', `sql is longer than ${L.sqlBytesMax} bytes`);
    const limit = int(a, 'limit', { min: 1, max: L.sqlRowsMax, def: L.sqlRowsDefault });
    return this.withReport(s, async () => {
      const r = await this.api.runReport(s.sessionId, sql, 'mcp');
      return {
        tab_id: s.id,
        columns: r.columns,
        rows: r.rows
          .slice(0, limit)
          .map((row) => row.map((cell, i) => maskValue(r.columns[i] ?? '', cell, this.mask()))),
        row_count: r.rows.length,
        truncated: r.truncated || r.rows.length > limit,
        elapsed_ms: r.elapsedMs,
      };
    });
  }

  private async previewRule(s: SessionState, a: Args) {
    const rule = this.ruleArg(a, 'preview');
    const n = int(a, 'lines', { min: 1, max: 200, def: 50 });
    const total = s.update().filteredLines;
    const lines = total
      ? await this.api.getLines(s.sessionId, 'filtered', Math.max(0, total - n), n, s.viewId)
      : [];
    const cols = s.columns()?.columns ?? [];
    const index = cols.findIndex((c) => c.id === rule.column);
    if (index < 0) fail('invalid_args', `no column ${rule.column} – see get_tab columns`);
    // The rule runs on masked text: a pattern like `password=(\S+)` captures «masked» (review 022 #1).
    const texts = lines.map((l) => {
      const [start, end] = l.fields[index] ?? [0, 0];
      const text = l.isContinuation ? '' : l.text.slice(start, end);
      return this.mask() ? maskSecrets(text).text : text;
    });
    const p = await this.api.previewExtractRule(rule, texts);
    const results = lines.map((l, i) => ({
      line: l.line + 1,
      value: p.spans[i]
        ? textOut(texts[i].slice(p.spans[i]![0], p.spans[i]![1]), 200, this.mask()).text
        : null,
      ...(p.values[i] !== null && p.values[i] !== undefined ? { number: p.values[i] } : {}),
    }));
    return {
      tab_id: s.id,
      matched: results.filter((r) => r.value !== null).length,
      tried: results.length,
      results: results.filter((r) => r.value !== null).slice(0, 50),
    };
  }

  private ruleArg(a: Args, id: string): ExtractRule {
    return {
      id,
      name: optStr(a, 'name', 40) ?? 'preview',
      column: optStr(a, 'source_column', 64) || 'message',
      pattern: str(a, 'pattern', L.patternCharsMax),
      kind: oneOf<ValueKind>(
        a,
        'kind',
        ['text', 'number', 'percent', 'duration', 'size'],
        'number',
      ),
      unit: optStr(a, 'unit', 8) || null,
    };
  }

  private listActions() {
    return {
      actions: MCP_ACTIONS.map((id) => {
        const def = ACTIONS.find((x) => x.id === id);
        return { id, name: def?.label ?? id, group: def?.group ?? '' };
      }),
    };
  }

  // ---------------------------------------------------------------- live

  /** A hidden backend view with the pattern below the tab's view (design A8); its growth is the news. */
  private async waitForLines(s: SessionState, a: Args) {
    const text = optStr(a, 'query', L.patternCharsMax) ?? '';
    const levels = levelsArg(a, 'levels');
    if (!text && !levels) fail('invalid_args', 'give query, levels or both');
    const timeout = int(a, 'timeout_s', {
      min: 1,
      max: L.waitSecondsMax,
      def: L.waitSecondsDefault,
    });
    const limit = int(a, 'limit', { min: 1, max: L.waitLinesMax, def: L.waitLinesDefault });
    const max = int(a, 'max_line_chars', {
      min: L.lineCharsMin,
      max: L.lineCharsMax,
      def: L.lineCharsDefault,
    });
    let latest: SessionUpdate | null = null;
    let wake: () => void = () => undefined;
    const view = await this.api.openView(
      s.sessionId,
      s.viewId,
      {
        levels: levels ?? [...ALL_LEVELS],
        query: { text, isRegex: bool(a, 'regex'), caseSensitive: bool(a, 'case_sensitive') },
        mode: 'filter',
        sources: null,
        expr: null,
      },
      (u) => {
        latest = u;
        wake();
      },
    );
    try {
      const current = (): SessionUpdate => latest ?? view.update;
      // The existing matches are found first; only lines after them are new.
      await waitFor(() => !current().filterPending, L.filterWaitMs);
      const base = current().filteredLines;
      const epoch = current().epoch;
      const end = Date.now() + timeout * 1000;
      while (Date.now() < end) {
        const u = current();
        // The tab was closed while waiting: its updates end, the wait would run into its time limit.
        if (!this.sessions.sessions().includes(s))
          fail('tab_not_found', 'the tab was closed while waiting – call get_workspace');
        if (u.epoch !== epoch)
          fail('stale_view', 'the file started over while waiting – call again');
        if (u.filteredLines > base && !u.filterPending) {
          const lines = await this.api.getLines(s.sessionId, 'filtered', base, limit, view.viewId);
          const out = [];
          for (const l of lines) out.push(await this.lineOut(s, l, null, max, false));
          return {
            tab_id: s.id,
            epoch,
            timed_out: false,
            lines: out,
            more: u.filteredLines - base > lines.length,
          };
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(1000, Math.max(0, end - Date.now())));
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
      return { tab_id: s.id, epoch, timed_out: true, lines: [] };
    } finally {
      void this.api.closeView(s.sessionId, view.viewId).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- view

  private activateTab(s: SessionState) {
    this.sessions.activate(s.id);
    return { tab_id: s.id, active: true };
  }

  private async revealLine(s: SessionState, a: Args) {
    const line = reqInt(a, 'line', { min: 1, max: MAX_LINE });
    this.sessions.activate(s.id);
    await this.sessions.showLine(s, line - 1);
    if (bool(a, 'select', true)) await this.sessions.selectEntry(s, line - 1, false);
    const sel = s.selection();
    return {
      tab_id: s.id,
      line,
      selected: sel ? { first: sel.first + 1, last: sel.last + 1 } : null,
    };
  }

  private filterArgs(s: SessionState, a: Args) {
    const levels = levelsArg(a, 'levels');
    const search = searchArg(a);
    const tree =
      a['tree'] === undefined || a['tree'] === null ? emptyTree() : treeFromAi(a['tree']);
    if (tree.children.length) compileTree(tree);
    return {
      levels: new Set<Level>(levels ?? LEVELS),
      query: search?.query ?? { text: '', isRegex: false, caseSensitive: false },
      mode: search?.mode ?? ('filter' as const),
      tree,
      s,
    };
  }

  /** Waits for the filter job of a tab; the answer says how far it got. */
  private async filterDone(s: SessionState) {
    const done = await waitFor(() => !s.update().filterPending, L.filterWaitMs);
    const u = s.update();
    const error =
      s.treeError() ?? (s.searchError() ? { nodeId: null, message: s.searchError()! } : null);
    if (error)
      fail('invalid_search', error.message + (error.nodeId ? ` (node ${error.nodeId})` : ''));
    return {
      tab_id: s.id,
      title: s.tabLabel(),
      complete: done,
      view_lines: u.filteredLines,
      counts_view: u.viewCounts,
      epoch: u.epoch,
      view_generation: u.viewGeneration,
    };
  }

  private async setFilter(s: SessionState, a: Args) {
    const f = this.filterArgs(s, a);
    await this.sessions.applyPreset(s, {
      levels: f.levels,
      query: f.query,
      mode: f.mode,
      tree: f.tree,
    });
    return this.filterDone(s);
  }

  private async openFilterTab(parent: SessionState, a: Args) {
    const f = this.filterArgs(parent, a);
    const limit = this.sessions.filterTabLimit(parent);
    if (limit) fail('too_many_views', limit);
    const created = await this.sessions.openFilterTab(parent, {
      levels: f.levels,
      query: f.query,
      mode: f.mode,
      tree: f.tree,
    });
    if (!created) fail('io', this.sessions.error() ?? 'the filter tab could not be opened');
    this.ownTabs.add(created.id);
    return { ...(await this.filterDone(created)), parent_tab_id: parent.id };
  }

  private async closeTab(s: SessionState) {
    if (!this.ownTabs.has(s.id))
      fail('denied', 'only filter tabs this AI opened can be closed – ask the user');
    await this.sessions.close(s.id);
    this.ownTabs.delete(s.id);
    return { tab_id: s.id, closed: true };
  }

  /**
   * The marks this AI set on the file, as far as they still exist in this epoch: a mark the user removed, or a line
   * number of an older epoch, is forgotten, so the AI never takes a later mark of the user for its own (review 022 #9).
   */
  private own(s: SessionState, kind: 'b' | 'n'): Set<number> {
    const key = kind === 'b' ? s.bookmarks : s.notes;
    const epoch = s.update().epoch;
    let entry = this.ownMarks.get(key);
    if (!entry || entry.epoch !== epoch)
      this.ownMarks.set(key, (entry = { epoch, lines: new Set() }));
    const present = kind === 'b' ? s.bookmarks() : new Set(s.notes().keys());
    for (const line of [...entry.lines]) if (!present.has(line)) entry.lines.delete(line);
    return entry.lines;
  }

  /** The head of the entry of a line (bookmarks and notes sit on heads). */
  private async head(s: SessionState, a: Args): Promise<number> {
    const line = reqInt(a, 'line', { min: 1, max: MAX_LINE });
    if (line > s.update().totalLines)
      fail('invalid_args', `line ${line} is past the end (${s.update().totalLines} lines)`);
    return (await this.api.getEntryRange(s.sessionId, line - 1)).first;
  }

  private async setBookmark(s: SessionState, a: Args, on: boolean) {
    const head = await this.head(s, a);
    const own = this.own(s, 'b');
    const has = s.bookmarks().has(head);
    if (on && !has) {
      s.bookmarks.set(new Set([...s.bookmarks(), head]));
      own.add(head);
    } else if (!on) {
      if (!has) fail('invalid_args', `no bookmark on line ${head + 1}`);
      if (!own.has(head))
        fail('denied', 'this bookmark is the user’s – only bookmarks this AI set can be removed');
      const next = new Set(s.bookmarks());
      next.delete(head);
      s.bookmarks.set(next);
      own.delete(head);
    }
    return { tab_id: s.id, line: head + 1, bookmark: on };
  }

  private async setNote(s: SessionState, a: Args, on: boolean) {
    const head = await this.head(s, a);
    const own = this.own(s, 'n');
    if (on) {
      const text = str(a, 'text', L.noteCharsMax);
      if (s.notes().has(head) && !own.has(head)) {
        fail('denied', `line ${head + 1} has a note of the user – choose another line or ask`);
      }
      this.sessions.setNote(s, head, NOTE_PREFIX + text.replace(/^KI:\s*/, ''));
      own.add(head);
      return { tab_id: s.id, line: head + 1, note: true };
    }
    if (!s.notes().has(head)) fail('invalid_args', `no note on line ${head + 1}`);
    if (!own.has(head))
      fail('denied', 'this note is the user’s – only notes this AI wrote can be removed');
    this.sessions.setNote(s, head, '');
    own.delete(head);
    return { tab_id: s.id, line: head + 1, note: false };
  }

  private async setFrozen(s: SessionState, a: Args) {
    const on = bool(a, 'on');
    if (s.frozen() !== on) {
      if (!s.canFreeze()) fail('busy', 'the file is still loading – try again in a moment');
      await this.sessions.toggleFreeze(s);
      await waitFor(() => s.frozen() === on, 3000);
    }
    return { tab_id: s.id, frozen: s.frozen() };
  }

  private setFollow(s: SessionState, a: Args) {
    const on = bool(a, 'on');
    s.setFollow(on);
    return { tab_id: s.id, following: s.follow() };
  }

  private setColumnMode(s: SessionState, a: Args) {
    const mode = oneOf(a, 'mode', ['columns', 'raw'] as const);
    this.sessions.activate(s.id);
    if (this.settings.settings().columnMode !== mode)
      this.actions.run('TOGGLE_COLUMNS' as ActionId);
    return { tab_id: s.id, mode: this.settings.settings().columnMode };
  }

  private runAction(a: Args) {
    const id = str(a, 'id', 64);
    if (!(MCP_ACTIONS as readonly string[]).includes(id)) {
      fail('denied', `${id} is not available to an AI – see list_actions`);
    }
    const front = this.sessions.active();
    if (front && this.host.isHidden(front)) {
      fail('denied', 'the tab in front is hidden from AI – use activate_tab first');
    }
    const ran = this.actions.run(id as ActionId);
    if (!ran) fail('busy', `${id} cannot run right now (no tab, or a dialog is open)`);
    return { id, ran: true };
  }

  // ---------------------------------------------------------------- proposals

  /** Shows a proposal and waits for the user: `confirmed`, `cancelled`, or `timeout` after 5 minutes. */
  private ask(p: Omit<McpProposal, 'answer'>): Promise<'confirmed' | 'cancelled' | 'timeout'> {
    if (this.host.proposal())
      fail('busy', 'another proposal is waiting for the user – wait for it');
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined = undefined;
      const finish = (outcome: 'confirmed' | 'cancelled' | 'timeout') => {
        clearTimeout(timer);
        if (this.host.proposal()?.answer === answer) this.host.proposal.set(null);
        resolve(outcome);
      };
      const answer = (yes: boolean) => finish(yes ? 'confirmed' : 'cancelled');
      timer = setTimeout(() => {
        if (this.host.proposal()?.answer !== answer) return;
        finish('timeout');
        this.sessions.showNotice('Vorschlag der KI verfallen (5 Minuten ohne Antwort)');
      }, L.proposalWaitMs);
      this.host.proposal.set({ ...p, answer });
    });
  }

  private async proposeOpen(a: Args) {
    const raw = a['paths'];
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > L.openPathsMax) {
      fail('invalid_args', `paths must list 1 to ${L.openPathsMax} absolute paths`);
    }
    const paths = raw.map((p) => str({ p }, 'p', 4096));
    for (const p of paths) checkOpenPath(p);
    const merge = bool(a, 'merge') && paths.length > 1;
    const outcome = await this.ask({
      kind: 'open',
      title: merge
        ? 'Die KI möchte diese Dateien zusammengeführt öffnen'
        : 'Die KI möchte diese Dateien öffnen',
      details: paths,
      note: 'Die KI kann danach den Inhalt lesen.',
    });
    if (outcome !== 'confirmed') return { outcome };
    const before = new Set(this.sessions.sessions().map((s) => s.id));
    const errors: string[] = [];
    if (merge) {
      const e = await this.sessions.openMerged(paths.map((path) => ({ path })));
      if (e) errors.push(e.message);
    } else {
      for (const p of paths) {
        const e = await this.sessions.tryOpen(p);
        if (e) errors.push(`${p}: ${e.message}`);
      }
    }
    const opened = this.sessions
      .sessions()
      .filter((s) => !before.has(s.id))
      .map((s) => ({ tab_id: s.id, title: s.tabLabel() }));
    return { outcome: 'confirmed', opened, ...(errors.length ? { errors } : {}) };
  }

  private async proposeExport(s: SessionState, a: Args) {
    const scope = oneOf(a, 'scope', ['view', 'file', 'lines'] as const);
    const format = oneOf<ExportFormat>(a, 'format', ['txt', 'csv', 'jsonl']);
    const path = str(a, 'path', 4096);
    let range: ExportRange;
    let what: string;
    if (scope === 'lines') {
      const first = reqInt(a, 'first_line', { min: 1, max: MAX_LINE });
      const last = reqInt(a, 'last_line', { min: first, max: MAX_LINE });
      range = { kind: 'selection', first: first - 1, last: last - 1 };
      what = `Zeilen ${first}–${last}`;
    } else {
      range = { kind: scope === 'view' ? 'view' : 'all' };
      what = scope === 'view' ? 'die Ansicht des Tabs' : 'alle Zeilen der Datei';
    }
    // Without asking only to a new file: an existing one could be a config or a script (review 022 #4).
    const exists = await this.api
      .probePaths([path])
      .then((r) => r[0]?.exists !== false)
      .catch(() => true);
    const outcome =
      this.settings.settings().mcp.skipConfirm && !exists
        ? 'confirmed'
        : await this.ask({
            kind: 'export',
            title: 'Die KI möchte exportieren',
            details: [
              `Tab: ${s.tabLabel()}`,
              `Umfang: ${what}`,
              `Format: ${format.toUpperCase()}`,
              `Ziel: ${path}`,
            ],
            note: 'Eine vorhandene Datei am Ziel wird ersetzt.',
          });
    if (outcome !== 'confirmed') return { outcome };
    const error = await this.exporter.start(s, range, format, null, path);
    if (error) fail('invalid_export', error);
    return {
      outcome: 'confirmed',
      tab_id: s.id,
      path,
      note: 'the export runs as a job; the status bar shows it',
    };
  }

  private async proposeFieldRule(s: SessionState, a: Args) {
    const rule = this.ruleArg(a, `ai-${Date.now().toString(36)}`);
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(rule.name))
      fail('invalid_args', 'name must match [a-z][a-z0-9_]{0,39}');
    const preview = await this.previewRule(s, a);
    const examples = preview.results.slice(0, 5).map((r) => `Zeile ${r.line}: ${r.value}`);
    const outcome = await this.ask({
      kind: 'field_rule',
      title: 'Die KI schlägt ein neues Feld vor',
      details: [
        `Name: ${rule.name}`,
        `Aus Spalte: ${rule.column}`,
        `Muster: ${rule.pattern}`,
        `Art: ${rule.kind}${rule.unit ? ` (${rule.unit})` : ''}`,
      ],
      note: `Trifft ${preview.matched} von ${preview.tried} Zeilen.${examples.length ? '\n' + examples.join('\n') : ''}`,
    });
    if (outcome !== 'confirmed') return { outcome };
    const error = await this.sessions.setExtractRules(s, [...this.sessions.rulesOf(s), rule]);
    if (error) fail(error.code, error.message);
    return { outcome: 'confirmed', tab_id: s.id, column: rule.name };
  }
}
