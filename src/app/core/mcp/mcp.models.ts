/** DTOs of AI control (prompt 022), mirror `McpEvent`, `McpInfo` in src-tauri/src/commands.rs and `Probe` in lc-mcp. */

export interface McpInfo {
  /** The bridge is open: a port and the endpoint file exist. */
  enabled: boolean;
  connections: number;
  /** The sidecar next to the app program; null = missing. */
  sidecar: string | null;
  /** A debug build (a missing sidecar is built with `cargo build -p lc-mcp`). */
  debug: boolean;
}

export type McpEvent =
  { kind: 'call'; callId: number; tool: string; args: unknown } | { kind: 'status'; info: McpInfo };

/** An error of a tool, as the AI reads it (`code: message`). */
export interface McpReplyError {
  code: string;
  message: string;
}

export type ProbeStep = 'start' | 'initialize' | 'tools' | 'app';

export interface McpProbe {
  ok: boolean;
  step: ProbeStep;
  code: string | null;
  server: string | null;
  version: string | null;
  protocol: string | null;
  tools: number;
  app: boolean;
  tabs: number | null;
}
