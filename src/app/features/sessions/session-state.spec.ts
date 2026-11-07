import { describe, expect, it } from 'vitest';
import { LogApi } from '../../core/log/log-api';
import { LogLine, SessionUpdate } from '../../core/log/log.models';
import { SessionState } from './session-state';

const line = (n: number): LogLine => ({
  line: n,
  level: 'ERROR',
  text: `line ${n}`,
  isContinuation: false,
  truncated: false,
  matches: [],
});

const update = (filteredLines: number, change: Partial<SessionUpdate> = {}): SessionUpdate =>
  ({
    totalLines: filteredLines,
    filteredLines,
    counts: { UNKNOWN: 0, TRACE: 0, DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0, FATAL: 0 },
    status: { kind: 'live' },
    fileSize: filteredLines * 10,
    epoch: 0,
    viewGeneration: 0,
    filterPending: false,
    filterProgress: 1,
    profileId: 'generic',
    encoding: 'utf8',
    ...change,
  }) as SessionUpdate;

/** A session whose lines arrive only when `respond` is called, and only up to the count at the call. */
function setup(initial: number) {
  const calls: { start: number; count: number; resolve: (lines: LogLine[]) => void }[] = [];
  const api = {
    getLines: (_id: number, _view: string, start: number, count: number) =>
      new Promise<LogLine[]>((resolve) => calls.push({ start, count, resolve })),
    getPosition: () => Promise.resolve(0),
  } as unknown as LogApi;
  const session = new SessionState(
    {
      sessionId: 1,
      path: '/a.log',
      fileName: 'a.log',
      suggestedProfileId: 'generic',
      update: update(initial),
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
  return { session, respond };
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
});
