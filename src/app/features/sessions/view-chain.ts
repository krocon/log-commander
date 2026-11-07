/**
 * Filter tabs (prompt 013): a filter opened as a tab of its own shows the result of its parent tab and filters
 * further. Pure logic for names of the chain, the limit per file, where a new tab goes and what closing does.
 */
import { Level, SearchMode, SearchQuery } from '../../core/log/log.models';
import { ALL_LEVELS, describeLevels, sameLevels } from './filter-logic';
import { FilterGroupNode, describeTree } from './filter-tree';
import { allVisible } from '../merge/merge-logic';

/** Views (tabs) per file; mirrors `MAX_VIEWS` in src-tauri/src/views.rs. */
export const MAX_VIEWS = 8;

/** A part of a tab name longer than this is cut. */
const PART_CHARS = 24;
/** Names with more parts show only the last ones. */
const SHORT_PARTS = 3;

/** What a tab filters by itself (not its parents). */
export interface OwnFilter {
  levels: ReadonlySet<Level>;
  query: SearchQuery;
  mode: SearchMode;
  sourceMask: number;
  tree: FilterGroupNode | null;
}

/**
 * A short name of what a tab filters by itself, for the chain: levels, a filtering search, the conditions, the
 * sources of a merge. Empty when it filters nothing (a highlighting search only marks).
 */
export function ownLabel(filter: OwnFilter, sourceLabels: readonly string[] = []): string {
  const parts: string[] = [];
  if (!sameLevels(filter.levels, ALL_LEVELS)) parts.push(describeLevels(filter.levels));
  if (filter.query.text && filter.mode === 'filter') {
    parts.push(filter.query.isRegex ? `/${filter.query.text}/` : filter.query.text);
  }
  const conditions = describeTree(filter.tree);
  if (conditions) parts.push(conditions);
  if (sourceLabels.length && !allVisible(filter.sourceMask, sourceLabels.length)) {
    parts.push(sourceLabels.filter((_, i) => (filter.sourceMask & (1 << i)) !== 0).join('+'));
  }
  return parts.join(' · ');
}

/** The parts of a tab's name: the file, then each step of the chain that filters something. */
export function chainParts(fileName: string, steps: readonly string[]): string[] {
  return [fileName, ...steps.filter((s) => s !== '')];
}

function cut(part: string): string {
  return part.length > PART_CHARS ? `${part.slice(0, PART_CHARS - 1)}…` : part;
}

/** The tab's name, short: „…› ERROR › 4711“ once the chain is longer than three parts. */
export function shortChain(parts: readonly string[]): string {
  if (parts.length <= SHORT_PARTS) return parts.map(cut).join(' › ');
  return `…› ${parts.slice(-2).map(cut).join(' › ')}`;
}

/** The whole chain, for the tab's title. */
export function fullChain(parts: readonly string[]): string {
  return parts.join(' › ');
}

/** What a tab needs to know of the others for the rules below. */
export interface TabRef {
  id: number;
  sessionId: number;
}

/** Tabs of the same file (session). */
export function viewsOf<T extends TabRef>(tabs: readonly T[], sessionId: number): T[] {
  return tabs.filter((t) => t.sessionId === sessionId);
}

/** Why no further filter tab can open for this file, or null. */
export function viewLimitReason(tabs: readonly TabRef[], sessionId: number): string | null {
  return viewsOf(tabs, sessionId).length >= MAX_VIEWS
    ? `Höchstens ${MAX_VIEWS} Tabs je Datei, zuerst einen Filter-Tab schließen`
    : null;
}

/** Where a new filter tab goes: directly right of its parent. */
export function insertIndex(tabs: readonly TabRef[], parentId: number): number {
  const index = tabs.findIndex((t) => t.id === parentId);
  return index < 0 ? tabs.length : index + 1;
}

/**
 * A tab closes: the backend hands its filter down, so its children keep their result. Their parent becomes its
 * parent, and its steps (inherited ones and its own) stay in their names.
 */
export function inheritOnClose(
  closing: { parentId: number | null; inherited: readonly string[]; own: string },
  child: { inherited: readonly string[] },
): { parentId: number | null; inherited: string[] } {
  return {
    parentId: closing.parentId,
    inherited: [...closing.inherited, closing.own, ...child.inherited].filter((s) => s !== ''),
  };
}
