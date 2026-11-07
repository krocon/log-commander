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
    sources: [],
  };
  return { service, session: new SessionState(info, api), setFilter };
}

describe('LogSessionService.applyPreset', () => {
  it('sets levels, search and mode and starts the filter exactly once', async () => {
    const { service, session, setFilter } = setup();
    const query = { text: 'timeout', isRegex: false, caseSensitive: true };
    await service.applyPreset(session, { levels: ['WARN', 'ERROR'], query, mode: 'highlight' });
    expect(setFilter).toHaveBeenCalledTimes(1);
    expect(setFilter).toHaveBeenCalledWith(1, ['WARN', 'ERROR'], query, 'highlight', null);
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

describe('LogSessionService.openMerged', () => {
  function mergeSetup() {
    const openMerged = vi.fn((sources: { path: string }[]) =>
      Promise.resolve({
        sessionId: 7,
        path: '',
        fileName: 'a.log + b.log',
        suggestedProfileId: 'generic',
        update: { ...update, sources: [] },
        sources: sources.map((s, index) => ({
          index,
          path: s.path,
          fileName: s.path.slice(1),
          profileId: 'generic',
          encoding: 'utf8',
        })),
      } as SessionInfo),
    );
    const addRecentFile = vi.fn();
    const setFilter = vi.fn(() => Promise.resolve({}));
    const api = {
      openMerged,
      setFilter,
      getColumns: () => new Promise(() => undefined),
    } as unknown as LogApi;
    TestBed.configureTestingModule({
      providers: [
        { provide: LogApi, useValue: api },
        {
          provide: SettingsService,
          useValue: { settings: signal(DEFAULT_SETTINGS), addRecentFile },
        },
      ],
    });
    return { service: TestBed.inject(LogSessionService), openMerged, addRecentFile, setFilter };
  }

  it('opens a tab titled after the file count, not in the recent files', async () => {
    const { service, openMerged, addRecentFile } = mergeSetup();
    expect(await service.openMerged([{ path: '/a.log' }, { path: '/b.log' }])).toBeNull();
    expect(openMerged).toHaveBeenCalledTimes(1);
    const tab = service.active()!;
    expect(tab.isMerge).toBe(true);
    expect(tab.fileName).toBe('Merge (2 Dateien)');
    expect(tab.title).toBe('/a.log\n/b.log');
    expect(addRecentFile).not.toHaveBeenCalled();
  });

  it('activates the merge of the same files in any order instead of opening it again', async () => {
    const { service, openMerged } = mergeSetup();
    await service.openMerged([{ path: '/a.log' }, { path: '/b.log' }]);
    service.activate(null);
    await service.openMerged([{ path: '/b.log' }, { path: '/a.log', profileId: 'log4j' }]);
    expect(openMerged).toHaveBeenCalledTimes(1);
    expect(service.activeId()).toBe(7);
    await service.openMerged([{ path: '/a.log' }, { path: '/c.log' }]);
    expect(openMerged).toHaveBeenCalledTimes(2);
  });

  it('sends the source filter with the levels and the search', async () => {
    const { service, setFilter } = mergeSetup();
    await service.openMerged([{ path: '/a.log' }, { path: '/b.log' }]);
    const tab = service.active()!;
    await service.setSources(tab, 0b10);
    expect(setFilter).toHaveBeenLastCalledWith(7, expect.any(Array), tab.query(), 'filter', 0b10);
  });
});
