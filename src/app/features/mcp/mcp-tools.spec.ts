import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { LogApi } from '../../core/log/log-api';
import { LogLine, SessionInfo, SessionUpdate } from '../../core/log/log.models';
import { McpApi } from '../../core/mcp/mcp-api';
import { DEFAULT_SETTINGS } from '../../core/settings/settings.models';
import { SettingsService } from '../../core/settings/settings.service';
import { ActionService } from '../../core/actions/action.service';
import { LogSessionService } from '../sessions/log-session.service';
import { SessionState } from '../sessions/session-state';
import { McpService } from './mcp.service';

const counts = { UNKNOWN: 0, TRACE: 0, DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0, FATAL: 0 };
const update = {
  totalLines: 100,
  filteredLines: 100,
  counts,
  viewCounts: counts,
  status: { kind: 'live' },
  fileSize: 4000,
  epoch: 3,
  viewGeneration: 1,
  columnsRevision: 1,
  frozen: false,
  profileId: 'generic',
  encoding: 'utf-8',
} as unknown as SessionUpdate;

const line = (n: number, text = `line ${n}`): LogLine => ({
  line: n,
  level: 'INFO',
  source: 0,
  text,
  isContinuation: false,
  truncated: false,
  matches: [],
  fields: [],
});

const ON = { ...DEFAULT_SETTINGS, mcp: { ...DEFAULT_SETTINGS.mcp, enabled: true } };

function setup(settings = ON) {
  const reply = vi.fn((...args: unknown[]) => Promise.resolve(void args));
  const api = {
    getColumns: () => new Promise(() => undefined),
    getLines: vi.fn((_id: number, _view: string, start: number, count: number) =>
      Promise.resolve(
        Array.from({ length: Math.min(count, 100 - start) }, (_, i) =>
          line(start + i, start + i === 41 ? 'login password=hunter2' : undefined),
        ),
      ),
    ),
    getPosition: vi.fn((_id: number, l: number) => Promise.resolve(l)),
    getEntryRange: vi.fn((_id: number, l: number) => Promise.resolve({ first: l, last: l })),
    probePaths: (paths: string[]) =>
      Promise.resolve(paths.map((path) => ({ path, exists: false }))),
  } as unknown as LogApi;
  const actions = { run: vi.fn(() => true), hint: () => '' };
  TestBed.configureTestingModule({
    providers: [
      { provide: LogApi, useValue: api },
      { provide: McpApi, useValue: { reply } },
      { provide: ActionService, useValue: actions },
      { provide: SettingsService, useValue: { settings: signal(settings), loaded: signal(true) } },
    ],
  });
  const sessions = TestBed.inject(LogSessionService);
  const mcp = TestBed.inject(McpService);
  const info: SessionInfo = {
    sessionId: 1,
    path: '/var/log/app.log',
    fileName: 'app.log',
    suggestedProfileId: 'generic',
    update,
    sources: [],
  };
  const tab = new SessionState(info, api);
  const other = new SessionState({ ...info, sessionId: 2, fileName: 'secret.log' }, api);
  sessions.sessions.set([tab, other]);
  sessions.activate(1);
  /** Runs a tool like the bridge does and returns what went back. */
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    await mcp.run(7, tool, args);
    const [, result, error] = reply.mock.calls.at(-1) as [number, unknown, { code: string } | null];
    return { result: result as Record<string, unknown>, error };
  };
  return { mcp, sessions, tab, other, api, actions, call };
}

describe('McpTools', () => {
  it('lists the tabs and leaves out hidden ones', async () => {
    const { call, other, mcp } = setup();
    let r = await call('get_workspace');
    expect((r.result['tabs'] as unknown[]).length).toBe(2);
    other.aiHidden.set(true);
    r = await call('get_workspace');
    expect((r.result['tabs'] as { title: string }[]).map((t) => t.title)).toEqual(['app.log']);
    expect((await call('get_tab', { tab_id: 2 })).error?.code).toBe('tab_not_found');
    expect(mcp.history()[0]).toMatchObject({ tool: 'get_tab', result: 'tab_not_found' });
  });

  it('reads lines 1-based from the end, masks secrets and checks the epoch', async () => {
    const { call } = setup();
    const r = await call('read_lines', { start: 40, count: 3 });
    const lines = r.result['lines'] as {
      line: number;
      pos: number;
      text: string;
      masked?: number;
    }[];
    expect(lines.map((l) => l.line)).toEqual([40, 41, 42]);
    expect(lines[2]).toMatchObject({ text: 'login password=«masked»', masked: 1 });
    expect(r.result['epoch']).toBe(3);
    const end = await call('read_lines', { count: 2 });
    expect((end.result['lines'] as { line: number }[]).map((l) => l.line)).toEqual([99, 100]);
    expect((await call('read_lines', { epoch: 2 })).error?.code).toBe('stale_view');
    expect((await call('read_lines', { count: 501 })).error?.code).toBe('invalid_args');
  });

  it('leaves the text as it is when masking is off', async () => {
    const { call } = setup({ ...ON, mcp: { ...ON.mcp, maskSecrets: false } });
    const r = await call('read_lines', { around_line: 42, count: 1 });
    expect((r.result['lines'] as { text: string }[])[0].text).toBe('login password=hunter2');
  });

  it('writes notes as KI and only removes its own marks', async () => {
    const { call, tab } = setup();
    tab.notes.set(new Map([[9, 'mine']]));
    await call('add_note', { line: 5, text: 'Timeout beginnt hier' });
    expect(tab.notes().get(4)).toBe('KI: Timeout beginnt hier');
    expect((await call('add_note', { line: 10, text: 'x' })).error?.code).toBe('denied');
    expect((await call('remove_note', { line: 10 })).error?.code).toBe('denied');
    expect((await call('remove_note', { line: 5 })).error).toBeNull();
    expect(tab.notes().has(4)).toBe(false);
    tab.bookmarks.set(new Set([1]));
    expect((await call('remove_bookmark', { line: 2 })).error?.code).toBe('denied');
    await call('set_bookmark', { line: 3 });
    expect([...tab.bookmarks()].sort()).toEqual([1, 2]);
  });

  it('closes only its own filter tabs and runs only listed actions', async () => {
    const { call, actions } = setup();
    expect((await call('close_tab', { tab_id: 1 })).error?.code).toBe('denied');
    expect((await call('run_action', { id: 'OPEN_FILE' })).error?.code).toBe('denied');
    expect((await call('run_action', { id: 'NEXT_ERROR' })).error).toBeNull();
    expect(actions.run).toHaveBeenCalledWith('NEXT_ERROR');
  });

  it('asks before opening a file and reports a refusal', async () => {
    const { call, mcp, sessions } = setup();
    const open = vi.spyOn(sessions, 'tryOpen');
    const pending = call('propose_open', { paths: ['/home/me/.ssh/id_ed25519'] });
    await vi.waitFor(() => expect(mcp.proposal()).not.toBeNull());
    expect(mcp.proposal()!.details).toEqual(['/home/me/.ssh/id_ed25519']);
    expect(
      (await call('propose_export', { scope: 'view', format: 'csv', path: '/tmp/x.csv' })).error
        ?.code,
    ).toBe('busy');
    mcp.proposal()!.answer(false);
    const r = await pending;
    expect(r.result).toEqual({ outcome: 'cancelled' });
    expect(open).not.toHaveBeenCalled();
    expect(mcp.proposal()).toBeNull();
    expect((await call('propose_open', { paths: ['relative.log'] })).error?.code).toBe(
      'invalid_args',
    );
  });

  it('refuses every call while AI control is off', async () => {
    const { call } = setup(DEFAULT_SETTINGS);
    expect((await call('get_workspace')).error?.code).toBe('not_running');
  });

  it('keeps a filter tab hidden when its hidden parent closes (review 022)', async () => {
    const { call, mcp, tab, api, sessions } = setup();
    const child = new SessionState(tab.info, api, {
      tabId: 50,
      viewId: 1,
      parent: tab,
      update,
    });
    sessions.sessions.set([tab, child]);
    mcp.toggleHidden(tab);
    expect(child.aiHidden()).toBe(true);
    child.parent.set(null);
    sessions.sessions.set([child]);
    expect(mcp.isHidden(child)).toBe(true);
    expect((await call('get_tab', { tab_id: 50 })).error?.code).toBe('tab_not_found');
  });

  it('refuses paths that hide where they lead', async () => {
    const { call } = setup();
    for (const path of [
      '/var/log/../../Users/me/.aws/credentials',
      '//host/share/x.log',
      '\\\\host\\share\\x.log',
      '/var/log/app\u202e.log',
    ]) {
      expect((await call('propose_open', { paths: [path] })).error?.code, path).toBe(
        'invalid_args',
      );
    }
  });

  it('forgets an own bookmark the user removed meanwhile', async () => {
    const { call, tab } = setup();
    await call('set_bookmark', { line: 3 });
    tab.bookmarks.set(new Set());
    TestBed.tick();
    tab.bookmarks.set(new Set([2]));
    TestBed.tick();
    expect((await call('remove_bookmark', { line: 3 })).error?.code).toBe('denied');
  });

  it('refuses a filter tree with unusable conditions', async () => {
    const { call } = setup();
    const r = await call('open_filter_tab', {
      tree: { kind: 'group', op: 'and', children: [{ kind: 'cond', cond: { type: 'nope' } }] },
    });
    expect(r.error?.code).toBe('invalid_filter');
  });
});
