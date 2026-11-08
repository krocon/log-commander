import { Injectable } from '@angular/core';
import { Channel } from '@tauri-apps/api/core';
import { call } from '../backend/call';
import {
  Anchor,
  ColumnSet,
  DbConfig,
  DbPreview,
  DbTable,
  EntryDetail,
  EntryRange,
  ExportFormat,
  ExportProgress,
  ExportRange,
  ExtractRule,
  FieldSuggestion,
  FieldPreview,
  FilterExpr,
  FilterInfo,
  FindHit,
  Level,
  LogLine,
  LogViewKind,
  MergeCandidate,
  MergeSourceSpec,
  Overview,
  PathProbe,
  Profile,
  ReportResult,
  ReportSchema,
  RulePreview,
  SearchMode,
  SearchQuery,
  SessionInfo,
  SessionUpdate,
  SourceConfig,
  RemoteCredentials,
  RemoteHost,
  RemoteListing,
  RemoteTarget,
  TimeHit,
  Timeline,
  ViewFilterSpec,
  ViewInfo,
  WinTarget,
} from './log.models';

@Injectable({ providedIn: 'root' })
export class LogApi {
  open(
    path: string,
    keepOnRotate: boolean,
    onUpdate: (update: SessionUpdate) => void,
  ): Promise<SessionInfo> {
    const channel = new Channel<SessionUpdate>();
    channel.onmessage = onUpdate;
    return call('open_log', { path, keepOnRotate, onUpdate: channel });
  }

  /** Several files as one tab, their entries in time order. */
  openMerged(
    sources: readonly MergeSourceSpec[],
    keepOnRotate: boolean,
    onUpdate: (update: SessionUpdate) => void,
  ): Promise<SessionInfo> {
    const channel = new Channel<SessionUpdate>();
    channel.onmessage = onUpdate;
    return call('open_merged', { sources, keepOnRotate, onUpdate: channel });
  }

  /**
   * Starts a source without a file (prompt 016, e.g. a syslog listener) and opens its spool as a tab. A port in
   * use or a refused address comes back as an error before anything runs.
   */
  openSource(
    config: SourceConfig,
    keep: boolean,
    onUpdate: (update: SessionUpdate) => void,
    credentials: RemoteCredentials | null = null,
  ): Promise<SessionInfo> {
    const channel = new Channel<SessionUpdate>();
    channel.onmessage = onUpdate;
    return call('open_source', { config, keep, credentials, onUpdate: channel });
  }

  /** Prompt 017: hosts of `~/.ssh/config` for the remote dialog. */
  remoteHosts(): Promise<RemoteHost[]> {
    return call('remote_hosts');
  }

  /** Prompt 017: a folder on the server (empty path: the home folder); connects like `openSource`. */
  remoteListDir(
    target: RemoteTarget,
    credentials: RemoteCredentials | null,
    path: string,
  ): Promise<RemoteListing> {
    return call('remote_list_dir', { target, credentials, path });
  }

  /** Prompt 017: removes the stored password and passphrase of a target from the keychain. */
  forgetRemoteSecret(target: RemoteTarget): Promise<void> {
    return call('forget_remote_secret', { target });
  }

  /** Prompt 018: Windows event logs can be read here (false on macOS and Linux). */
  wineventSupported(): Promise<boolean> {
    return call('winevent_supported');
  }

  /** Prompt 018: the event log channels of this or another computer; connects like `openSource`. */
  wineventChannels(target: WinTarget, credentials: RemoteCredentials | null): Promise<string[]> {
    return call('winevent_channels', { target, credentials });
  }

  /** Prompt 018: removes the stored password of a remote computer from the keychain. */
  forgetWineventSecret(target: WinTarget): Promise<void> {
    return call('forget_winevent_secret', { target });
  }

  /** Prompt 019: the first rows of a database query as they will be spooled; connects like `openSource`. */
  dbPreview(config: DbConfig, credentials: RemoteCredentials | null): Promise<DbPreview> {
    return call('db_preview', { config, credentials });
  }

  /** Prompt 019: tables and views of a database for „Tabelle wählen“. */
  dbTables(config: DbConfig, credentials: RemoteCredentials | null): Promise<DbTable[]> {
    return call('db_tables', { config, credentials });
  }

  /** Prompt 019: removes the stored password of a database server from the keychain. */
  forgetDbSecret(config: DbConfig): Promise<void> {
    return call('forget_db_secret', { config });
  }

  /** Keep the spool of a source when its tab closes. */
  setSpoolKeep(sessionId: number, keep: boolean): Promise<void> {
    return call('set_spool_keep', { sessionId, keep });
  }

  /** Total size of a spool in MB, for sources opened from now on. */
  setSpoolLimit(megabytes: number): Promise<void> {
    return call('set_spool_limit', { megabytes });
  }

  /** Spools kept after their tab closed: how many and their size. */
  keptSpools(): Promise<{ count: number; bytes: number }> {
    return call('kept_spools', {});
  }

  /** Deletes the kept spools; returns how many went. */
  deleteKeptSpools(): Promise<number> {
    return call('delete_kept_spools', {});
  }

  /** Profile suggestion, encoding, first and last time of a file, for the merge dialog. */
  inspectMergeSource(path: string): Promise<MergeCandidate> {
    return call('inspect_merge_source', { path });
  }

  /** Merges all files of a merge again, late lines in their place (new epoch). */
  resort(sessionId: number): Promise<void> {
    return call('resort', { sessionId });
  }

  close(sessionId: number): Promise<void> {
    return call('close_log', { sessionId });
  }

  /**
   * A filter as a tab of its own (prompt 013): a view below `parentViewId` showing its result, filtered further
   * by `filter`. Its updates come through their own channel.
   */
  openView(
    sessionId: number,
    parentViewId: number,
    filter: ViewFilterSpec,
    onUpdate: (update: SessionUpdate) => void,
  ): Promise<ViewInfo> {
    const channel = new Channel<SessionUpdate>();
    channel.onmessage = onUpdate;
    return call('open_view', {
      sessionId,
      parentViewId,
      levels: filter.levels,
      search: filter.query.text,
      isRegex: filter.query.isRegex,
      caseSensitive: filter.query.caseSensitive,
      mode: filter.mode,
      sources: filter.sources,
      expr: filter.expr,
      onUpdate: channel,
    });
  }

  /** Closes one view of a session; the views below keep their filter. The last tab uses `close`. */
  closeView(sessionId: number, viewId: number): Promise<void> {
    return call('close_view', { sessionId, viewId });
  }

  getLines(
    sessionId: number,
    view: LogViewKind,
    start: number,
    count: number,
    viewId = 0,
  ): Promise<LogLine[]> {
    return call('get_lines', { sessionId, view, start, count, viewId });
  }

  setFilter(
    sessionId: number,
    levels: readonly Level[],
    query: SearchQuery,
    mode: SearchMode,
    sources: number | null = null,
    expr: FilterExpr | null = null,
    viewId = 0,
  ): Promise<FilterInfo> {
    return call('set_filter', {
      sessionId,
      levels,
      search: query.text,
      isRegex: query.isRegex,
      caseSensitive: query.caseSensitive,
      mode,
      sources,
      expr,
      viewId,
    });
  }

  setProfile(sessionId: number, profileId: string): Promise<FilterInfo> {
    return call('set_profile', { sessionId, profileId });
  }

  getColumns(sessionId: number): Promise<ColumnSet> {
    return call('get_columns', { sessionId });
  }

  /** Tries a profile's layout on one line; the backend checks the profile first. */
  previewFields(profile: Profile, line: string): Promise<FieldPreview> {
    return call('preview_fields', { profile, line });
  }

  find(
    sessionId: number,
    fromLine: number | null,
    query: SearchQuery,
    forward: boolean,
    viewId = 0,
  ): Promise<FindHit | null> {
    return call(forward ? 'find_next' : 'find_prev', { sessionId, fromLine, query, viewId });
  }

  getPosition(sessionId: number, line: number, viewId = 0): Promise<number> {
    return call('get_position', { sessionId, line, viewId });
  }

  /** Level bits per pixel bucket of the view and where `lines` are in it (overview ruler). */
  getOverview(
    sessionId: number,
    buckets: number,
    lines: readonly number[],
    viewId = 0,
  ): Promise<Overview> {
    return call('get_overview', { sessionId, buckets, lines, viewId });
  }

  /** The timeline of the whole file (prompt 014); `from`/`to` null: the whole file. */
  getTimeline(
    sessionId: number,
    from: number | null,
    to: number | null,
    buckets: number,
  ): Promise<Timeline> {
    return call('get_timeline', { sessionId, from, to, buckets });
  }

  /** The first entry at or after `ts` (microseconds, UTC) in the view; null without times. */
  positionAtTime(sessionId: number, ts: number, viewId = 0): Promise<TimeHit | null> {
    return call('position_at_time', { sessionId, ts, viewId });
  }

  /** Next or previous entry of one of `levels`, strictly after / before `fromPosition` (null: start / end). */
  findLevel(
    sessionId: number,
    fromPosition: number | null,
    forward: boolean,
    levels: readonly Level[],
    viewId = 0,
  ): Promise<FindHit | null> {
    return call('find_level', { sessionId, fromPosition, forward, levels, viewId });
  }

  getEntryRange(sessionId: number, line: number): Promise<EntryRange> {
    return call('get_entry_range', { sessionId, line });
  }

  /** The whole entry of a line straight from the index, for the detail panel. */
  getEntry(sessionId: number, line: number): Promise<EntryDetail> {
    return call('get_entry', { sessionId, line });
  }

  /** The lines between two line numbers; `all` ignores the filter. */
  copyLines(
    sessionId: number,
    first: number,
    last: number,
    view: LogViewKind = 'filtered',
    viewId = 0,
  ): Promise<string> {
    return call('copy_lines', { sessionId, first, last, view, viewId });
  }

  /** Prompt 020: the native window frame (`#rrggbb`; `dark` null = appearance of the system); shows the window. */
  setWindowChrome(color: string, dark: boolean | null): Promise<void> {
    return call('set_window_chrome', { color, dark });
  }

  setKeepOnRotate(sessionId: number, keep: boolean): Promise<void> {
    return call('set_keep_on_rotate', { sessionId, keep });
  }

  setFrozen(sessionId: number, frozen: boolean): Promise<void> {
    return call('set_frozen', { sessionId, frozen });
  }

  listProfiles(): Promise<Profile[]> {
    return call('list_profiles');
  }

  setCustomProfiles(profiles: Profile[]): Promise<void> {
    return call('set_custom_profiles', { profiles });
  }

  /**
   * Extraction rules (prompt 011) for the profile of a session's format, right away for every open session of
   * that profile. The new columns of the session come back; an invalid rule is an `invalid_rule` with `nodeId`.
   */
  setExtractRules(sessionId: number, rules: readonly ExtractRule[]): Promise<ColumnSet> {
    return call('set_extract_rules', { sessionId, rules });
  }

  /** All rules from the settings per profile id, at start. */
  loadExtractRules(rules: Record<string, ExtractRule[]>): Promise<void> {
    return call('load_extract_rules', { rules });
  }

  /** Candidates for rules from a sample of entry heads spread over the whole file. */
  suggestFields(sessionId: number): Promise<FieldSuggestion[]> {
    return call('suggest_fields', { sessionId });
  }

  /** A rule tried on some lines (the whole line is the source); checks the rule, too. */
  previewExtractRule(rule: ExtractRule, lines: readonly string[]): Promise<RulePreview> {
    return call('preview_extract_rule', { rule, lines });
  }

  /**
   * The dashboard of a tab is shown (prompt 012): builds its database the first time and keeps it up to date
   * every 5 s while open. `fields`: column ids to store, `null` for the numbers.
   */
  openReport(sessionId: number, fields: readonly string[] | null): Promise<ReportSchema> {
    return call('open_report', { sessionId, fields });
  }

  /** The dashboard is hidden: no more catching up. */
  closeReport(sessionId: number): Promise<void> {
    return call('close_report', { sessionId });
  }

  /** One read-only SQL query; a newer one of the same `slot` (panel) stops an older one. */
  runReport(sessionId: number, sql: string, slot: string): Promise<ReportResult> {
    return call('run_report', { sessionId, sql, slot });
  }

  getReportSchema(sessionId: number): Promise<ReportSchema> {
    return call('get_report_schema', { sessionId });
  }

  // ---------------------------------------------------------------- prompt 015

  /**
   * Writes a view, the selection or all lines of the file into `targetPath` as a background job and returns its id.
   * The target is checked first (absolute, extension of the format, not the open log itself).
   */
  exportView(
    sessionId: number,
    viewId: number,
    range: ExportRange,
    format: ExportFormat,
    columns: readonly string[] | null,
    targetPath: string,
    onProgress: (progress: ExportProgress) => void,
  ): Promise<number> {
    const channel = new Channel<ExportProgress>();
    channel.onmessage = onProgress;
    return call('export_view', {
      sessionId,
      viewId,
      range,
      format,
      columns,
      targetPath,
      onProgress: channel,
    });
  }

  /** Stops an export; its temporary file is removed. False if it was over already. */
  cancelExport(jobId: number): Promise<boolean> {
    return call('cancel_export', { jobId });
  }

  /** Anchors of lines, null past the end. */
  lineAnchors(sessionId: number, lines: readonly number[]): Promise<(Anchor | null)[]> {
    return call('line_anchors', { sessionId, lines });
  }

  /** Lines of anchors in the file as it is now, null where none fits. */
  resolveAnchors(sessionId: number, anchors: readonly Anchor[]): Promise<(number | null)[]> {
    return call('resolve_anchors', { sessionId, anchors });
  }

  /** The text of a `.lcw` file (validated by the caller: it may come from someone else). */
  readWorkspace(path: string): Promise<string> {
    return call('read_workspace', { path });
  }

  writeWorkspace(path: string, content: string): Promise<void> {
    return call('write_workspace', { path, content });
  }

  /** Which files exist (absolute paths only). */
  probePaths(paths: readonly string[]): Promise<PathProbe[]> {
    return call('probe_paths', { paths });
  }
}
