import { MCP_LIMITS } from './mcp-limits';

/** The history of AI calls (prompt 022, design E7): in memory, at most `historyMax`, never log text. */

export interface HistoryEntry {
  at: number;
  tool: string;
  /** The tab it was about, if any. */
  tab: string | null;
  /** `ok`, `confirmed`, `cancelled` … or the error code. Never log text or SQL values. */
  result: string;
  ms: number;
}

export function pushHistory(all: readonly HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  const next = [entry, ...all];
  return next.length > MCP_LIMITS.historyMax ? next.slice(0, MCP_LIMITS.historyMax) : next;
}
