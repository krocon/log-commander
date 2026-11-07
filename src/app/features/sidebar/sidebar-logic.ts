/** Layout rules of the sidebar (prompt 005), without DOM. */
import { clampSize } from '../../shared/splitter-logic';
import { SPLITTER_SIZE } from '../detail/detail-logic';

export const SIDEBAR_MIN = 180;
/** The log view right of the sidebar keeps at least this. */
export const LOG_MIN_WIDTH = 360;
/** Below this window width the sidebar hides itself, the setting stays. */
export const NARROW_BELOW = 900;
/** Tree and statistics each keep at least this much height. */
export const TREE_MIN = 60;
export const STATS_MIN = 80;

/** Widest sidebar that leaves the log view its minimum. */
export function sidebarMax(available: number): number {
  return Math.max(SIDEBAR_MIN, Math.floor(available - LOG_MIN_WIDTH - SPLITTER_SIZE));
}

/** The width the sidebar gets: the stored one within the bounds of the window. */
export function sidebarWidth(wanted: number, available: number): number {
  return clampSize(wanted, SIDEBAR_MIN, sidebarMax(available));
}

export interface SidebarToggle {
  /** The stored setting. */
  visible: boolean;
  /** The window is narrower than `NARROW_BELOW`. */
  narrow: boolean;
  /** Shown anyway in a narrow window, until it gets wide again; not stored. */
  override: boolean;
}

export function sidebarShown({ visible, narrow, override }: SidebarToggle): boolean {
  return visible && (!narrow || override);
}

/**
 * Cmd/Ctrl+B and the toolbar button. In a wide window that is the setting. In a narrow one the
 * sidebar hid itself, so showing or hiding it there only changes the override and keeps the setting
 * for the wide window.
 */
export function toggleSidebar(state: SidebarToggle): SidebarToggle {
  if (sidebarShown(state)) {
    return state.narrow ? { ...state, override: false } : { ...state, visible: false };
  }
  return { ...state, visible: true, override: state.narrow };
}

/** Height of the tree for a share of the sidebar height, leaving the statistics their minimum. */
export function treeHeight(share: number, available: number): number {
  const room = Math.max(0, available - SPLITTER_SIZE);
  const max = Math.max(TREE_MIN, room - STATS_MIN);
  return clampSize(room * share, TREE_MIN, max);
}

/** The share to store after the tree was dragged to `height`. */
export function treeShare(height: number, available: number): number {
  const room = Math.max(1, available - SPLITTER_SIZE);
  return Math.min(0.9, Math.max(0.1, height / room));
}

/** Upper bound of the tree splitter. */
export function treeMax(available: number): number {
  return Math.max(TREE_MIN, Math.floor(available - SPLITTER_SIZE - STATS_MIN));
}
