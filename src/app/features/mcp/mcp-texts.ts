import { McpProbe } from '../../core/mcp/mcp.models';

/** German texts of AI control (prompt 022): history, connection test, setup lines. Pure, with spec. */

export function historyTime(at: number): string {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

const RESULTS: Record<string, string> = {
  ok: 'ok',
  confirmed: 'erlaubt',
  cancelled: 'abgelehnt',
  timeout: 'Zeit abgelaufen',
  tab_not_found: 'Tab fehlt',
  stale_view: 'Zeilen veraltet',
  denied: 'nicht erlaubt',
  busy: 'beschäftigt',
  invalid_args: 'Argumente falsch',
  invalid_filter: 'Filter ungültig',
  invalid_search: 'Suche ungültig',
  invalid_query: 'SQL ungültig',
  report_building: 'Tabelle im Aufbau',
  limit_exceeded: 'Grenze erreicht',
  too_many_views: 'zu viele Tabs',
};

export function historyResult(code: string): string {
  return RESULTS[code] ?? code;
}

/** The line for Claude Code, quoted for the shell of the platform. */
export function claudeCodeLine(sidecar: string, windows: boolean): string {
  const quoted = windows ? `"${sidecar}"` : `'${sidecar.replace(/'/g, `'\\''`)}'`;
  return `claude mcp add --scope user log-commander -- ${quoted}`;
}

/** The entry for Claude Desktop / Cursor (`mcpServers`). */
export function desktopConfig(sidecar: string): string {
  return JSON.stringify({ mcpServers: { 'log-commander': { command: sidecar } } }, null, 2);
}

/** What the connection test found, in one sentence. */
export function probeText(p: McpProbe): string {
  if (p.ok) {
    const tabs =
      p.tabs === null ? '' : ` – ${p.tabs === 1 ? 'ein Tab' : `${p.tabs} Tabs`} sichtbar`;
    return `Verbindung steht: ${p.tools} Tools${tabs}.`;
  }
  switch (p.step) {
    case 'start':
      return p.code === 'not_found'
        ? 'Das Hilfsprogramm log-commander-mcp fehlt neben der App.'
        : 'Das Hilfsprogramm log-commander-mcp startet nicht.';
    case 'initialize':
    case 'tools':
      return 'Das Hilfsprogramm antwortet nicht wie ein MCP-Server.';
    case 'app':
      return p.code === 'not_running'
        ? 'Das Hilfsprogramm erreicht die App nicht – ist die KI-Steuerung an?'
        : `Die App antwortet mit einem Fehler (${p.code ?? 'unbekannt'}).`;
  }
}
