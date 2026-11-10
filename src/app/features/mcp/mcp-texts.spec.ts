import { describe, expect, it } from 'vitest';
import { McpProbe } from '../../core/mcp/mcp.models';
import { claudeCodeLine, desktopConfig, historyResult, probeText } from './mcp-texts';

const probe = (over: Partial<McpProbe>): McpProbe => ({
  ok: false,
  step: 'start',
  code: null,
  server: null,
  version: null,
  protocol: null,
  tools: 0,
  app: false,
  tabs: null,
  ...over,
});

describe('mcp texts', () => {
  it('quotes the sidecar for the shell of the platform', () => {
    expect(claudeCodeLine('/Apps/Log Commander.app/Contents/MacOS/log-commander-mcp', false)).toBe(
      "claude mcp add --scope user log-commander -- '/Apps/Log Commander.app/Contents/MacOS/log-commander-mcp'",
    );
    expect(claudeCodeLine("/a/it's/mcp", false)).toBe(
      "claude mcp add --scope user log-commander -- '/a/it'\\''s/mcp'",
    );
    expect(claudeCodeLine('C:\\LC\\log-commander-mcp.exe', true)).toBe(
      'claude mcp add --scope user log-commander -- "C:\\LC\\log-commander-mcp.exe"',
    );
    expect(JSON.parse(desktopConfig('/x/mcp'))).toEqual({
      mcpServers: { 'log-commander': { command: '/x/mcp' } },
    });
  });

  it('names results and probe outcomes in German', () => {
    expect(historyResult('cancelled')).toBe('abgelehnt');
    expect(historyResult('io')).toBe('io');
    expect(probeText(probe({ ok: true, step: 'app', tools: 31, tabs: 2 }))).toBe(
      'Verbindung steht: 31 Tools – 2 Tabs sichtbar.',
    );
    expect(probeText(probe({ code: 'not_found' }))).toContain('fehlt');
    expect(probeText(probe({ step: 'app', code: 'not_running' }))).toContain('KI-Steuerung an');
  });
});
