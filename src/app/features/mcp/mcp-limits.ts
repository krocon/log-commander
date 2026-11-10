/**
 * Limits of the MCP tools (prompt 022), the same numbers as `src-tauri/mcp/src/tools.rs`. `scripts/mcp-limits.test.mjs`
 * compares them with `src-tauri/mcp/tools.snapshot.json` (part of `npm run check`): change both or neither.
 */
export const MCP_LIMITS = {
  readLinesMax: 500,
  readLinesDefault: 50,
  lineCharsMin: 80,
  lineCharsMax: 16_000,
  lineCharsDefault: 2_000,
  entryCharsMin: 1_000,
  entryCharsMax: 262_144,
  entryCharsDefault: 20_000,
  hitsMax: 200,
  hitsDefault: 20,
  bucketsMax: 500,
  bucketsDefault: 60,
  sqlRowsMax: 1_000,
  sqlRowsDefault: 200,
  sqlBytesMax: 65_536,
  waitSecondsMax: 120,
  waitSecondsDefault: 30,
  waitLinesMax: 50,
  waitLinesDefault: 10,
  noteCharsMax: 1_996,
  patternCharsMax: 4_096,
  openPathsMax: 16,
  /** How long set_filter, open_filter_tab and run_sql wait for the backend (design E3). */
  filterWaitMs: 30_000,
  /** How long a proposal waits for the user (design E6). */
  proposalWaitMs: 300_000,
  /** Calls kept in the history (design E7). */
  historyMax: 50,
} as const;
