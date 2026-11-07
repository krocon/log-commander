import { describe, expect, it } from 'vitest';
import { Level, SearchQuery } from '../../core/log/log.models';
import { SavedFilter, mergeSavedFilters } from '../../core/settings/settings.models';
import { ALL_LEVELS } from '../sessions/filter-logic';
import { condNode, emptyTree } from '../sessions/filter-tree';
import {
  TreeSession,
  buildTree,
  describeLevels,
  describeQuery,
  sameFilter,
  savedFilterOf,
  suggestName,
  treeKey,
  upsertSavedFilter,
} from './tree-model';

const noQuery: SearchQuery = { text: '', isRegex: false, caseSensitive: false };

const session = (id: number, change: Partial<TreeSession> = {}): TreeSession => ({
  id,
  fileName: `f${id}.log`,
  path: `/var/log/f${id}.log`,
  levels: ALL_LEVELS,
  query: noQuery,
  mode: 'filter',
  ...change,
});

const saved = (id: string, name: string, levels: Level[] = ['ERROR']): SavedFilter => ({
  id,
  name,
  levels,
  query: noQuery,
  mode: 'filter',
  version: 2,
  tree: emptyTree(),
});

describe('tree model', () => {
  it('is empty without sessions and saved filters', () => {
    expect(buildTree([], null, [], new Set())).toEqual([]);
  });

  it('lists files in tab order, without children while nothing is filtered', () => {
    const nodes = buildTree([session(2), session(1)], 1, [], new Set());
    expect(nodes.map((n) => n.id)).toEqual(['file:2', 'file:1']);
    expect(nodes.map((n) => n.current)).toEqual([false, true]);
    expect(nodes[0]).toMatchObject({ level: 1, expandable: false, posInSet: 1, setSize: 2 });
  });

  it('shows the active filter of each file with levels and search', () => {
    const levels = new Set<Level>(['WARN', 'ERROR', 'FATAL']);
    const query = { text: 'timeout', isRegex: false, caseSensitive: false };
    const nodes = buildTree([session(1, { levels, query })], 1, [], new Set());
    expect(nodes.map((n) => [n.id, n.level, n.label])).toEqual([
      ['file:1', 1, 'f1.log'],
      ['filter:1', 2, 'Aktiver Filter'],
      ['levels:1', 3, 'WARN, ERROR, FATAL'],
      ['query:1', 3, '„timeout“'],
    ]);
    expect(nodes[0]).toMatchObject({ expandable: true, expanded: true });
    expect(nodes[3]).toMatchObject({ parentId: 'filter:1', posInSet: 2, setSize: 2 });
  });

  it('hides children of collapsed nodes', () => {
    const levels = new Set<Level>(['ERROR']);
    const sessions = [session(1, { levels })];
    expect(buildTree(sessions, 1, [], new Set(['file:1'])).map((n) => n.id)).toEqual(['file:1']);
    expect(buildTree(sessions, 1, [], new Set(['filter:1'])).map((n) => n.id)).toEqual([
      'file:1',
      'filter:1',
    ]);
  });

  it('sorts saved filters by name and marks the one the active tab uses', () => {
    const list = [
      saved('b', 'Timeouts', ['WARN']),
      saved('a', 'nur Fehler'),
      saved('c', 'Alle 10', ['INFO']),
    ];
    const nodes = buildTree(
      [session(1, { levels: new Set<Level>(['ERROR']) })],
      1,
      list,
      new Set(),
    );
    const savedNodes = nodes.filter((n) => n.kind === 'saved');
    expect(savedNodes.map((n) => n.label)).toEqual(['Alle 10', 'nur Fehler', 'Timeouts']);
    expect(savedNodes.map((n) => n.current)).toEqual([false, true, false]);
    expect(nodes.find((n) => n.id === 'saved')).toMatchObject({
      level: 1,
      posInSet: 2,
      setSize: 2,
    });
    expect(buildTree([], null, list, new Set(['saved'])).map((n) => n.id)).toEqual(['saved']);
  });

  it('describes levels and searches', () => {
    expect(describeLevels(new Set<Level>(['FATAL', 'UNKNOWN', 'WARN']))).toBe(
      'WARN, FATAL, Ohne Level',
    );
    expect(describeLevels(new Set())).toBe('Keine Level');
    expect(describeQuery({ text: 'a.c', isRegex: true, caseSensitive: true }, 'highlight')).toBe(
      '/a.c/ · Regex, Aa · hervorheben',
    );
    expect(suggestName(new Set<Level>(['ERROR']), { ...noQuery, text: 'x' })).toBe('ERROR · „x“');
    expect(suggestName(ALL_LEVELS, noQuery)).toBe('Filter');
  });

  it('replaces a saved filter of the same name and keeps its id', () => {
    const list = [saved('a', 'Fehler')];
    const next = upsertSavedFilter(list, saved('z', ' fehler ', ['FATAL']));
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: 'a', levels: ['FATAL'] });
    expect(upsertSavedFilter(list, saved('z', 'Andere'))).toHaveLength(2);
  });

  it('serialises a saved filter with levels as an array and reads it back', () => {
    const query = { text: 'time(out)?', isRegex: true, caseSensitive: false };
    const entry = savedFilterOf(
      'x1',
      ' Timeouts ',
      new Set<Level>(['FATAL', 'WARN']),
      query,
      'filter',
    );
    expect(entry.levels).toEqual(['WARN', 'FATAL']);
    const roundTrip = mergeSavedFilters(JSON.parse(JSON.stringify([entry])));
    expect(roundTrip).toEqual([{ ...entry, name: 'Timeouts' }]);
    expect(sameFilter(roundTrip[0], new Set<Level>(['WARN', 'FATAL']), query, 'filter')).toBe(true);
    expect(sameFilter(roundTrip[0], new Set<Level>(['WARN']), query, 'filter')).toBe(false);
  });

  it('moves the focus with the arrow keys like a WAI-ARIA tree', () => {
    const nodes = buildTree(
      [session(1, { levels: new Set<Level>(['ERROR']) }), session(2)],
      1,
      [],
      new Set(),
    );
    // file:1, filter:1, levels:1, file:2
    expect(treeKey(nodes, 'file:1', 'ArrowDown')).toEqual({ focus: 'filter:1' });
    expect(treeKey(nodes, 'file:2', 'ArrowDown')).toEqual({ focus: 'file:2' });
    expect(treeKey(nodes, 'file:1', 'ArrowUp')).toEqual({ focus: 'file:1' });
    expect(treeKey(nodes, 'levels:1', 'Home')).toEqual({ focus: 'file:1' });
    expect(treeKey(nodes, 'file:1', 'End')).toEqual({ focus: 'file:2' });
    expect(treeKey(nodes, 'file:1', 'ArrowRight')).toEqual({ focus: 'filter:1' });
    expect(treeKey(nodes, 'file:1', 'ArrowLeft')).toEqual({ collapse: 'file:1' });
    expect(treeKey(nodes, 'levels:1', 'ArrowLeft')).toEqual({ focus: 'filter:1' });
    expect(treeKey(nodes, 'file:2', 'ArrowLeft')).toEqual({});
    const closed = buildTree(
      [session(1, { levels: new Set<Level>(['ERROR']) })],
      1,
      [],
      new Set(['file:1']),
    );
    expect(treeKey(closed, 'file:1', 'ArrowRight')).toEqual({ expand: 'file:1' });
    expect(treeKey(nodes, 'file:1', 'x')).toBeNull();
  });
});

describe('tree model with a filter tree (prompt 010)', () => {
  const text = (t: string) => ({
    type: 'text' as const,
    text: t,
    isRegex: false,
    caseSensitive: false,
  });

  it('shows the conditions under the active filter, the joining word as text, errors at their node', () => {
    const a = condNode(text('a'));
    const b = { ...condNode(text('b')), negate: true, enabled: false };
    const tree = { ...emptyTree(), op: 'or' as const, children: [a, b] };
    const nodes = buildTree(
      [session(1, { tree, treeError: { nodeId: b.id, message: 'regex parse error' } })],
      1,
      [],
      new Set(),
    );
    const root = nodes.find((n) => n.id === 'expr:1:root');
    expect(root).toMatchObject({ kind: 'expr-group', level: 3, op: 'or', parentId: 'filter:1' });
    const [first, second] = nodes.filter((n) => n.kind === 'expr-cond');
    expect(first).toMatchObject({ label: '„a“', level: 4, joiner: undefined, enabled: true });
    expect(second).toMatchObject({
      label: '„b“',
      joiner: 'ODER',
      negate: true,
      enabled: false,
      error: 'regex parse error',
      posInSet: 2,
      setSize: 2,
    });
    expect(second.title).toBe('ODER NICHT „b“ (aus, verneint)');
    // Collapsed root: no children.
    const closed = buildTree([session(1, { tree })], 1, [], new Set(['expr:1:root']));
    expect(closed.some((n) => n.kind === 'expr-cond')).toBe(false);
  });

  it('saves the tree and recognises it as the current filter', () => {
    const tree = { ...emptyTree(), children: [condNode(text('req-42'))] };
    const entry = savedFilterOf('x', 'Req', ALL_LEVELS, noQuery, 'filter', tree);
    expect(entry.version).toBe(2);
    expect(entry.tree).not.toBe(tree);
    expect(sameFilter(entry, ALL_LEVELS, noQuery, 'filter', tree)).toBe(true);
    expect(sameFilter(entry, ALL_LEVELS, noQuery, 'filter', emptyTree())).toBe(false);
    expect(suggestName(ALL_LEVELS, noQuery, tree)).toBe('„req-42“');
  });

  it('hangs filter tabs below the tab they filter, the chain as sub nodes (prompt 013)', () => {
    const levels = new Set<Level>(['ERROR']);
    const nodes = buildTree(
      [
        session(1, { levels }),
        session(1 << 30, { parentId: 1, viewId: 1, label: 'f1.log › ERROR › Alle', levels }),
        session((1 << 30) + 1, { parentId: 1 << 30, viewId: 2, label: '…› „x“' }),
        session(2),
      ],
      (1 << 30) + 1,
      [],
      new Set(),
    );
    expect(nodes.map((n) => [n.id, n.level, n.parentId])).toEqual([
      ['file:1', 1, null],
      ['filter:1', 2, 'file:1'],
      ['levels:1', 3, 'filter:1'],
      [`view:${1 << 30}`, 2, 'file:1'],
      [`filter:${1 << 30}`, 3, `view:${1 << 30}`],
      [`levels:${1 << 30}`, 4, `filter:${1 << 30}`],
      [`view:${(1 << 30) + 1}`, 3, `view:${1 << 30}`],
      ['file:2', 1, null],
    ]);
    expect(nodes[3]).toMatchObject({ kind: 'view', posInSet: 2, setSize: 2, expandable: true });
    expect(nodes[6]).toMatchObject({ current: true, label: '…› „x“' });
    expect(nodes[7]).toMatchObject({ posInSet: 2, setSize: 2 });
    // A filter tab whose parents closed stands on its own.
    const alone = buildTree(
      [session(5, { parentId: null, viewId: 3, label: 'f5.log › ERROR' })],
      null,
      [],
      new Set(),
    );
    expect(alone.map((n) => [n.id, n.label])).toEqual([['file:5', 'f5.log › ERROR']]);
  });
});
