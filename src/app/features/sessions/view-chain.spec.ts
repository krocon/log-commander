import { describe, expect, it } from 'vitest';
import { ALL_LEVELS } from './filter-logic';
import { addNode, condNode, emptyTree, ROOT_ID } from './filter-tree';
import {
  MAX_VIEWS,
  chainParts,
  fullChain,
  inheritOnClose,
  insertIndex,
  ownLabel,
  shortChain,
  viewLimitReason,
} from './view-chain';

const noQuery = { text: '', isRegex: false, caseSensitive: false };
const own = (change: Partial<Parameters<typeof ownLabel>[0]> = {}) => ({
  levels: ALL_LEVELS,
  query: noQuery,
  mode: 'filter' as const,
  sourceMask: 0xffff,
  tree: null,
  ...change,
});

describe('view chain (prompt 013)', () => {
  it('names what a tab filters by itself', () => {
    expect(ownLabel(own())).toBe('');
    expect(ownLabel(own({ levels: new Set(['ERROR']) }))).toBe('ERROR');
    expect(ownLabel(own({ query: { ...noQuery, text: 'Order' } }))).toBe('Order');
    expect(ownLabel(own({ query: { ...noQuery, text: 'a.c', isRegex: true } }))).toBe('/a.c/');
    // A highlighting search only marks: it is no step of the chain.
    expect(ownLabel(own({ query: { ...noQuery, text: 'x' }, mode: 'highlight' }))).toBe('');
    const tree = addNode(
      emptyTree(),
      ROOT_ID,
      condNode({ type: 'text', text: '4711', isRegex: false, caseSensitive: false }),
    );
    expect(ownLabel(own({ tree }))).toBe('„4711“');
    expect(ownLabel(own({ sourceMask: 0b10 }), ['a', 'b', 'c'])).toBe('b');
  });

  it('shortens long chains and cuts long steps, the title keeps all', () => {
    const parts = chainParts('app.log', ['ERROR', '', 'OrderService', '4711']);
    expect(parts).toEqual(['app.log', 'ERROR', 'OrderService', '4711']);
    expect(shortChain(parts)).toBe('…› OrderService › 4711');
    expect(shortChain(['app.log', 'ERROR'])).toBe('app.log › ERROR');
    expect(fullChain(parts)).toBe('app.log › ERROR › OrderService › 4711');
    expect(shortChain(['app.log', 'x'.repeat(40)])).toBe(`app.log › ${'x'.repeat(23)}…`);
  });

  it('allows eight tabs per file and puts a new one right of its parent', () => {
    const tabs = Array.from({ length: MAX_VIEWS }, (_, i) => ({ id: i + 1, sessionId: 1 }));
    expect(viewLimitReason(tabs, 1)).toContain('Höchstens 8');
    expect(viewLimitReason(tabs.slice(1), 1)).toBeNull();
    expect(viewLimitReason(tabs, 2)).toBeNull();
    expect(
      insertIndex(
        [
          { id: 5, sessionId: 1 },
          { id: 9, sessionId: 2 },
        ],
        5,
      ),
    ).toBe(1);
    expect(insertIndex([], 5)).toBe(0);
  });

  it('hands the steps of a closing tab to its children', () => {
    expect(
      inheritOnClose({ parentId: 1, inherited: ['A'], own: 'B' }, { inherited: ['C'] }),
    ).toEqual({ parentId: 1, inherited: ['A', 'B', 'C'] });
    expect(inheritOnClose({ parentId: null, inherited: [], own: '' }, { inherited: [] })).toEqual({
      parentId: null,
      inherited: [],
    });
  });
});
