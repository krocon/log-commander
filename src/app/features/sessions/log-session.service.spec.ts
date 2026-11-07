import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../core/errors/app-error';
import { LogApi } from '../../core/log/log-api';
import { FilterExpr, SessionInfo, SessionUpdate } from '../../core/log/log.models';
import { DEFAULT_SETTINGS } from '../../core/settings/settings.models';
import { SettingsService } from '../../core/settings/settings.service';
import { LogSessionService, TREE_DEBOUNCE_MS } from './log-session.service';
import { SessionState } from './session-state';
import { ALL_LEVELS } from './filter-logic';

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
    expect(setFilter).toHaveBeenCalledWith(1, ['WARN', 'ERROR'], query, 'highlight', null, null, 0);
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
    expect(setFilter).toHaveBeenLastCalledWith(
      7,
      expect.any(Array),
      tab.query(),
      'filter',
      0b10,
      null,
      0,
    );
  });
});

describe('LogSessionService full log and back (prompt 007)', () => {
  it('lifts levels and the filtering search in one call, keeps the filter and goes back', async () => {
    const setFilter = vi.fn(() => Promise.resolve({ viewGeneration: 5, pending: false }));
    const { service, session } = setup(setFilter);
    const query = { text: 'timeout', isRegex: false, caseSensitive: false };
    await service.applyPreset(session, { levels: ['ERROR'], query, mode: 'filter' });
    setFilter.mockClear();
    session.selection.set({ anchor: 12, first: 12, last: 14 });

    await service.toggleFullLog(session);
    expect(setFilter).toHaveBeenCalledTimes(1);
    expect(setFilter).toHaveBeenLastCalledWith(
      1,
      [...ALL_LEVELS],
      query,
      'highlight',
      null,
      null,
      0,
    );
    expect(session.keptFilter()?.mode).toBe('filter');
    expect(session.pendingReveal).toBe(12);
    expect(session.selection()?.anchor).toBe(12);
    expect(session.filterActive()).toBe(false);

    await service.toggleFullLog(session);
    expect(setFilter).toHaveBeenLastCalledWith(1, ['ERROR'], query, 'filter', null, null, 0);
    expect(session.keptFilter()).toBeNull();
    expect(session.selection()?.anchor).toBe(12);
  });

  it('forgets the kept filter when the user changes the filter', async () => {
    const { service, session } = setup(vi.fn(() => Promise.resolve({ viewGeneration: 1 })));
    await service.setLevels(session, new Set(['WARN']));
    session.selection.set({ anchor: 3, first: 3, last: 3 });
    await service.revealInFullLog(session);
    expect(session.keptFilter()).not.toBeNull();
    await service.setLevels(session, new Set(['INFO']));
    expect(session.keptFilter()).toBeNull();
  });

  it('needs a selection and an active filter', async () => {
    const setFilter = vi.fn(() => Promise.resolve({}));
    const { service, session } = setup(setFilter);
    await service.revealInFullLog(session);
    expect(session.findMessage()).toBe('Keine Zeile gewählt');
    session.selection.set({ anchor: 3, first: 3, last: 3 });
    await service.revealInFullLog(session);
    expect(session.findMessage()).toBe('Kein Filter aktiv');
    expect(setFilter).not.toHaveBeenCalled();
  });

  it('toggles a bookmark on the head of the selected entry', () => {
    const { service, session } = setup();
    session.selection.set({ anchor: 8, first: 8, last: 11 });
    service.toggleBookmark(session);
    expect([...session.bookmarks()]).toEqual([8]);
    service.toggleBookmark(session);
    expect(session.bookmarks().size).toBe(0);
  });
});

/** The expression of the last (or n-th) `setFilter` call. */
const exprOf = (setFilter: { mock: { calls: unknown[][] } }, call = -1): FilterExpr | null =>
  setFilter.mock.calls.at(call)?.[5] as FilterExpr | null;

describe('LogSessionService filter tree (prompt 010)', () => {
  it('bundles changes in a row into one filter job with the expression', async () => {
    vi.useFakeTimers();
    try {
      const { service, session, setFilter } = setup();
      service.filterOnText(session, 'req-42\nsecond line');
      service.filterOnText(session, 'timeout', true);
      expect(setFilter).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(TREE_DEBOUNCE_MS);
      expect(setFilter).toHaveBeenCalledTimes(1);
      const expr = exprOf(setFilter, 0);
      expect(expr).toMatchObject({
        kind: 'group',
        children: [
          { negate: false, cond: { type: 'text', text: 'req-42' } },
          { negate: true, cond: { type: 'text', text: 'timeout' } },
        ],
      });
      expect(session.filterActive()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('puts an error that names a node at the tree, not at the search field', async () => {
    const error: AppError = { code: 'invalid_search', message: 'bad regex', nodeId: 'n1' };
    const { service, session } = setup(vi.fn(() => Promise.reject(error)));
    await service.setLevels(session, ALL_LEVELS);
    expect(session.treeError()).toEqual({ nodeId: 'n1', message: 'bad regex' });
    expect(session.searchError()).toBeNull();
  });

  it('sections from the selection use its first and last line', async () => {
    vi.useFakeTimers();
    try {
      const { service, session, setFilter } = setup();
      service.filterSection(session, 'from');
      expect(service.error()).toBeNull();
      session.selection.set({ anchor: 10, first: 10, last: 14 });
      service.filterSection(session, 'from');
      service.filterSection(session, 'to');
      await vi.advanceTimersByTimeAsync(TREE_DEBOUNCE_MS);
      const expr = exprOf(setFilter);
      expect(expr).toMatchObject({
        children: [
          { cond: { type: 'lines', first: 10, last: null } },
          { cond: { type: 'lines', first: null, last: 14 } },
        ],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('G lifts the tree too and brings it back', async () => {
    const { service, session, setFilter } = setup();
    service.filterOnText(session, 'x');
    session.selection.set({ anchor: 3, first: 3, last: 3 });
    await service.toggleFullLog(session);
    expect(exprOf(setFilter)).toBeNull();
    expect(session.filterTree().children.length).toBe(0);
    await service.toggleFullLog(session);
    expect(exprOf(setFilter)).toMatchObject({ children: [{ cond: { text: 'x' } }] });
  });
});

describe('LogSessionService and the dashboard (prompt 012)', () => {
  function withLines(position: number, lineThere: number) {
    const setFilter = vi.fn(() => Promise.resolve({ viewGeneration: 1, pending: false }));
    const ctx = setup(setFilter);
    const api = TestBed.inject(LogApi) as unknown as Record<string, unknown>;
    api['getPosition'] = vi.fn(() => Promise.resolve(position));
    api['getLines'] = vi.fn(() => Promise.resolve([{ line: lineThere }]));
    return ctx;
  }

  it('a line from the dashboard: back to the log, scrolled there, the selection stays', async () => {
    const { service, session } = withLines(7, 41);
    session.mode.set('dashboard');
    session.selection.set({ anchor: 3, first: 3, last: 3 });
    await service.showLine(session, 41);
    expect(session.mode()).toBe('log');
    expect(session.jumpMark?.position).toBe(7);
    expect(session.selection()?.anchor).toBe(3);
    expect(session.revealHint).toBeNull();
    expect(session.findMessage()).toBe('Zeile 42');
  });

  it('a filtered line: next visible one, G shows the line itself in the whole log', async () => {
    const { service, session, setFilter } = withLines(7, 50);
    session.levels.set(new Set(['ERROR']));
    await service.showLine(session, 41);
    expect(session.findMessage()).toContain('ausgefiltert');
    expect(session.revealHint?.line).toBe(41);
    await service.toggleFullLog(session);
    expect(setFilter).toHaveBeenCalledTimes(1);
    expect(session.keptFilter()).not.toBeNull();
    expect(session.revealHint).toBeNull();
  });

  it('a bar of a level opens a filter tab on that level, an unknown column does nothing', async () => {
    const { service, session, setFilter } = setup();
    const openView = vi.fn(() => Promise.resolve({ viewId: 1, parentViewId: 0, update }));
    (TestBed.inject(LogApi) as unknown as Record<string, unknown>)['openView'] = openView;
    service.sessions.set([session]);
    session.mode.set('dashboard');
    expect(await service.filterFromDashboard(session, { sql: 'level', log: null }, 'WARN')).toBe(
      true,
    );
    // Prompt 013: the dashboard's tab stays as it is, the drill-down is a tab of its own.
    expect([...session.levels()]).toEqual([...ALL_LEVELS]);
    expect(session.mode()).toBe('dashboard');
    expect(setFilter).not.toHaveBeenCalled();
    expect(openView).toHaveBeenCalledWith(
      1,
      0,
      expect.objectContaining({ levels: ['WARN'] }),
      expect.any(Function),
    );
    const tab = service.active()!;
    expect(tab.viewId).toBe(1);
    expect(tab.tabLabel()).toBe('a.log › WARN');
    expect(await service.filterFromDashboard(session, { sql: 'n', log: null }, 'x')).toBe(false);
  });
});

describe('LogSessionService filter tabs (prompt 013)', () => {
  function tabsSetup() {
    const ctx = setup();
    const api = TestBed.inject(LogApi) as unknown as Record<string, unknown>;
    let next = 0;
    const channels: ((u: SessionUpdate) => void)[] = [];
    const openView = vi.fn(
      (_s: number, parent: number, _f: unknown, onUpdate: (u: SessionUpdate) => void) => {
        channels.push(onUpdate);
        return Promise.resolve({ viewId: ++next, parentViewId: parent, update });
      },
    );
    const closeView = vi.fn(() => Promise.resolve());
    const close = vi.fn(() => Promise.resolve());
    Object.assign(api, { openView, closeView, close });
    ctx.service.sessions.set([ctx.session]);
    return { ...ctx, openView, closeView, close, channels };
  }

  it('opens a tab right of its parent that filters further, named after the chain', async () => {
    const { service, session, openView, setFilter } = tabsSetup();
    session.levels.set(new Set(['ERROR']));
    const child = (await service.openFilterTab(session, {
      cond: { type: 'text', text: '4711', isRegex: false, caseSensitive: false },
    }))!;
    expect(openView).toHaveBeenCalledWith(
      1,
      0,
      expect.objectContaining({ levels: expect.any(Array), mode: 'filter' }),
      expect.any(Function),
    );
    expect(child.sessionId).toBe(1);
    expect(child.viewId).toBe(1);
    expect(child.id).not.toBe(session.id);
    expect(child.parent()).toBe(session);
    expect(child.tabLabel()).toBe('a.log › ERROR › „4711“');
    expect(child.tabTitle()).toContain('a.log › ERROR › „4711“');
    expect(service.active()).toBe(child);
    // A filter of the child goes to its view.
    await service.setLevels(child, new Set(['WARN']));
    expect(setFilter).toHaveBeenLastCalledWith(
      1,
      ['WARN'],
      expect.anything(),
      'filter',
      null,
      expect.anything(),
      1,
    );
    // A second filter tab of the file goes right of its own parent, before the first one.
    const sibling = (await service.openFilterTab(session))!;
    expect(service.sessions().map((s) => s.id)).toEqual([session.id, sibling.id, child.id]);
    expect(sibling.tabLabel()).toBe('a.log › ERROR › Alle');
    // Bookmarks are the file's.
    expect(child.bookmarks).toBe(session.bookmarks);
  });

  it('routes the updates of each view to its tab', async () => {
    const { service, session, channels } = tabsSetup();
    const child = (await service.openFilterTab(session))!;
    channels[0]({ ...update, filteredLines: 42, totalLines: 100 });
    expect(child.filteredLines()).toBe(42);
    expect(session.filteredLines()).toBe(0);
  });

  it('closing a parent keeps the chain of its children; the last tab closes the file', async () => {
    const { service, session, closeView, close } = tabsSetup();
    session.levels.set(new Set(['ERROR']));
    const child = (await service.openFilterTab(session))!;
    child.query.set({ text: 'Order', isRegex: false, caseSensitive: false });
    const grandchild = (await service.openFilterTab(child, {
      cond: { type: 'text', text: '4711', isRegex: false, caseSensitive: false },
    }))!;
    expect(grandchild.tabLabel()).toBe('…› Order › „4711“');
    expect(grandchild.tabTitle()).toContain('a.log › ERROR › Order › „4711“');

    await service.close(child.id);
    expect(closeView).toHaveBeenLastCalledWith(1, 1);
    expect(grandchild.parent()).toBe(session);
    expect(grandchild.tabLabel()).toBe('…› Order › „4711“');
    expect(grandchild.tabTitle()).toContain('a.log › ERROR › Order › „4711“');

    await service.close(session.id);
    expect(closeView).toHaveBeenLastCalledWith(1, 0);
    expect(grandchild.parent()).toBeNull();
    expect(grandchild.tabTitle()).toContain('a.log › ERROR › Order › „4711“');
    expect(close).not.toHaveBeenCalled();

    await service.close(grandchild.id);
    expect(close).toHaveBeenCalledWith(1);
    expect(service.sessions()).toEqual([]);
  });

  it('refuses a ninth tab of a file and says why', async () => {
    const { service, session, openView } = tabsSetup();
    for (let i = 0; i < 7; i++) await service.openFilterTab(session);
    expect(service.sessions()).toHaveLength(8);
    expect(service.filterTabLimit(session)).toContain('Höchstens 8');
    expect(await service.openFilterTab(session)).toBeNull();
    expect(openView).toHaveBeenCalledTimes(7);
    expect(service.error()).toContain('Höchstens 8');
  });

  it('opening the file again lands on its own tab', async () => {
    const { service, session } = tabsSetup();
    const child = (await service.openFilterTab(session))!;
    expect(service.active()).toBe(child);
    expect(await service.tryOpen('/a.log')).toBeNull();
    expect(service.active()).toBe(session);
  });

  it('marks new errors of the view in a filter tab in the background', async () => {
    const { service, session, channels } = tabsSetup();
    const child = (await service.openFilterTab(session))!;
    service.activate(session.id);
    const counts = { ...update.counts, ERROR: 3 };
    channels[0]({ ...update, counts, viewCounts: update.viewCounts });
    expect(child.hasNewErrors()).toBe(false);
    channels[0]({ ...update, counts, viewCounts: counts });
    expect(child.hasNewErrors()).toBe(true);
  });
});
