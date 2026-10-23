import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve('scripts/check-deps.js');

// Async: the AdsPower check needs this process's event loop free to answer the fake API.
function runCheck(args = [], env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => {
      let report = null;
      try {
        report = JSON.parse(stdout);
      } catch {}
      resolve({ status, report, stderr });
    });
  });
}

function makeRoot(pkg, installed = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-deps-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  for (const [name, version] of Object.entries(installed)) {
    const dir = path.join(root, 'node_modules', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
  }
  return root;
}

const roots = [];
try {
  console.log('--- Starting Dependency Check Test ---');

  // 1. This plugin, as installed here: everything present
  let res = await runCheck();
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.report.ok, true);
  assert.equal(res.report.node.ok, true);
  assert.equal(res.report.npm.found, true);
  assert.ok(res.report.packages.length >= 5);
  assert.ok(res.report.packages.every((p) => p.ok && p.installed));
  assert.deepEqual(res.report.fix, []);
  console.log('1. plugin root: Node, npm and all packages found');

  // 2. Nothing installed and Node too old: both reported with fixes
  const empty = makeRoot({ engines: { node: '>=999' }, dependencies: { 'left-pad': '^1.0.0' } });
  roots.push(empty);
  res = await runCheck(['--root', empty]);
  assert.equal(res.status, 1);
  assert.equal(res.report.ok, false);
  assert.equal(res.report.node.ok, false);
  assert.equal(res.report.node.required, '>=999');
  assert.deepEqual(res.report.packages, [{ name: 'left-pad', required: '^1.0.0', installed: null, ok: false }]);
  assert.ok(res.report.fix.some((f) => /Node\.js/.test(f)));
  assert.ok(res.report.fix.some((f) => /npm install/.test(f)));
  console.log('2. missing package and old Node are reported with fixes');

  // 3. Installed versions are checked against the range
  const versions = makeRoot(
    { dependencies: { 'too-old': '^1.2.0', 'just-right': '^1.2.0', 'zero-major': '^0.18.5', exact: '2.0.0' } },
    { 'too-old': '1.1.9', 'just-right': '1.9.0', 'zero-major': '0.19.0', exact: '2.0.0' }
  );
  roots.push(versions);
  res = await runCheck(['--root', versions]);
  const ok = Object.fromEntries(res.report.packages.map((p) => [p.name, p.ok]));
  assert.deepEqual(ok, { 'too-old': false, 'just-right': true, 'zero-major': false, exact: true });
  console.log('3. installed versions are checked against package.json ranges');

  // 4. A lockfile switches the fix to npm ci
  fs.writeFileSync(path.join(empty, 'package-lock.json'), '{}');
  res = await runCheck(['--root', empty]);
  assert.ok(res.report.fix.some((f) => /npm ci/.test(f)));
  console.log('4. lockfile present: fix uses npm ci');

  // 5. Brave: found or not, from BRAVE_PATH
  res = await runCheck(['--browser', 'brave'], { BRAVE_PATH: path.join(empty, 'no-brave.exe') });
  assert.equal(res.status, 1);
  assert.deepEqual(res.report.browser, { type: 'brave', path: path.join(empty, 'no-brave.exe'), ok: false });
  assert.ok(res.report.fix.some((f) => /Brave/.test(f)));
  res = await runCheck(['--browser', 'brave'], { BRAVE_PATH: path.join(empty, 'package.json') });
  assert.equal(res.report.browser.ok, true);
  assert.equal(res.status, 0);
  console.log('5. Brave executable found / missing');

  // 6. AdsPower: Local API reachable
  const api = http.createServer((req, res2) => {
    res2.writeHead(200, { 'content-type': 'application/json' });
    res2.end('{"code":0,"msg":"success"}');
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const apiUrl = `http://127.0.0.1:${api.address().port}`;
  res = await runCheck(['--browser', 'adspower'], { ADSPOWER_API_URL: apiUrl });
  api.close();
  assert.deepEqual(res.report.browser, { type: 'adspower', apiUrl, ok: true });
  console.log('6. AdsPower Local API reachable');

  // 7. Bad arguments are a usage error
  res = await runCheck(['--browser', 'firefox']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--browser/);
  console.log('7. unknown --browser value is a usage error');

  console.log('--- All Dependency Check Tests Passed Successfully! ---');
} finally {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
}
