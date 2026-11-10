import { describe, expect, it } from 'vitest';
import { LogApi } from '../../core/log/log-api';
import { ColumnSet, LogLine, SessionUpdate } from '../../core/log/log.models';
import { SessionState } from './session-state';

const line = (n: number): LogLine => ({
  line: n,
  level: 'ERROR',
  source: 0,
  text: `line ${n}`,
  isContinuation: false,
  truncated: false,
  matches: [],
  fields: [],
});

const update = (filteredLines: number, change: Partial<SessionUpdate> = {}): SessionUpdate =>
  ({
    totalLines: filteredLines,
    filteredLines,
    counts: { UNKNOWN: 0, TRACE: 0, DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0, FATAL: 0 },
    viewCounts: { UNKNOWN: 0, TRACE: 0, DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0, FATAL: 0 },
    status: { kind: 'live' },
    fileSize: filteredLines * 10,
    epoch: 0,
    viewGeneration: 0,
    columnsRevision: 1,
    filterPending: false,
    filterProgress: 1,
    profileId: 'generic',
    encoding: 'utf8',
    ...change,
  }) as SessionUpdate;

const columnSet = (revision: number): ColumnSet => ({
  revision,
  confidence: 1,
  profileId: 'log4j',
  inferredLayout: null,
  columns: [{ id: 'message', label: 'Nachricht', kind: 'text' }],
});

/** A session whose lines arrive only when `respond` is called, and only up to the count at the call. */
function setup(initial: number) {
  const calls: { start: number; count: number; resolve: (lines: LogLine[]) => void }[] = [];
  const api = {
    getLines: (_id: number, _view: string, start: number, count: number) =>
      new Promise<LogLine[]>((resolve) => calls.push({ start, count, resolve })),
    getPosition: () => Promise.resolve(0),
    getColumns: () => Promise.resolve(columnSet(1)),
  } as unknown as LogApi;
  const session = new SessionState(
    {
      sessionId: 1,
      path: '/a.log',
      fileName: 'a.log',
      suggestedProfileId: 'generic',
      update: update(initial),
      sources: [],
    },
    api,
  );
  session.visibleRows.set(10);
  const ensure = () => {
    const { start, end } = session.wantedRange();
    session.cache.ensure(start, end);
  };
  const respond = async (upTo: number) => {
    ensure();
    for (const call of calls.splice(0)) {
      const end = Math.min(call.start + call.count, upTo);
      call.resolve(
        Array.from({ length: Math.max(0, end - call.start) }, (_, i) => line(call.start + i)),
      );
    }
    await new Promise((r) => setTimeout(r));
    // The view reads this on every render; the signal remembers the last value it was read with.
    session.displayedLines();
  };
  return { session, respond, calls, ensure };
}

describe('SessionState.displayedLines', () => {
  it('holds a growing tail until its lines arrived, every drawn row has its text', async () => {
    const { session, respond } = setup(50);
    await respond(50);
    expect(session.displayedLines()).toBe(50);

    session.applyUpdate(update(55));
    expect(session.filteredLines()).toBe(55);
    expect(session.displayedLines()).toBe(50);

    await respond(55);
    expect(session.displayedLines()).toBe(55);
    expect(session.cache.line(54)?.text).toBe('line 54');
  });

  it('crosses a page without a gap', async () => {
    const { session, respond } = setup(195);
    await respond(195);
    session.applyUpdate(update(205));
    expect(session.displayedLines()).toBe(195);
    await respond(205);
    expect(session.displayedLines()).toBe(205);
  });

  it('moves on although each load is overtaken by the next update', async () => {
    const { session, respond } = setup(50);
    await respond(50);
    session.applyUpdate(update(60));
    session.applyUpdate(update(70));
    await respond(60);
    expect(session.displayedLines()).toBe(60);
    session.applyUpdate(update(80));
    await respond(80);
    expect(session.displayedLines()).toBe(80);
  });

  it('counts the badge from the real number while it waits', async () => {
    const { session, respond } = setup(50);
    await respond(50);
    session.setFollow(false);
    session.scroll.set({ top: 45, subPx: 0 });
    session.applyUpdate(update(55));
    expect(session.newLines()).toBe(5);
    expect(session.displayedLines()).toBe(50);
  });

  it('does not wait for lines far below a reader', async () => {
    const { session, respond } = setup(500);
    await respond(500);
    session.setFollow(false);
    session.scroll.set({ top: 0, subPx: 0 });
    session.applyUpdate(update(600));
    expect(session.displayedLines()).toBe(600);
  });

  it('shrinks at once when a provisional line is taken back', async () => {
    const { session, respond } = setup(50);
    await respond(50);
    session.applyUpdate(update(49));
    expect(session.displayedLines()).toBe(49);
  });

  it('starts over with another view or a new epoch', async () => {
    const { session, respond } = setup(50);
    await respond(50);
    session.applyUpdate(update(5, { viewGeneration: 1 }));
    expect(session.displayedLines()).toBe(5);
    session.applyUpdate(update(90, { viewGeneration: 2 }));
    expect(session.displayedLines()).toBe(90);
    session.applyUpdate(update(3, { epoch: 1, viewGeneration: 2 }));
    expect(session.displayedLines()).toBe(3);
  });

  it('loads the columns at the start and again when their revision changes', async () => {
    const requested: number[] = [];
    let revision = 1;
    const api = {
      getLines: () => Promise.resolve([]),
      getPosition: () => Promise.resolve(0),
      getColumns: () => {
        requested.push(revision);
        return Promise.resolve(columnSet(revision));
      },
    } as unknown as LogApi;
    const session = new SessionState(
      {
        sessionId: 1,
        path: '/a.log',
        fileName: 'a.log',
        suggestedProfileId: 'generic',
        update: update(0),
        sources: [],
      },
      api,
    );
    await Promise.resolve();
    expect(session.columns()?.revision).toBe(1);
    // Same revision: nothing to load.
    session.applyUpdate(update(5));
    expect(requested).toEqual([1]);
    revision = 2;
    session.applyUpdate(update(5, { columnsRevision: 2, viewGeneration: 1 }));
    await Promise.resolve();
    expect(requested).toEqual([1, 2]);
    expect(session.columns()?.revision).toBe(2);
  });
});

describe('SessionState navigation (prompt 007)', () => {
  function make(getPosition: (line: number) => Promise<number>) {
    const api = {
      getLines: () => new Promise(() => undefined),
      getPosition: (_id: number, line: number) => getPosition(line),
      getColumns: () => Promise.resolve(columnSet(1)),
    } as unknown as LogApi;
    return new SessionState(
      {
        sessionId: 1,
        path: '/a.log',
        fileName: 'a.log',
        suggestedProfileId: 'generic',
        update: update(100),
        sources: [],
      },
      api,
    );
  }
  const tick = () => new Promise((r) => setTimeout(r));

  it('clears bookmarks, the pending reveal and the jump with a new epoch', () => {
    const session = make(() => Promise.resolve(0));
    session.bookmarks.set(new Set([3, 7]));
    session.pendingReveal = 7;
    session.jumpTo(20, 7);
    session.applyUpdate(update(100, { epoch: 1 }));
    expect(session.bookmarks().size).toBe(0);
    expect(session.pendingReveal).toBeNull();
    expect(session.jumpMark).toBeNull();
  });

  it('settling the scroll position (clamped to the bottom) keeps the jump going on from its target', () => {
    const session = make(() => Promise.resolve(0));
    session.jumpTo(95, 95);
    session.settleScroll({ top: 70, subPx: 4 });
    expect(session.scroll()).toEqual({ top: 70, subPx: 4 });
    expect(session.follow()).toBe(false);
    expect(session.jumpMark?.position).toBe(95);
    expect(session.jumpMark?.scroll).toBe(session.scroll());
    // Scrolled by the reader in between: the jump is over, settling does not bring it back.
    session.scroll.set({ top: 10, subPx: 0 });
    session.settleScroll({ top: 12, subPx: 0 });
    expect(session.jumpMark?.scroll).not.toBe(session.scroll());
  });

  it('keeps bookmarks when only the view changes', () => {
    const session = make(() => Promise.resolve(0));
    session.bookmarks.set(new Set([3]));
    session.applyUpdate(update(10, { viewGeneration: 1 }));
    expect([...session.bookmarks()]).toEqual([3]);
  });

  it('scrolls to the pending line only once the new view is there', async () => {
    const asked: number[] = [];
    const session = make((line) => {
      asked.push(line);
      return Promise.resolve(line * 2);
    });
    session.setFollow(false);
    session.pendingReveal = 40;
    // Same view (a tail update): nothing yet, positions would be those of the old view.
    session.applyUpdate(update(101));
    await tick();
    expect(asked).toEqual([]);
    // The identity comes as a new view generation too.
    session.applyUpdate(update(500, { viewGeneration: 1 }));
    await tick();
    expect(asked).toEqual([40]);
    expect(session.scroll()).toEqual({ top: 75, subPx: 0 });
    expect(session.pendingReveal).toBeNull();
    expect(session.jumpMark?.line).toBe(40);
    expect(session.follow()).toBe(false);
  });

  it('lets a scroll of the user overtake the pending reveal', async () => {
    let answer: (position: number) => void = () => undefined;
    const session = make(() => new Promise<number>((resolve) => (answer = resolve)));
    session.setFollow(false);
    session.pendingReveal = 40;
    session.applyUpdate(update(500, { viewGeneration: 1 }));
    session.scroll.set({ top: 3, subPx: 0 });
    answer(80);
    await tick();
    expect(session.scroll()).toEqual({ top: 3, subPx: 0 });
  });
});

describe('SessionState with a filter expression (prompt 010)', () => {
  it('reads the end again from where lines were taken out, although the count is the same', async () => {
    const { session, respond, calls } = setup(250);
    await respond(250);
    session.cache.ensure(200, 250);
    expect(calls.length).toBe(0);
    // Same count and size, but from position 205 on other lines: the page 200–399 again.
    session.applyUpdate(update(250, { retractedFrom: 205 }));
    session.cache.ensure(200, 250);
    expect(calls.map((c) => c.start)).toEqual([200]);
    // Meanwhile the old text stays visible.
    expect(session.cache.line(210)?.text).toBe('line 210');
  });

  it('re-applies the filter when the columns change and the tree has field conditions', () => {
    const { session } = setup(10);
    let applied = 0;
    session.onColumnsChanged = () => applied++;
    session.applyUpdate(update(10, { columnsRevision: 2 }));
    expect(applied).toBe(0);
    session.filterTree.set({
      kind: 'group',
      id: 'root',
      op: 'and',
      negate: false,
      enabled: true,
      children: [
        {
          kind: 'cond',
          id: 'f',
          negate: false,
          enabled: true,
          cond: { type: 'field', column: 'thread', op: 'eq', value: 'main' },
        },
      ],
    });
    session.applyUpdate(update(10, { columnsRevision: 3 }));
    expect(applied).toBe(1);
    expect(session.filterActive()).toBe(true);
  });
});
