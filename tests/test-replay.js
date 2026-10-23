import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { isBrowserRunning } from '../lib/browser.js';
import { BRAVE_PATH } from '../lib/config.js';
import { startServer } from './mcp-client.js';

if (!fs.existsSync(BRAVE_PATH)) {
  console.log('[INFO] Brave is not installed. Skipping replay test.');
  process.exit(0);
}
if (await isBrowserRunning()) {
  // Never touch a session the user has open.
  console.log('[INFO] A browser session is already running. Close it to run the replay test.');
  process.exit(0);
}

// Two-screen form: "Your name" -> "Thank you, <name>".
const PAGE = `<!doctype html><html><body>
<main id="s1"><h1>Your name</h1>
  <label>Name <input id="name"></label>
  <button onclick="document.getElementById('s1').hidden=true;
    const s2=document.getElementById('s2'); s2.hidden=false;
    s2.querySelector('p').textContent='Thanks, '+document.getElementById('name').value;">Continue</button>
</main>
<main id="s2" hidden><h1>Thank you</h1><p></p></main>
</body></html>`;

const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${site.address().port}/`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-replay-'));
const csvPath = path.join(dir, 'data.csv');
fs.writeFileSync(csvPath, 'name\nAsha\nRavi\n');

const NAME_STEP = `{
    id: "Your name",
    detect: [() => page.getByRole("heading", { name: "Your name" }).isVisible()],
    command: async () => {
      await page.getByRole("textbox", { name: "Name" }).click();
      await page.getByRole("textbox", { name: "Name" }).fill("{{name}}");
      await page.getByRole("button", { name: "Continue" }).click();
    },
  }`;
const SUCCESS_STEP = `{
    id: "Thank you",
    success: true,
    detect: [() => page.getByRole("heading", { name: "Thank you" }).isVisible()],
    command: async () => {},
  }`;
const writeSteps = (file, steps) =>
  fs.writeFileSync(file, `[\n  ${steps.join(',\n  ')},\n]\n`);

const fullSteps = path.join(dir, 'script.js');
const partialSteps = path.join(dir, 'partial.js');
writeSteps(fullSteps, [NAME_STEP, SUCCESS_STEP]);
writeSteps(partialSteps, [NAME_STEP]);

const snapshot = await startServer('servers/snapshot-server.js');
const execute = await startServer('servers/execute-server.js');
const template = await startServer('servers/template-server.js');

const ok = async (server, name, args) => {
  const res = await server.call(name, args);
  assert.equal(res.isError, false, `${name} failed: ${res.text}`);
  return res.text;
};

try {
  console.log('--- Starting Replay Test ---');
  await ok(template, 'start_run', { csvPath, jsPath: fullSteps, browser: 'brave', url, last_step_rule: 'Thank you page' });

  // Row 1: every page has a saved step, ending at the success step
  await ok(snapshot, 'open_browser', { browser: 'brave', url });
  let result = JSON.parse(await ok(execute, 'replay_steps', { jsPath: fullSteps, csvPath, row: 1, timeoutMs: 3000 }));
  assert.equal(result.status, 'success');
  assert.deepEqual(result.ran, ['Your name', 'Thank you']);
  const text = await ok(execute, 'execute_code', { code: 'await page.locator("#s2 p").textContent()' });
  assert.match(text, /Thanks, Ravi/);
  const state = JSON.parse(await ok(template, 'get_run_state', { jsPath: fullSteps }));
  assert.equal(state.nextRow, 0);
  const progressRow = (row) => JSON.parse(fs.readFileSync(`${fullSteps}.progress.json`, 'utf-8')).rows[row];
  assert.deepEqual(progressRow(1), { status: 'in_progress', steps: ['Your name', 'Thank you'] });
  console.log('1. replay_steps reaches the success step with row data and records its steps');

  // A second open is refused while one is running; close then reopen works
  const again = await snapshot.call('open_browser', { browser: 'brave', url });
  assert.equal(again.isError, true);
  assert.match(again.text, /already running/);
  assert.match(await ok(snapshot, 'close_browser', {}), /Closed brave/);
  assert.equal(await isBrowserRunning(), null);
  console.log('2. close_browser shuts Brave down and clears the session');

  // Replaying a row that is already done leaves its progress untouched
  await ok(template, 'mark_row', { jsPath: fullSteps, row: 1, status: 'done' });
  const doneRow = progressRow(1);
  await ok(snapshot, 'open_browser', { browser: 'brave', url });
  result = JSON.parse(await ok(execute, 'replay_steps', { jsPath: fullSteps, csvPath, row: 1, timeoutMs: 3000 }));
  assert.equal(result.status, 'success');
  assert.deepEqual(progressRow(1), doneRow);
  await ok(snapshot, 'close_browser', {});
  console.log('2b. replaying a finished row does not change its progress');

  // Row 0 with a missing success step: stops at the unknown page with a snapshot
  await ok(snapshot, 'open_browser', { browser: 'brave', url });
  result = JSON.parse(await ok(execute, 'replay_steps', { jsPath: partialSteps, csvPath, row: 0, timeoutMs: 1500 }));
  assert.equal(result.status, 'unknown_page');
  assert.deepEqual(result.ran, ['Your name']);
  assert.match(result.snapshot, /Thank you/);
  console.log('3. replay_steps stops at an unknown page with its snapshot');

  console.log('--- All Replay Tests Passed Successfully! ---');
} finally {
  await snapshot.call('close_browser', {}).catch(() => {});
  snapshot.close();
  execute.close();
  template.close();
  site.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
