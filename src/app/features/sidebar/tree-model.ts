/**
 * The nodes of the sidebar tree (prompt 005) as a pure function of the open sessions and the saved
 * filters. The component only draws the flat list; `aria-level` carries the depth.
 */
import { LEVELS, Level, SearchMode, SearchQuery } from '../../core/log/log.models';
import { SavedFilter } from '../../core/settings/settings.models';
import { ALL_LEVELS, SEVERITIES, sameLevels } from '../sessions/filter-logic';

/** What the tree needs of a session; `SessionState` fits. */
export interface TreeSession {
  id: number;
  fileName: string;
  path: string;
  levels: ReadonlySet<Level>;
  query: SearchQuery;
  mode: SearchMode;
  /** The files of a merge (prompt 006); they become child nodes. */
  sources?: readonly { fileName: string; path: string }[];
}

export type TreeNodeKind =
  'file' | 'source' | 'active-filter' | 'filter-levels' | 'filter-query' | 'saved-group' | 'saved';

export interface TreeNode {
  /**
   * Stable across updates: `file:3`, `source:3:1`, `filter:3`, `levels:3`, `query:3`, `saved`,
   * `saved:<id>`.
   */
  id: string;
  kind: TreeNodeKind;
  label: string;
  title: string;
  /** 1-based depth (`aria-level`). */
  level: number;
  parentId: string | null;
  expandable: boolean;
  expanded: boolean;
  posInSet: number;
  setSize: number;
  sessionId: number | null;
  savedId: string | null;
  /** A source node: its index in the merge. */
  sourceIndex?: number;
  /** The file of the active tab, or the saved filter the active tab uses right now. */
  current: boolean;
}

const UNKNOWN_LABEL = 'Ohne Level';

/** Severity order, unknown last: `WARN, ERROR, FATAL`. */
export function describeLevels(levels: ReadonlySet<Level>): string {
  if (levels.size === 0) return 'Keine Level';
  const names: string[] = SEVERITIES.filter((level) => levels.has(level));
  if (levels.has('UNKNOWN')) names.push(UNKNOWN_LABEL);
  return names.join(', ');
}

export function describeQuery(query: SearchQuery, mode: SearchMode): string {
  const flags = [query.isRegex ? 'Regex' : '', query.caseSensitive ? 'Aa' : '']
    .filter(Boolean)
    .join(', ');
  const text = query.isRegex ? `/${query.text}/` : `„${query.text}“`;
  const parts = [text];
  if (flags) parts.push(flags);
  if (mode === 'highlight') parts.push('hervorheben');
  return parts.join(' · ');
}

/** Something narrows or marks the view: worth a node and worth saving. */
export function hasActiveFilter(levels: ReadonlySet<Level>, query: SearchQuery): boolean {
  return !sameLevels(levels, ALL_LEVELS) || query.text !== '';
}

/** Name proposed when saving: what the filter does, short. */
export function suggestName(levels: ReadonlySet<Level>, query: SearchQuery): string {
  const parts: string[] = [];
  if (!sameLevels(levels, ALL_LEVELS)) parts.push(describeLevels(levels));
  if (query.text) parts.push(query.isRegex ? `/${query.text}/` : `„${query.text}“`);
  return parts.join(' · ').slice(0, 80) || 'Filter';
}

export function sameFilter(
  saved: SavedFilter,
  levels: ReadonlySet<Level>,
  query: SearchQuery,
  mode: SearchMode,
): boolean {
  return (
    sameLevels(new Set(saved.levels), levels) &&
    saved.query.text === query.text &&
    saved.query.isRegex === query.isRegex &&
    saved.query.caseSensitive === query.caseSensitive &&
    (saved.mode === mode || !query.text)
  );
}

/** Adds a filter; one with the same name (ignoring case) is replaced, keeping its id. */
export function upsertSavedFilter(list: readonly SavedFilter[], entry: SavedFilter): SavedFilter[] {
  const key = entry.name.trim().toLocaleLowerCase('de');
  const index = list.findIndex((f) => f.name.trim().toLocaleLowerCase('de') === key);
  if (index < 0) return [...list, entry];
  const next = [...list];
  next[index] = { ...entry, id: list[index].id };
  return next;
}

export function savedFilterOf(
  id: string,
  name: string,
  levels: ReadonlySet<Level>,
  query: SearchQuery,
  mode: SearchMode,
): SavedFilter {
  return {
    id,
    name: name.trim(),
    levels: LEVELS.filter((level) => levels.has(level)),
    query: { ...query },
    mode,
  };
}

const collator = new Intl.Collator('de', { sensitivity: 'base', numeric: true });

/**
 * The visible nodes in order. Files in tab order, each with its active filter if it has one; then the
 * saved filters by name. `collapsed` holds the ids of closed nodes, everything else is open.
 */
export function buildTree(
  sessions: readonly TreeSession[],
  activeId: number | null,
  saved: readonly SavedFilter[],
  collapsed: ReadonlySet<string>,
): TreeNode[] {
  const nodes: TreeNode[] = [];
  const active = sessions.find((s) => s.id === activeId) ?? null;
  sessions.forEach((session, index) => {
    const filtered = hasActiveFilter(session.levels, session.query);
    const sources = session.sources ?? [];
    const fileId = `file:${session.id}`;
    const fileOpen = (filtered || sources.length > 0) && !collapsed.has(fileId);
    const title = sources.length ? sources.map((s) => s.path).join('\n') : session.path;
    nodes.push({
      ...base(fileId, 'file', session.fileName, title, 1, null),
      expandable: filtered || sources.length > 0,
      expanded: fileOpen,
      posInSet: index + 1,
      setSize: sessions.length + (saved.length ? 1 : 0),
      sessionId: session.id,
      current: session.id === activeId,
    });
    if (!fileOpen) return;
    const level2 = sources.length + (filtered ? 1 : 0);
    sources.forEach((source, i) => {
      nodes.push({
        ...base(`source:${session.id}:${i}`, 'source', source.fileName, source.path, 2, fileId),
        posInSet: i + 1,
        setSize: level2,
        sessionId: session.id,
        sourceIndex: i,
      });
    });
    if (!filtered) return;
    const filterId = `filter:${session.id}`;
    const filterOpen = !collapsed.has(filterId);
    nodes.push({
      ...base(filterId, 'active-filter', 'Aktiver Filter', 'Filter dieser Datei', 2, fileId),
      expandable: true,
      expanded: filterOpen,
      posInSet: level2,
      setSize: level2,
      sessionId: session.id,
    });
    if (!filterOpen) return;
    const children: TreeNode[] = [];
    if (!sameLevels(session.levels, ALL_LEVELS)) {
      const label = describeLevels(session.levels);
      children.push({
        ...base(`levels:${session.id}`, 'filter-levels', label, `Level: ${label}`, 3, filterId),
        sessionId: session.id,
      });
    }
    if (session.query.text) {
      const label = describeQuery(session.query, session.mode);
      children.push({
        ...base(`query:${session.id}`, 'filter-query', label, `Suche: ${label}`, 3, filterId),
        sessionId: session.id,
      });
    }
    children.forEach((child, i) =>
      nodes.push({ ...child, posInSet: i + 1, setSize: children.length }),
    );
  });
  if (saved.length) {
    const groupOpen = !collapsed.has('saved');
    nodes.push({
      ...base(
        'saved',
        'saved-group',
        'Gespeicherte Filter',
        'Klick wendet auf den aktiven Tab an',
        1,
        null,
      ),
      expandable: true,
      expanded: groupOpen,
      posInSet: sessions.length + 1,
      setSize: sessions.length + 1,
    });
    if (groupOpen) {
      const sorted = [...saved].sort((a, b) => collator.compare(a.name, b.name));
      sorted.forEach((filter, i) => {
        const parts = [describeLevels(new Set(filter.levels))];
        if (filter.query.text) parts.push(describeQuery(filter.query, filter.mode));
        nodes.push({
          ...base(`saved:${filter.id}`, 'saved', filter.name, parts.join(' · '), 2, 'saved'),
          posInSet: i + 1,
          setSize: sorted.length,
          savedId: filter.id,
          current: !!active && sameFilter(filter, active.levels, active.query, active.mode),
        });
      });
    }
  }
  return nodes;
}

function base(
  id: string,
  kind: TreeNodeKind,
  label: string,
  title: string,
  level: number,
  parentId: string | null,
): TreeNode {
  return {
    id,
    kind,
    label,
    title,
    level,
    parentId,
    expandable: false,
    expanded: false,
    posInSet: 1,
    setSize: 1,
    sessionId: null,
    savedId: null,
    current: false,
  };
}

/** What a key does in the tree (WAI-ARIA tree view): move the focus, open or close a node. */
export interface TreeMove {
  focus?: string;
  expand?: string;
  collapse?: string;
}

export function treeKey(
  nodes: readonly TreeNode[],
  focusedId: string,
  key: string,
): TreeMove | null {
  if (!nodes.length) return null;
  const index = Math.max(
    0,
    nodes.findIndex((n) => n.id === focusedId),
  );
  const node = nodes[index];
  switch (key) {
    case 'ArrowDown':
      return { focus: nodes[Math.min(nodes.length - 1, index + 1)].id };
    case 'ArrowUp':
      return { focus: nodes[Math.max(0, index - 1)].id };
    case 'Home':
      return { focus: nodes[0].id };
    case 'End':
      return { focus: nodes[nodes.length - 1].id };
    case 'ArrowRight':
      if (node.expandable && !node.expanded) return { expand: node.id };
      if (node.expanded && nodes[index + 1]?.parentId === node.id) {
        return { focus: nodes[index + 1].id };
      }
      return {};
    case 'ArrowLeft':
      if (node.expandable && node.expanded) return { collapse: node.id };
      if (node.parentId) return { focus: node.parentId };
      return {};
    default:
      return null;
  }
}
