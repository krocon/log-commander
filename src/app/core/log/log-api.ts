import { Injectable } from '@angular/core';
import { Channel } from '@tauri-apps/api/core';
import { call } from '../backend/call';
import {
  ColumnSet,
  EntryDetail,
  EntryRange,
  FieldPreview,
  FilterInfo,
  FindHit,
  Level,
  LogLine,
  LogViewKind,
  MergeCandidate,
  MergeSourceSpec,
  Overview,
  Profile,
  SearchMode,
  SearchQuery,
  SessionInfo,
  SessionUpdate,
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

  getLines(sessionId: number, view: LogViewKind, start: number, count: number): Promise<LogLine[]> {
    return call('get_lines', { sessionId, view, start, count });
  }

  setFilter(
    sessionId: number,
    levels: readonly Level[],
    query: SearchQuery,
    mode: SearchMode,
    sources: number | null = null,
  ): Promise<FilterInfo> {
    return call('set_filter', {
      sessionId,
      levels,
      search: query.text,
      isRegex: query.isRegex,
      caseSensitive: query.caseSensitive,
      mode,
      sources,
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
  ): Promise<FindHit | null> {
    return call(forward ? 'find_next' : 'find_prev', { sessionId, fromLine, query });
  }

  getPosition(sessionId: number, line: number): Promise<number> {
    return call('get_position', { sessionId, line });
  }

  /** Level bits per pixel bucket of the view and where `lines` are in it (overview ruler). */
  getOverview(sessionId: number, buckets: number, lines: readonly number[]): Promise<Overview> {
    return call('get_overview', { sessionId, buckets, lines });
  }

  /** Next or previous entry of one of `levels`, strictly after / before `fromPosition` (null: start / end). */
  findLevel(
    sessionId: number,
    fromPosition: number | null,
    forward: boolean,
    levels: readonly Level[],
  ): Promise<FindHit | null> {
    return call('find_level', { sessionId, fromPosition, forward, levels });
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
  ): Promise<string> {
    return call('copy_lines', { sessionId, first, last, view });
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
}
