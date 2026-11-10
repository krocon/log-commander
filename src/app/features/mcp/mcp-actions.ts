/**
 * Actions an AI may run with `run_action` (prompt 022, design E5): view actions only – no files, no clipboard, no
 * dialogs, nothing that opens sources. `mcp-actions.spec.ts` checks that every id exists in the catalog.
 */
export const MCP_ACTIONS = [
  'FOLLOW_END',
  'TOGGLE_FOLLOW',
  'TOGGLE_FREEZE',
  'GO_START',
  'SCROLL_PAGE_UP',
  'SCROLL_PAGE_DOWN',
  'NEXT_ERROR',
  'PREV_ERROR',
  'NEXT_WARNING',
  'PREV_WARNING',
  'NEXT_BOOKMARK',
  'PREV_BOOKMARK',
  'CLEAR_SELECTION',
  'OPEN_DETAIL',
  'TOGGLE_DETAIL',
  'TOGGLE_TIMELINE',
  'TOGGLE_COLUMNS',
  'TOGGLE_SIDEBAR',
  'TOGGLE_DASHBOARD',
  'TOGGLE_FULL_LOG',
  'NEXT_TAB',
  'PREV_TAB',
] as const;
