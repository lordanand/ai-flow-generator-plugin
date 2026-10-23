import fs from 'node:fs';
import { renderTemplate } from './template.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const POLL_MS = 250;
// Safety stop so a flow that loops between pages can't replay forever.
const MAX_STEPS_PER_ROW = 200;

/**
 * Evaluates steps-file source — a bare array literal `[ {...}, ... ]` — with `page` bound as a free
 * variable. Older files wrapped as `const steps = [...]; module.exports = steps;` still load.
 * Same trust model as execute_code: the file is the user's own script.
 */
export function evaluateSteps(code, page) {
  const module = { exports: {} };
  const body = /\bmodule\.exports\b/.test(code)
    ? `${code}\nreturn module.exports;`
    : `return (${code.trim().replace(/;$/, '')}\n);`;
  const fn = new Function('page', 'module', 'exports', body);
  const steps = fn(page, module, module.exports);
  if (!Array.isArray(steps)) {
    throw new Error('Steps file must be an array of step objects: [ { id, detect, command }, ... ]');
  }
  return steps;
}

/**
 * Loads a steps file. With `row`, {{header}} placeholders are filled from that CSV row first.
 */
export function loadStepsFile(jsPath, { page = {}, row } = {}) {
  const source = fs.readFileSync(jsPath, 'utf-8');
  const code = row ? renderTemplate(source, row) : source;
  return evaluateSteps(code, page);
}

/**
 * Per-step summary used to check a steps file after verify/touch rewrites it.
 */
export function inspectSteps(steps) {
  return steps.map((step) => {
    const body = String(step.command ?? '');
    return {
      id: step.id,
      success: step.success === true,
      detectCount: Array.isArray(step.detect) ? step.detect.length : 0,
      // Skip `el.click()`: it runs inside the touch converter's helper (docs/touch-converter.md), not on a locator.
      clickCalls: (body.match(/(?<!\bel)\.(click|tap)\(/g) ?? []).length,
    };
  });
}

async function isDetected(step) {
  for (const check of step.detect ?? []) {
    try {
      if (await check()) return true;
    } catch {
      // A detector whose element is missing just means "not this page".
    }
  }
  return false;
}

async function findStep(steps, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    for (const step of steps) {
      if (await isDetected(step)) return step;
    }
    await sleep(POLL_MS);
  } while (Date.now() < deadline);
  return null;
}

async function waitUntilGone(step, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isDetected(step))) return true;
    await sleep(POLL_MS);
  }
  return false;
}

/**
 * Runs saved steps against the live page until the `success: true` step runs, an unknown page
 * shows, a step stays on screen after its command, or a command throws.
 * `onStep(id)` is called after each step's command completes.
 */
export async function replaySteps({ page, steps, timeoutMs = 8000, onStep = () => {} }) {
  const ran = [];
  const snapshot = () => page.ariaSnapshot().catch((err) => `(snapshot failed: ${err.message})`);

  for (let i = 0; i < MAX_STEPS_PER_ROW; i++) {
    const step = await findStep(steps, timeoutMs);
    if (!step) {
      return { status: 'unknown_page', ran, url: page.url(), snapshot: await snapshot() };
    }

    try {
      await step.command();
    } catch (err) {
      return { status: 'error', stepId: step.id, error: err.message, ran, url: page.url(), snapshot: await snapshot() };
    }
    ran.push(step.id);
    await onStep(step.id);

    if (step.success === true) {
      return { status: 'success', ran, url: page.url() };
    }
    if (!(await waitUntilGone(step, timeoutMs))) {
      return { status: 'stuck', stepId: step.id, ran, url: page.url(), snapshot: await snapshot() };
    }
  }

  return { status: 'error', error: `Stopped after ${MAX_STEPS_PER_ROW} steps; the flow may be looping.`, ran, url: page.url() };
}
