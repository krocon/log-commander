import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../core/errors/app-error';
import { LogApi } from '../../core/log/log-api';
import { SessionInfo, SessionUpdate } from '../../core/log/log.models';
import { DEFAULT_SETTINGS } from '../../core/settings/settings.models';
import { SettingsService } from '../../core/settings/settings.service';
import { LogSessionService } from './log-session.service';
import { SessionState } from './session-state';

const update = {
  totalLines: 0,
  filteredLines: 0,
  counts: { UNKNOWN: 0, TRACE: 0, DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0, FATAL: 0 },
  viewCounts: { UNKNOWN: 0, TRACE: 0, DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0, FATAL: 0 },
  status: { kind: 'live' },
  fileSize: 0,
  epoch: 0,
  viewGeneration: 0,
  columnsRevision: 1,
} as unknown as SessionUpdate;

function setup(setFilter = vi.fn(() => Promise.resolve({}))) {
  const api = {
    setFilter,
    getColumns: () => new Promise(() => undefined),
  } as unknown as LogApi;
  TestBed.configureTestingModule({
    providers: [
      { provide: LogApi, useValue: api },
      { provide: SettingsService, useValue: { settings: signal(DEFAULT_SETTINGS) } },
    ],
  });
  const service = TestBed.inject(LogSessionService);
  const info: SessionInfo = {
    sessionId: 1,
    path: '/a.log',
    fileName: 'a.log',
    suggestedProfileId: 'generic',
    update,
  };
  return { service, session: new SessionState(info, api), setFilter };
}

describe('LogSessionService.applyPreset', () => {
  it('sets levels, search and mode and starts the filter exactly once', async () => {
    const { service, session, setFilter } = setup();
    const query = { text: 'timeout', isRegex: false, caseSensitive: true };
    await service.applyPreset(session, { levels: ['WARN', 'ERROR'], query, mode: 'highlight' });
    expect(setFilter).toHaveBeenCalledTimes(1);
    expect(setFilter).toHaveBeenCalledWith(1, ['WARN', 'ERROR'], query, 'highlight');
    expect([...session.levels()]).toEqual(['WARN', 'ERROR']);
    expect(session.query()).toEqual(query);
    expect(session.searchMode()).toBe('highlight');
    expect(session.presetRevision()).toBe(1);
  });

  it('shows an invalid regex of an old entry as a search error', async () => {
    const error: AppError = { code: 'invalid_search', message: 'unclosed group' };
    const { service, session } = setup(vi.fn(() => Promise.reject(error)));
    await service.applyPreset(session, {
      levels: ['ERROR'],
      query: { text: '(', isRegex: true, caseSensitive: false },
      mode: 'filter',
    });
    expect(session.searchError()).toBe('unclosed group');
    expect(service.error()).toBeNull();
  });

  it('clears the search once and counts as a preset', async () => {
    const { service, session, setFilter } = setup();
    session.query.set({ text: 'x', isRegex: true, caseSensitive: false });
    await service.clearSearch(session);
    expect(setFilter).toHaveBeenCalledTimes(1);
    expect(session.query()).toEqual({ text: '', isRegex: true, caseSensitive: false });
    expect(session.presetRevision()).toBe(1);
  });
});
