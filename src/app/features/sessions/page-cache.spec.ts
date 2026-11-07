import { describe, expect, it } from 'vitest';
import { LogLine } from '../../core/log/log.models';
import { PAGE_SIZE, PageCache } from './page-cache';

const line = (n: number): LogLine => ({
  line: n,
  level: 'INFO',
  source: 0,
  text: `line ${n}`,
  isContinuation: false,
  truncated: false,
  matches: [],
  fields: [],
});

function deferredLoader() {
  const calls: { start: number; resolve: (lines: LogLine[]) => void }[] = [];
  const loader = (start: number) =>
    new Promise<LogLine[]>((resolve) => calls.push({ start, resolve }));
  return { calls, loader };
}

const flush = () => new Promise((r) => setTimeout(r));

describe('PageCache', () => {
  it('loads every touched page once', async () => {
    const { calls, loader } = deferredLoader();
    const cache = new PageCache(loader);
    cache.ensure(PAGE_SIZE - 1, PAGE_SIZE + 1);
    cache.ensure(PAGE_SIZE - 1, PAGE_SIZE + 1);
    expect(calls.map((c) => c.start)).toEqual([0, PAGE_SIZE]);
    calls[0].resolve([line(0)]);
    await flush();
    expect(cache.line(0)?.text).toBe('line 0');
    expect(cache.line(1)).toBeNull();
  });

  it('drops answers from before a clear', async () => {
    const { calls, loader } = deferredLoader();
    const cache = new PageCache(loader);
    cache.ensure(0, 1);
    cache.clear();
    calls[0].resolve([line(0)]);
    await flush();
    expect(cache.line(0)).toBeNull();
  });

  it('reloads the tail page after growth, not the older pages', async () => {
    let loads = 0;
    const cache = new PageCache(async (start) => {
      loads++;
      return [line(start)];
    });
    cache.ensure(0, PAGE_SIZE + 1);
    await flush();
    expect(loads).toBe(2);
    cache.invalidateTail(PAGE_SIZE + 1);
    cache.ensure(0, PAGE_SIZE + 1);
    await flush();
    expect(loads).toBe(3);
  });

  it('a load overtaken by growth is repeated', async () => {
    const { calls, loader } = deferredLoader();
    const cache = new PageCache(loader);
    cache.ensure(0, 1);
    cache.invalidateTail(1);
    calls[0].resolve([line(0)]);
    await flush();
    cache.ensure(0, 1);
    expect(calls.length).toBe(2);
    expect(cache.line(0)?.text).toBe('line 0');
  });

  it('keeps showing an outdated page until the new one is there', async () => {
    const { calls, loader } = deferredLoader();
    const cache = new PageCache(loader);
    cache.ensure(0, 1);
    calls[0].resolve([line(0)]);
    await flush();
    cache.invalidateTail(1);
    cache.ensure(0, 1);
    expect(cache.line(0)?.text).toBe('line 0');
    calls[1].resolve([{ ...line(0), text: 'new' }]);
    await flush();
    expect(cache.line(0)?.text).toBe('new');
  });

  it('every invalidation is announced, so the view asks again', () => {
    const cache = new PageCache(async () => []);
    const before = cache.revision();
    cache.invalidateTail(1);
    expect(cache.revision()).toBe(before + 1);
    cache.clear();
    expect(cache.revision()).toBe(before + 2);
  });

  it('evicts the least recently used pages', async () => {
    const cache = new PageCache(async (start) => [line(start)]);
    for (let page = 0; page < 70; page++) cache.ensure(page * PAGE_SIZE, page * PAGE_SIZE + 1);
    await flush();
    expect(cache.line(0)).toBeNull();
    expect(cache.line(69 * PAGE_SIZE)).not.toBeNull();
  });

  it('lists the held lines in position order, at most as many as asked', async () => {
    const { calls, loader } = deferredLoader();
    const cache = new PageCache(loader);
    cache.ensure(PAGE_SIZE, PAGE_SIZE + 1);
    cache.ensure(0, 1);
    calls[1].resolve([line(0), line(1)]);
    calls[0].resolve([line(PAGE_SIZE)]);
    await flush();
    expect(cache.loadedLines(10).map((l) => l.line)).toEqual([0, 1, PAGE_SIZE]);
    expect(cache.loadedLines(2).map((l) => l.line)).toEqual([0, 1]);
  });
});
