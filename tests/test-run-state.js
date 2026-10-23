import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './mcp-client.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-run-state-'));
const csvPath = path.join(dir, 'data.csv');
const otherCsv = path.join(dir, 'other.csv');
const jsPath = path.join(dir, 'script.js');
const stepsFixture = path.join(dir, 'fixture.js');

fs.writeFileSync(csvPath, 'name,email\nAsha,a@example.com\nRavi,r@example.com\nMeera,m@example.com\n');
fs.writeFileSync(otherCsv, 'name\nX\n');
fs.writeFileSync(
  stepsFixture,
  `[
  {
    id: "Your name",
    detect: [() => page.getByRole("heading", { name: "Your name" }).isVisible()],
    command: async () => {
      await page.getByRole("textbox", { name: "Name" }).click();
      await page.getByRole("textbox", { name: "Name" }).fill("{{name}}");
      await page.getByRole("button", { name: "Continue" }).click();
    },
  },
  {
    id: "Thank you",
    success: true,
    detect: [() => page.getByRole("heading", { name: "Thank you" }).isVisible()],
    command: async () => {},
  },
]
`
);

const template = await startServer('servers/template-server.js');
const execute = await startServer('servers/execute-server.js');

const json = async (server, name, args) => {
  const res = await server.call(name, args);
  assert.equal(res.isError, false, `${name} failed: ${res.text}`);
  return JSON.parse(res.text);
};
const expectError = async (server, name, args, pattern) => {
  const res = await server.call(name, args);
  assert.equal(res.isError, true, `${name} should fail`);
  assert.match(res.text, pattern);
};

try {
  console.log('--- Starting Run-State Test ---');
  const base = { csvPath, jsPath, browser: 'adspower', url: 'example.com', last_step_rule: 'Thank you page' };

  // AdsPower needs at least one profile id
  await expectError(template, 'start_run', base, /profile id/);

  let state = await json(template, 'start_run', { ...base, profile_ids: ['p1', 'p2'] });
  assert.equal(state.totalRows, 3);
  assert.equal(state.nextRow, 0);
  assert.equal(state.resumed, false);
  assert.equal(fs.readFileSync(jsPath, 'utf-8'), '[]\n', 'new steps file is a bare empty array');
  assert.ok(fs.existsSync(`${jsPath}.progress.json`));
  console.log('1. start_run creates skeleton + progress file');

  // Profiles: in order, sticky per row, null when used up, refilled by add_profiles
  assert.equal((await json(template, 'next_profile', { jsPath, row: 0 })).profileId, 'p1');
  assert.equal((await json(template, 'next_profile', { jsPath, row: 0 })).profileId, 'p1');
  assert.equal((await json(template, 'next_profile', { jsPath, row: 1 })).profileId, 'p2');
  assert.equal((await json(template, 'next_profile', { jsPath, row: 2 })).profileId, null);
  await json(template, 'add_profiles', { jsPath, profile_ids: ['p3'] });
  assert.equal((await json(template, 'next_profile', { jsPath, row: 2 })).profileId, 'p3');
  await expectError(template, 'next_profile', { jsPath, row: 3 }, /out of range/);
  console.log('2. next_profile / add_profiles hand out ids per row');

  // Interrupted row restarts on resume, keeping its profile
  await json(template, 'mark_step', { jsPath, row: 0, stepId: 'Your name' });
  await expectError(template, 'mark_phase', { jsPath, phase: 'verify' }, /Rows not finished/);
  state = await json(template, 'start_run', base);
  assert.equal(state.resumed, true);
  assert.equal(state.nextRow, 0);
  assert.equal((await json(template, 'next_profile', { jsPath, row: 0 })).profileId, 'p1');
  await expectError(template, 'start_run', { ...base, csvPath: otherCsv }, /already exists/);
  console.log('3. resume restarts the interrupted row; other CSV refused');

  // Failed rows hold back the finishing phases until retried or skipped
  await json(template, 'mark_row', { jsPath, row: 0, status: 'done' });
  await json(template, 'mark_row', { jsPath, row: 1, status: 'failed', error: 'Site rejected the form' });
  state = await json(template, 'mark_row', { jsPath, row: 2, status: 'done' });
  assert.equal(state.nextRow, null);
  assert.deepEqual(state.failed, [1]);
  assert.equal(state.phase, 'rows');
  await expectError(template, 'mark_phase', { jsPath, phase: 'verify' }, /Rows not finished yet: 1/);

  state = await json(template, 'mark_row', { jsPath, row: 1, status: 'pending' });
  assert.equal(state.nextRow, 1);
  state = await json(template, 'mark_row', { jsPath, row: 1, status: 'skipped' });
  assert.equal(state.phase, 'verify');
  console.log('4. failed row blocks verify until retried/skipped');

  await expectError(template, 'mark_phase', { jsPath, phase: 'touch' }, /verify before/);
  state = await json(template, 'mark_phase', { jsPath, phase: 'verify', flagged: ['A vs B: shared Continue button'] });
  assert.equal(state.phase, 'touch');
  assert.deepEqual(state.verify.flagged, ['A vs B: shared Continue button']);
  state = await json(template, 'mark_phase', { jsPath, phase: 'touch' });
  assert.equal(state.phase, 'complete');
  assert.equal(state.touch.outPath, path.join(dir, 'script-touch.js'));
  console.log('5. verify -> touch -> complete');

  // restart wipes progress but keeps the steps file
  fs.writeFileSync(jsPath, fs.readFileSync(stepsFixture));
  state = await json(template, 'start_run', { ...base, restart: true, profile_ids: ['p9'] });
  assert.equal(state.resumed, false);
  assert.equal(state.done, 0);
  assert.equal(state.phase, 'rows');
  assert.match(fs.readFileSync(jsPath, 'utf-8'), /Your name/);
  console.log('6. restart resets progress, keeps steps file');

  // inspect_steps loads a steps file without a browser
  const inspected = await json(execute, 'inspect_steps', { jsPath: stepsFixture });
  assert.equal(inspected.count, 2);
  assert.deepEqual(inspected.steps, [
    { id: 'Your name', success: false, detectCount: 1, clickCalls: 2 },
    { id: 'Thank you', success: true, detectCount: 1, clickCalls: 0 }
  ]);
  fs.writeFileSync(path.join(dir, 'broken.js'), '[ {');
  await expectError(execute, 'inspect_steps', { jsPath: path.join(dir, 'broken.js') }, /Error/);
  console.log('7. inspect_steps lists steps and rejects a broken file');

  // The touch converter's helper calls el.click() in the page; that is not a leftover pointer click
  const touchFixture = path.join(dir, 'touch.js');
  fs.writeFileSync(
    touchFixture,
    `[
  {
    id: "Your name",
    detect: [() => page.getByRole("heading", { name: "Your name" }).isVisible()],
    command: async () => {
      const touch = async (locator) => {
        const el = await locator.elementHandle();
        await page.evaluate((el) => {
          el.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true }));
          el.click();
        }, el);
      };
      await touch(page.getByRole("button", { name: "Continue" }));
      await page.getByRole("button", { name: "Skip" }).tap();
    },
  },
]
`
  );
  const touched = await json(execute, 'inspect_steps', { jsPath: touchFixture });
  assert.equal(touched.steps[0].clickCalls, 1, 'only the leftover .tap() should count');
  console.log('8. inspect_steps ignores the touch helper\'s own el.click()');

  // Older files that still use the `const steps = [...]; module.exports = steps;` wrapper keep loading
  const legacyFixture = path.join(dir, 'legacy.js');
  fs.writeFileSync(
    legacyFixture,
    'const steps = [\n  { id: "Old", detect: [() => true], command: async () => {} },\n];\n\nmodule.exports = steps;\n'
  );
  const legacy = await json(execute, 'inspect_steps', { jsPath: legacyFixture });
  assert.deepEqual(legacy.steps.map((s) => s.id), ['Old']);
  fs.writeFileSync(path.join(dir, 'not-array.js'), '({ id: "x" })');
  await expectError(execute, 'inspect_steps', { jsPath: path.join(dir, 'not-array.js') }, /array/);
  console.log('9. legacy wrapped files still load; a non-array is rejected');

  console.log('--- All Run-State Tests Passed Successfully! ---');
} finally {
  template.close();
  execute.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
