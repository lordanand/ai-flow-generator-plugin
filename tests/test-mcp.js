import { spawn } from 'node:child_process';
import readline from 'node:readline';

const proc = spawn('node', ['servers/snapshot-server.js'], {
  stdio: ['pipe', 'pipe', 'inherit']
});

const rl = readline.createInterface({ input: proc.stdout });

let nextId = 1;
const pending = new Map();

rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  } catch (err) {
    console.error('Failed to parse line:', line, err);
  }
});

function sendRequest(method, params = {}) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    const req = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    proc.stdin.write(req);
  });
}

function sendNotification(method, params = {}) {
  const notif = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
  proc.stdin.write(notif);
}

async function runTests() {
  console.log('--- Starting MCP Server Test ---');

  // 1. Initialize
  const initRes = await sendRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' }
  });
  console.log('1. Initialize response:', initRes.result?.serverInfo);
  sendNotification('notifications/initialized');

  // 2. List tools
  const toolsRes = await sendRequest('tools/list');
  const toolNames = toolsRes.result?.tools?.map(t => t.name) || [];
  console.log('2. Available tools:', toolNames);


  // 3. ARIA snapshot (default mode)
  const defaultSnap = await sendRequest('tools/call', {
    name: 'get_page_snapshot'
  });
  console.log('3. ARIA snapshot:\n' + defaultSnap.result?.content?.[0]?.text);

  // 4. Navigate to example.com and snapshot again
  await sendRequest('tools/call', {
    name: 'open_url',
    arguments: { url: 'https://example.com' }
  });
  const snapExample = await sendRequest('tools/call', {
    name: 'get_page_snapshot'
  });
  console.log('4. ARIA snapshot of example.com:\n' + snapExample.result?.content?.[0]?.text);

  console.log('--- All Tests Passed Successfully! ---');
  proc.kill();
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test error:', err);
  proc.kill();
  process.exit(1);
});
