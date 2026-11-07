import { describe, expect, it } from 'vitest';
import {
  LOG_MIN_WIDTH,
  SIDEBAR_MIN,
  STATS_MIN,
  TREE_MIN,
  sidebarMax,
  sidebarShown,
  sidebarWidth,
  toggleSidebar,
  treeHeight,
  treeMax,
  treeShare,
} from './sidebar-logic';

describe('sidebar layout', () => {
  it('keeps the log view its minimum width', () => {
    expect(sidebarMax(1200)).toBe(1200 - LOG_MIN_WIDTH - 8);
    expect(sidebarWidth(2000, 1200)).toBe(sidebarMax(1200));
    expect(sidebarWidth(100, 1200)).toBe(SIDEBAR_MIN);
    // A window of 720 px: the sidebar keeps its minimum, the log view what is left.
    expect(sidebarWidth(240, 720)).toBe(240);
    expect(sidebarWidth(500, 720)).toBe(720 - LOG_MIN_WIDTH - 8);
    expect(sidebarWidth(240, 300)).toBe(SIDEBAR_MIN);
  });

  it('hides itself in a narrow window without changing the setting', () => {
    expect(sidebarShown({ visible: true, narrow: false, override: false })).toBe(true);
    expect(sidebarShown({ visible: true, narrow: true, override: false })).toBe(false);
    expect(sidebarShown({ visible: true, narrow: true, override: true })).toBe(true);
    expect(sidebarShown({ visible: false, narrow: false, override: true })).toBe(false);
  });

  it('toggles the setting in a wide window and the override in a narrow one', () => {
    expect(toggleSidebar({ visible: true, narrow: false, override: false })).toEqual({
      visible: false,
      narrow: false,
      override: false,
    });
    expect(toggleSidebar({ visible: false, narrow: false, override: false }).visible).toBe(true);
    // Narrow and hidden by the width: show it, the setting stays on.
    expect(toggleSidebar({ visible: true, narrow: true, override: false })).toEqual({
      visible: true,
      narrow: true,
      override: true,
    });
    // Narrow and shown anyway: hide again, the wide window still shows it.
    expect(toggleSidebar({ visible: true, narrow: true, override: true })).toEqual({
      visible: true,
      narrow: true,
      override: false,
    });
    // Narrow and switched off: on, and shown right away.
    expect(toggleSidebar({ visible: false, narrow: true, override: false })).toEqual({
      visible: true,
      narrow: true,
      override: true,
    });
  });

  it('splits the height between tree and statistics', () => {
    expect(treeHeight(0.5, 608)).toBe(300);
    expect(treeHeight(0.9, 208)).toBe(200 - STATS_MIN);
    expect(treeHeight(0.1, 208)).toBe(TREE_MIN);
    expect(treeMax(608)).toBe(600 - STATS_MIN);
    expect(treeShare(300, 608)).toBeCloseTo(0.5);
    expect(treeShare(5000, 608)).toBe(0.9);
    expect(treeShare(0, 608)).toBe(0.1);
  });
});
