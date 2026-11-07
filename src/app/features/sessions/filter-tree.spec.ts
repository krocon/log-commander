import { describe, expect, it } from 'vitest';
import { FilterCond } from '../../core/log/log.models';
import {
  FilterGroupNode,
  ROOT_ID,
  addNode,
  compileTree,
  condNode,
  countConditions,
  describeCond,
  describeTree,
  emptyTree,
  findNode,
  groupNode,
  moveNode,
  moveNodeTo,
  removeNode,
  sameTree,
  sanitizeTree,
  toggleEnabled,
  toggleNegate,
  toggleOp,
} from './filter-tree';

const text = (t: string): FilterCond => ({
  type: 'text',
  text: t,
  isRegex: false,
  caseSensitive: false,
});

/** root(AND): a, group(OR: b, c) */
function sample() {
  const a = condNode(text('a'));
  const b = condNode(text('b'));
  const c = condNode(text('c'));
  const g = groupNode('or', [b, c]);
  const tree = addNode(addNode(emptyTree(), ROOT_ID, a), ROOT_ID, g);
  return { tree, a, b, c, g };
}

const ids = (tree: FilterGroupNode) =>
  tree.children.map((n) => (n.kind === 'group' ? [n.id, n.children.map((c) => c.id)] : n.id));

describe('filter-tree', () => {
  it('compiles to the shape the backend takes', () => {
    const { tree, a, b, c, g } = sample();
    expect(compileTree(tree)).toEqual({
      kind: 'group',
      id: ROOT_ID,
      op: 'and',
      negate: false,
      children: [
        { kind: 'cond', id: a.id, negate: false, cond: text('a') },
        {
          kind: 'group',
          id: g.id,
          op: 'or',
          negate: false,
          children: [
            { kind: 'cond', id: b.id, negate: false, cond: text('b') },
            { kind: 'cond', id: c.id, negate: false, cond: text('c') },
          ],
        },
      ],
    });
    expect(countConditions(tree)).toBe(3);
  });

  it('drops switched off nodes and empty groups, nothing left is null', () => {
    const { tree, a, b, c, g } = sample();
    expect(compileTree(emptyTree())).toBeNull();
    const off = toggleEnabled(toggleEnabled(tree, b.id), c.id);
    // The group has nothing left that is on: it is gone, a stays.
    expect(compileTree(off)).toMatchObject({ children: [{ id: a.id }] });
    expect(countConditions(off)).toBe(1);
    const groupOff = toggleEnabled(tree, g.id);
    expect(countConditions(groupOff)).toBe(1);
    expect(compileTree(toggleEnabled(groupOff, a.id))).toBeNull();
    expect(compileTree(addNode(emptyTree(), ROOT_ID, groupNode()))).toBeNull();
  });

  it('adds, removes and changes without touching the old tree', () => {
    const { tree, a, b, g } = sample();
    const before = JSON.stringify(tree);
    const d = condNode(text('d'));
    const added = addNode(tree, g.id, d, 0);
    expect(ids(added)).toEqual([a.id, [g.id, [d.id, b.id, expect.any(String)]]]);
    expect(findNode(added, d.id)).toBe(d);
    expect(ids(removeNode(added, g.id))).toEqual([a.id]);
    expect(removeNode(added, ROOT_ID).children).toEqual([]);
    expect(toggleOp(tree, g.id).children[1]).toMatchObject({ op: 'and' });
    expect(toggleNegate(tree, a.id).children[0]).toMatchObject({ negate: true });
    // An unknown parent means the top.
    expect(addNode(tree, 'nope', d).children.at(-1)).toBe(d);
    expect(JSON.stringify(tree)).toBe(before);
  });

  it('moves among siblings and by dragging, not into itself', () => {
    const { tree, a, b, c, g } = sample();
    expect(ids(moveNode(tree, a.id, 1))).toEqual([[g.id, [b.id, c.id]], a.id]);
    expect(moveNode(tree, a.id, -1)).toBe(tree);
    expect(ids(moveNodeTo(tree, a.id, g.id, 1))).toEqual([[g.id, [b.id, a.id, c.id]]]);
    expect(ids(moveNodeTo(tree, c.id, g.id, 0))).toEqual([a.id, [g.id, [c.id, b.id]]]);
    // Down within the same group: the index counts before the node is taken out.
    expect(ids(moveNodeTo(tree, b.id, g.id, 2))).toEqual([a.id, [g.id, [c.id, b.id]]]);
    expect(moveNodeTo(tree, g.id, g.id, 0)).toBe(tree);
    expect(moveNodeTo(tree, ROOT_ID, g.id, 0)).toBe(tree);
  });

  it('compares by what the backend gets', () => {
    const { tree, b } = sample();
    expect(sameTree(tree, structuredClone(tree))).toBe(true);
    expect(sameTree(tree, toggleEnabled(tree, b.id))).toBe(false);
    expect(sameTree(emptyTree(), null)).toBe(true);
  });

  it('describes conditions in German, lines from 1', () => {
    expect(describeCond(text('x'))).toBe('„x“');
    expect(describeCond({ type: 'text', text: 'a.c', isRegex: true, caseSensitive: true })).toBe(
      '/a.c/ Aa',
    );
    expect(describeCond({ type: 'level', levels: ['ERROR', 'WARN'] })).toBe('Level WARN, ERROR');
    expect(
      describeCond({ type: 'field', column: 'thread', op: 'eq', value: 'main' }, (id) =>
        id === 'thread' ? 'Thread' : id,
      ),
    ).toBe('Thread = main');
    expect(
      describeCond({ type: 'field', column: 'ms', op: 'between', value: '1', value2: '5' }),
    ).toBe('ms zwischen 1 und 5');
    expect(describeCond({ type: 'time', from: '10:00', to: null })).toBe('Zeit ab 10:00');
    expect(
      describeCond({
        type: 'range',
        start: { text: 'BEGIN', isRegex: false, caseSensitive: false },
        end: null,
        inclusive: true,
      }),
    ).toBe('Abschnitt „BEGIN“ bis Ende');
    expect(describeCond({ type: 'lines', first: 9, last: null })).toBe('ab Zeile 10');
    expect(describeCond({ type: 'lines', first: 0, last: 4 })).toBe('Zeilen 1–5');
    const { tree, b } = sample();
    expect(describeTree(toggleNegate(tree, b.id))).toBe('„a“ UND (NICHT „b“ ODER „c“)');
  });

  it('repairs a stored tree', () => {
    expect(sanitizeTree(null)).toEqual(emptyTree());
    expect(sanitizeTree({ kind: 'cond' })).toEqual(emptyTree());
    let deep: unknown = { kind: 'cond', id: 'leaf', cond: text('x') };
    for (let i = 0; i < 20; i++) deep = { kind: 'group', id: `g${i}`, op: 'and', children: [deep] };
    expect(countConditions(sanitizeTree(deep))).toBe(0);
    const many = {
      kind: 'group',
      id: 'whatever',
      op: 'or',
      children: Array.from({ length: 70 }, (_, i) => ({
        kind: 'cond',
        id: `c${i}`,
        cond: text(`w${i}`),
      })),
    };
    const repaired = sanitizeTree(many);
    expect(repaired.id).toBe(ROOT_ID);
    expect(repaired.op).toBe('or');
    expect(countConditions(repaired)).toBe(64);
  });
});
