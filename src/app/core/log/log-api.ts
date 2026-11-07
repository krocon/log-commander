import { Injectable } from '@angular/core';
import { Channel } from '@tauri-apps/api/core';
import { call } from '../backend/call';
import {
  ColumnSet,
  EntryRange,
  FieldPreview,
  FilterInfo,
  FindHit,
  Level,
  LogLine,
  LogViewKind,
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
  ): Promise<FilterInfo> {
    return call('set_filter', {
      sessionId,
      levels,
      search: query.text,
      isRegex: query.isRegex,
      caseSensitive: query.caseSensitive,
      mode,
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

  getEntryRange(sessionId: number, line: number): Promise<EntryRange> {
    return call('get_entry_range', { sessionId, line });
  }

  copyLines(sessionId: number, first: number, last: number): Promise<string> {
    return call('copy_lines', { sessionId, first, last });
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
