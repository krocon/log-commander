/**
 * The filter tree of a tab (prompt 010) as pure functions: nodes with a stable id, on/off and an optional
 * label; groups combine their children with AND or OR. `compileTree` makes the `FilterExpr` the backend
 * evaluates per entry; disabled nodes and empty groups drop out. Levels and search of the toolbar stay
 * separate, they are an implicit AND above the tree.
 */
import {
  FieldOp,
  FilterCond,
  FilterCondType,
  FilterExpr,
  LEVELS,
  Level,
  SearchQuery,
} from '../../core/log/log.models';
import { describeLevels } from './filter-logic';

export interface FilterGroupNode {
  kind: 'group';
  id: string;
  op: 'and' | 'or';
  negate: boolean;
  enabled: boolean;
  label?: string;
  children: FilterNode[];
}

export interface FilterCondNode {
  kind: 'cond';
  id: string;
  negate: boolean;
  enabled: boolean;
  label?: string;
  cond: FilterCond;
}

export type FilterNode = FilterGroupNode | FilterCondNode;

export const ROOT_ID = 'root';
/** As in the backend (`filter_expr.rs`). */
export const MAX_CONDITIONS = 64;
export const MAX_DEPTH = 16;

export function emptyTree(): FilterGroupNode {
  return { kind: 'group', id: ROOT_ID, op: 'and', negate: false, enabled: true, children: [] };
}

let counter = 0;

/** Ids only have to be unique within a tree; random so saved trees from earlier runs do not collide. */
export function newNodeId(): string {
  counter = (counter + 1) % 1e6;
  return `n${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function condNode(cond: FilterCond, negate = false): FilterCondNode {
  return { kind: 'cond', id: newNodeId(), negate, enabled: true, cond };
}

export function groupNode(op: 'and' | 'or' = 'and', children: FilterNode[] = []): FilterGroupNode {
  return { kind: 'group', id: newNodeId(), op, negate: false, enabled: true, children };
}

export function findNode(tree: FilterGroupNode, id: string): FilterNode | null {
  if (tree.id === id) return tree;
  for (const child of tree.children) {
    if (child.id === id) return child;
    if (child.kind === 'group') {
      const hit = findNode(child, id);
      if (hit) return hit;
    }
  }
  return null;
}

export function parentOf(tree: FilterGroupNode, id: string): FilterGroupNode | null {
  for (const child of tree.children) {
    if (child.id === id) return tree;
    if (child.kind === 'group') {
      const hit = parentOf(child, id);
      if (hit) return hit;
    }
  }
  return null;
}

/** Applies `change` to the node `id`; `null` removes it. Everything else stays the same object. */
function mapNode(
  tree: FilterGroupNode,
  id: string,
  change: (node: FilterNode) => FilterNode | null,
): FilterGroupNode {
  if (tree.id === id) return (change(tree) as FilterGroupNode | null) ?? emptyTree();
  let changed = false;
  const children: FilterNode[] = [];
  for (const child of tree.children) {
    let next: FilterNode | null = child;
    if (child.id === id) next = change(child);
    else if (child.kind === 'group') next = mapNode(child, id, change);
    if (next !== child) changed = true;
    if (next) children.push(next);
  }
  return changed ? { ...tree, children } : tree;
}

/** Adds `node` to the group `parentId` (at `index`, default the end); an unknown parent means the root. */
export function addNode(
  tree: FilterGroupNode,
  parentId: string,
  node: FilterNode,
  index?: number,
): FilterGroupNode {
  const parent = findNode(tree, parentId);
  const target = parent?.kind === 'group' ? parent.id : tree.id;
  return mapNode(tree, target, (group) => {
    const g = group as FilterGroupNode;
    const children = [...g.children];
    children.splice(index ?? children.length, 0, node);
    return { ...g, children };
  });
}

export function removeNode(tree: FilterGroupNode, id: string): FilterGroupNode {
  if (id === tree.id) return { ...tree, children: [] };
  return mapNode(tree, id, () => null);
}

export function updateNode(
  tree: FilterGroupNode,
  id: string,
  change: (node: FilterNode) => FilterNode,
): FilterGroupNode {
  return mapNode(tree, id, change);
}

export function toggleEnabled(tree: FilterGroupNode, id: string): FilterGroupNode {
  return mapNode(tree, id, (n) => ({ ...n, enabled: !n.enabled }));
}

export function toggleNegate(tree: FilterGroupNode, id: string): FilterGroupNode {
  return mapNode(tree, id, (n) => ({ ...n, negate: !n.negate }));
}

/** AND ↔ OR of a group. */
export function toggleOp(tree: FilterGroupNode, id: string): FilterGroupNode {
  return mapNode(tree, id, (n) =>
    n.kind === 'group' ? { ...n, op: n.op === 'and' ? 'or' : 'and' } : n,
  );
}

/** One step up or down among its siblings (`Alt+↑/↓`); at an end nothing happens. */
export function moveNode(tree: FilterGroupNode, id: string, delta: -1 | 1): FilterGroupNode {
  const parent = parentOf(tree, id);
  if (!parent) return tree;
  const index = parent.children.findIndex((c) => c.id === id);
  const to = index + delta;
  if (to < 0 || to >= parent.children.length) return tree;
  return mapNode(tree, parent.id, (g) => {
    const children = [...(g as FilterGroupNode).children];
    [children[index], children[to]] = [children[to], children[index]];
    return { ...(g as FilterGroupNode), children };
  });
}

/** Dragging: `id` into the group `parentId` at `index`. Not into itself or its own subtree. */
export function moveNodeTo(
  tree: FilterGroupNode,
  id: string,
  parentId: string,
  index: number,
): FilterGroupNode {
  const node = findNode(tree, id);
  const target = findNode(tree, parentId);
  if (!node || node.id === tree.id || target?.kind !== 'group') return tree;
  if (node.kind === 'group' && findNode(node, parentId)) return tree;
  const oldParent = parentOf(tree, id);
  let at = index;
  if (oldParent?.id === parentId) {
    const from = oldParent.children.findIndex((c) => c.id === id);
    if (from < index) at--;
  }
  return addNode(removeNode(tree, id), parentId, node, Math.max(0, at));
}

/** The expression for the backend, or null when nothing is left (no tree, everything off, empty groups). */
export function compileTree(tree: FilterGroupNode | null): FilterExpr | null {
  if (!tree) return null;
  return compileNode(tree);
}

function compileNode(node: FilterNode): FilterExpr | null {
  if (!node.enabled) return null;
  if (node.kind === 'cond') {
    return { kind: 'cond', id: node.id, negate: node.negate, cond: node.cond };
  }
  const children = node.children.map(compileNode).filter((c): c is FilterExpr => c !== null);
  if (children.length === 0) return null;
  return { kind: 'group', id: node.id, op: node.op, negate: node.negate, children };
}

/** Conditions that take part (switched on, not in a group that is off). */
export function countConditions(tree: FilterGroupNode | null): number {
  const count = (expr: FilterExpr | null): number =>
    !expr ? 0 : expr.kind === 'cond' ? 1 : expr.children.reduce((n, c) => n + count(c), 0);
  return count(compileTree(tree));
}

/** All conditions, switched on or not. */
export function allConditions(tree: FilterGroupNode): FilterCondNode[] {
  return tree.children.flatMap((c) => (c.kind === 'cond' ? [c] : allConditions(c)));
}

export function hasFieldConditions(tree: FilterGroupNode | null): boolean {
  return !!tree && allConditions(tree).some((c) => c.enabled && c.cond.type === 'field');
}

/** Same effect: what the backend gets is equal. */
export function sameTree(a: FilterGroupNode | null, b: FilterGroupNode | null): boolean {
  return JSON.stringify(compileTree(a)) === JSON.stringify(compileTree(b));
}

// ------------------------------------------------------------------ texts

export const COND_TYPE_LABELS: Record<FilterCondType, string> = {
  text: 'Text',
  level: 'Level',
  field: 'Feld',
  time: 'Zeit',
  range: 'Abschnitt',
  lines: 'Zeilen',
};

export const FIELD_OP_LABELS: Record<FieldOp, string> = {
  eq: '=',
  contains: 'enthält',
  regex: 'Regex',
  gt: '>',
  lt: '<',
  between: 'zwischen',
};

function pattern(query: SearchQuery): string {
  const text = query.isRegex ? `/${query.text}/` : `„${query.text}“`;
  return query.caseSensitive ? `${text} Aa` : text;
}

/** The condition in a few words, as the tree shows it. Line numbers count from 1. */
export function describeCond(cond: FilterCond, columnLabel?: (id: string) => string): string {
  switch (cond.type) {
    case 'text':
      return pattern(cond);
    case 'level':
      return `Level ${describeLevels(new Set(cond.levels))}`;
    case 'field': {
      const column = columnLabel?.(cond.column) ?? cond.column;
      if (cond.op === 'between') return `${column} zwischen ${cond.value} und ${cond.value2 ?? ''}`;
      const value = cond.op === 'regex' ? `/${cond.value}/` : cond.value;
      return `${column} ${FIELD_OP_LABELS[cond.op]} ${value}`;
    }
    case 'time':
      if (cond.from && cond.to) return `Zeit ${cond.from} – ${cond.to}`;
      if (cond.from) return `Zeit ab ${cond.from}`;
      return `Zeit bis ${cond.to ?? ''}`;
    case 'range': {
      const start = pattern(cond.start);
      const end = cond.end?.text ? ` bis ${pattern(cond.end)}` : ' bis Ende';
      return `Abschnitt ${start}${end}${cond.inclusive ? '' : ' (ohne Marken)'}`;
    }
    case 'lines': {
      const first = cond.first ?? null;
      const last = cond.last ?? null;
      if (first !== null && last !== null) return `Zeilen ${first + 1}–${last + 1}`;
      if (first !== null) return `ab Zeile ${first + 1}`;
      return `bis Zeile ${(last ?? 0) + 1}`;
    }
  }
}

export function describeNode(node: FilterNode, columnLabel?: (id: string) => string): string {
  if (node.label) return node.label;
  if (node.kind === 'group') return node.op === 'and' ? 'Gruppe (UND)' : 'Gruppe (ODER)';
  return describeCond(node.cond, columnLabel);
}

/** The whole tree in one line (saved filters, tooltips). */
export function describeTree(tree: FilterGroupNode | null): string {
  const expr = compileTree(tree);
  const text = (e: FilterExpr): string => {
    const body =
      e.kind === 'cond'
        ? describeCond(e.cond)
        : `(${e.children.map(text).join(e.op === 'and' ? ' UND ' : ' ODER ')})`;
    return e.negate ? `NICHT ${body}` : body;
  };
  if (!expr) return '';
  const all = text(expr);
  return expr.kind === 'group' && !expr.negate ? all.slice(1, -1) : all;
}

// ------------------------------------------------------------------ loading saved trees

const COND_TYPES: readonly FilterCondType[] = ['text', 'level', 'field', 'time', 'range', 'lines'];
const FIELD_OPS: readonly FieldOp[] = ['eq', 'contains', 'regex', 'gt', 'lt', 'between'];

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const optStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const optLine = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff ? v : null;

function queryOf(v: unknown): SearchQuery {
  const q = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  return {
    text: str(q['text']),
    isRegex: q['isRegex'] === true,
    caseSensitive: q['caseSensitive'] === true,
  };
}

function condOf(v: unknown): FilterCond | null {
  if (typeof v !== 'object' || v === null) return null;
  const c = v as Record<string, unknown>;
  const type = c['type'] as FilterCondType;
  if (!COND_TYPES.includes(type)) return null;
  switch (type) {
    case 'text':
      return { type, ...queryOf(c) };
    case 'level': {
      const levels = Array.isArray(c['levels'])
        ? LEVELS.filter((l) => (c['levels'] as unknown[]).includes(l))
        : [];
      return { type, levels: levels as Level[] };
    }
    case 'field': {
      const op = c['op'] as FieldOp;
      if (!FIELD_OPS.includes(op)) return null;
      return {
        type,
        column: str(c['column']),
        op,
        value: str(c['value']),
        value2: optStr(c['value2']),
        caseSensitive: c['caseSensitive'] === true,
      };
    }
    case 'time':
      return { type, from: optStr(c['from']), to: optStr(c['to']) };
    case 'range':
      return {
        type,
        start: queryOf(c['start']),
        end: c['end'] ? queryOf(c['end']) : null,
        inclusive: c['inclusive'] !== false,
      };
    case 'lines':
      return { type, first: optLine(c['first']), last: optLine(c['last']) };
  }
}

/**
 * A tree from the settings file: broken nodes drop out, ids are made unique, depth and number of conditions
 * stay within the backend's limits. Anything unusable gives an empty tree.
 */
export function sanitizeTree(value: unknown): FilterGroupNode {
  const ids = new Set<string>();
  let conditions = 0;
  const uniqueId = (v: unknown): string => {
    let id = typeof v === 'string' && v && v !== ROOT_ID ? v.slice(0, 64) : newNodeId();
    while (ids.has(id)) id = newNodeId();
    ids.add(id);
    return id;
  };
  const node = (v: unknown, depth: number): FilterNode | null => {
    if (typeof v !== 'object' || v === null) return null;
    const n = v as Record<string, unknown>;
    const common = {
      negate: n['negate'] === true,
      enabled: n['enabled'] !== false,
      ...(typeof n['label'] === 'string' && n['label'] ? { label: n['label'].slice(0, 80) } : {}),
    };
    if (n['kind'] === 'cond') {
      const cond = condOf(n['cond']);
      if (!cond || conditions >= MAX_CONDITIONS) return null;
      conditions++;
      return { kind: 'cond', id: uniqueId(n['id']), ...common, cond };
    }
    if (n['kind'] === 'group' && depth < MAX_DEPTH) {
      const children = Array.isArray(n['children'])
        ? (n['children'] as unknown[])
            .map((c) => node(c, depth + 1))
            .filter((c): c is FilterNode => c !== null)
        : [];
      return {
        kind: 'group',
        id: uniqueId(n['id']),
        op: n['op'] === 'or' ? 'or' : 'and',
        ...common,
        children,
      };
    }
    return null;
  };
  const root = node(value, 0);
  ids.add(ROOT_ID);
  if (!root || root.kind !== 'group') return emptyTree();
  return { ...root, id: ROOT_ID };
}
