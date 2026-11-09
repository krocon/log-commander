import { Injectable } from '@angular/core';
import { Channel } from '@tauri-apps/api/core';
import { call } from '../backend/call';
import { McpEvent, McpInfo, McpProbe, McpReplyError } from './mcp.models';

/** AI control over MCP (prompt 022): the bridge for the `log-commander-mcp` sidecar. */
@Injectable({ providedIn: 'root' })
export class McpApi {
  /** Listens for tool calls and status changes; a new subscription replaces the old one. */
  subscribe(onEvent: (event: McpEvent) => void): Promise<McpInfo> {
    const channel = new Channel<McpEvent>();
    channel.onmessage = onEvent;
    return call('subscribe_mcp', { onEvent: channel });
  }

  /** Opens or closes the bridge; off = no port, no endpoint file. */
  setEnabled(enabled: boolean): Promise<McpInfo> {
    return call('mcp_set_enabled', { enabled });
  }

  info(): Promise<McpInfo> {
    return call('mcp_info');
  }

  reply(callId: number, result: unknown, error: McpReplyError | null): Promise<void> {
    return call('mcp_reply', { callId, result: error ? null : result, error });
  }

  /** Cuts every AI connection; the bridge stays open. */
  disconnect(): Promise<void> {
    return call('mcp_disconnect');
  }

  /** Starts the sidecar like an MCP client: handshake and one call to the app. */
  probe(): Promise<McpProbe> {
    return call('mcp_probe');
  }
}
