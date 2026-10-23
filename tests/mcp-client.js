import { spawn } from 'node:child_process';
import readline from 'node:readline';

/**
 * Spawns an MCP server over stdio and returns a minimal client for tests.
 * `call(name, args)` returns { text, isError } from the tool's first content item.
 */
export async function startServer(script) {
  const proc = spawn('node', [script], { stdio: ['pipe', 'pipe', 'inherit'] });
  const rl = readline.createInterface({ input: proc.stdout });
  const pending = new Map();
  let nextId = 1;

  rl.on('line', (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' }
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  return {
    async call(name, args = {}) {
      const res = await send('tools/call', { name, arguments: args });
      if (res.error) throw new Error(`${name}: ${res.error.message}`);
      return { text: res.result?.content?.[0]?.text ?? '', isError: res.result?.isError === true };
    },
    async listTools() {
      const res = await send('tools/list');
      return res.result?.tools?.map((t) => t.name) ?? [];
    },
    close() {
      proc.kill();
    }
  };
}
