import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const proc = spawn('node', ['servers/template-server.js'], {
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
  console.log('--- Starting CSV Template MCP Server Tests ---');

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
  const toolNames = toolsRes.result?.tools?.map((t) => t.name) || [];
  console.log('2. Available tools:', toolNames);
  if (!toolNames.includes('replace_template') || !toolNames.includes('fill_template')) {
    throw new Error('Expected replace_template and fill_template tools to be registered');
  }

  // 3. Test single multiline code string with tests/fixtures/data.csv
  const singleCode = `
await page.locator('[name="FIELD1"]').click();
await page.locator('[name="FIELD1"]').fill("{{first_name}}");
await page.locator('[name="FIELD2"]').click();
await page.locator('[name="FIELD2"]').fill("{{last_name}}");
await page.getByRole("combobox", { name: "State" }).fill("{{state_province}}");
  `.trim();

  const singleRes = await sendRequest('tools/call', {
    name: 'replace_template',
    arguments: {
      filePath: './tests/fixtures/data.csv',
      code: singleCode
    }
  });

  const replacedText = singleRes.result?.content?.[0]?.text;
  console.log('3. Single multiline template replacement output:\n', replacedText);

  if (!replacedText.includes('fill("John")') || !replacedText.includes('fill("Smith")') || !replacedText.includes('fill("NY")')) {
    throw new Error('Template substitution failed for John, Smith, or NY');
  }

  // 4. Test array of code strings
  const arrayRes = await sendRequest('tools/call', {
    name: 'replace_template',
    arguments: {
      filePath: 'tests/fixtures/data.csv',
      code: [
        'await page.locator("#email").fill("{{email}}");',
        'await page.locator("#city").fill("{{city}}");'
      ]
    }
  });
  const arrayText = arrayRes.result?.content?.[0]?.text;
  console.log('4. Array of code strings output:\n', arrayText);
  if (!arrayText.includes('john.smith@example.com') || !arrayText.includes('New York')) {
    throw new Error('Array substitution failed');
  }

  // 5. Test alias tool fill_template
  const aliasRes = await sendRequest('tools/call', {
    name: 'fill_template',
    arguments: {
      filePath: 'tests/fixtures/data.csv',
      code: 'console.log("User: {{full_name}}");'
    }
  });
  const aliasText = aliasRes.result?.content?.[0]?.text;
  console.log('5. Alias fill_template output:\n', aliasText);
  if (!aliasText.includes('John A Smith')) {
    throw new Error('Alias tool fill_template failed');
  }

  // 6. Test missing placeholder error handling
  const missingRes = await sendRequest('tools/call', {
    name: 'replace_template',
    arguments: {
      filePath: 'tests/fixtures/data.csv',
      code: 'await page.fill("{{nonexistent_header_xyz}}");'
    }
  });
  console.log('6. Missing header error test (isError=' + missingRes.result?.isError + '):\n', missingRes.result?.content?.[0]?.text);
  if (!missingRes.result?.isError || !missingRes.result?.content?.[0]?.text.includes('nonexistent_header_xyz')) {
    throw new Error('Missing placeholder error handling did not trigger properly');
  }

  // 7. Test nonexistent file error handling
  const fileErrRes = await sendRequest('tools/call', {
    name: 'replace_template',
    arguments: {
      filePath: 'tests/fixtures/not_a_real_file.csv',
      code: 'await page.fill("{{first_name}}");'
    }
  });
  console.log('7. Nonexistent file error test (isError=' + fileErrRes.result?.isError + '):\n', fileErrRes.result?.content?.[0]?.text);
  if (!fileErrRes.result?.isError) {
    throw new Error('Nonexistent file error did not trigger');
  }

  // 8. CSV values come through exactly as written (no date or number reformatting)
  const literalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-literal-'));
  const literalCsv = path.join(literalDir, 'data.csv');
  fs.writeFileSync(literalCsv, 'dob,zip,amount,ssn\n1/2/1990,02600,"1,500",000-12-3456\n');
  const literalRes = await sendRequest('tools/call', {
    name: 'replace_template',
    arguments: { filePath: literalCsv, code: '{{dob}}|{{zip}}|{{amount}}|{{ssn}}' }
  });
  fs.rmSync(literalDir, { recursive: true, force: true });
  const literalText = literalRes.result?.content?.[0]?.text;
  console.log('8. Literal CSV values:\n', literalText);
  if (literalText !== '1/2/1990|02600|1,500|000-12-3456') {
    throw new Error(`CSV values were reformatted: ${literalText}`);
  }

  console.log('--- All CSV Template Tests Passed Successfully! ---');
  proc.kill();
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  proc.kill();
  process.exit(1);
});
