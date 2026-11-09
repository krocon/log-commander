// A minimal MCP client over stdio (prompt 022): starts `log-commander-mcp` like Claude Code does and sends JSON-RPC
// requests, one per line. Used by the e2e harness; also handy by hand:
//   node scripts/e2e/mcp-client.mjs src-tauri/target/debug/log-commander-mcp get_workspace '{}'
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class McpClient {
  constructor(program, env = process.env) {
    this.child = spawn(program, [], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    this.next = 1;
    this.waiting = new Map();
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      if (msg.error) w.reject(Object.assign(new Error(msg.error.message), { rpc: msg.error }));
      else w.resolve(msg.result);
    });
  }

  request(method, params = {}, timeoutMs = 60_000) {
    const id = this.next++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${method}: no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiting.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async initialize() {
    const init = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'lc-e2e', version: '1' },
    });
    this.notify('notifications/initialized');
    return init;
  }

  /** A tool call: `{ ok, data, text }`; `ok` false for an error result (`code: message` in `text`). */
  async tool(name, args = {}, timeoutMs = 60_000) {
    const r = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const text = r.content?.[0]?.text ?? '';
    return {
      ok: !r.isError,
      data: r.structuredContent,
      text,
      code: r.isError ? text.split(':')[0] : null,
    };
  }

  close() {
    this.child.stdin.end();
    this.child.kill();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [program, tool, args] = process.argv.slice(2);
  const client = new McpClient(program);
  await client.initialize();
  const r = tool
    ? await client.tool(tool, JSON.parse(args ?? '{}'))
    : await client.request('tools/list');
  console.log(tool ? r.text : JSON.stringify(r, null, 2));
  client.close();
}
