import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import util from 'node:util';
import { chromium } from 'playwright-core';
import { getPage, getBrowser } from '../lib/browser.js';
import { resolvePath, readRows } from '../lib/template.js';
import { loadStepsFile, inspectSteps, replaySteps } from '../lib/steps-file.js';
import { loadState, markStep, isRecordingRow } from '../lib/run-state.js';

const server = new McpServer({
  name: 'brave-execute-server',
  version: '1.0.0'
});

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/**
 * Builds an async function from multiline code with intelligent return behavior:
 * 1. Tries returning as a direct expression (e.g. `await page.title()`)
 * 2. If no `return` keyword is found, wraps the last line in `return (...)`
 * 3. Falls back to raw execution block
 */
function buildFunction(code) {
  const trimmed = code.trim();

  // 1. Direct expression
  try {
    return new AsyncFunction('page', 'context', 'browser', 'playwright', 'console', `return (${trimmed});`);
  } catch {}

  // 2. Automatic return of the last expression if no explicit return
  if (!/\breturn\b/.test(trimmed)) {
    const lines = trimmed.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim().replace(/;$/, '');
      if (line) {
        const candidateLines = [...lines];
        candidateLines[i] = `return (${line});`;
        try {
          return new AsyncFunction('page', 'context', 'browser', 'playwright', 'console', candidateLines.join('\n'));
        } catch {}
        break;
      }
    }
  }

  // 3. Fallback: standard statements block
  return new AsyncFunction('page', 'context', 'browser', 'playwright', 'console', code);
}

function formatResult(val) {
  if (val === undefined) return 'undefined';
  if (typeof val === 'string') return val;
  return util.inspect(val, { depth: 4, colors: false, maxArrayLength: 100 });
}

server.registerTool(
  'execute_code',
  {
    description: 'Execute arbitrary multiline JavaScript / Playwright code against the active Brave browser page. The code has access to `page` (current active Playwright Page), `context`, `browser`, `playwright` ({ chromium }), and `console`.',
    inputSchema: {
      code: z.string().describe('Multiline JavaScript code to execute. Can use await, page.locator(), page.click(), page.evaluate(), etc.')
    }
  },
  async ({ code }) => {
    const logs = [];
    const customConsole = {
      log: (...args) => {
        logs.push(args.map(a => typeof a === 'object' ? util.inspect(a, { depth: 3, colors: false }) : String(a)).join(' '));
      },
      info: (...args) => {
        logs.push('[INFO] ' + args.map(a => typeof a === 'object' ? util.inspect(a, { depth: 3, colors: false }) : String(a)).join(' '));
      },
      warn: (...args) => {
        logs.push('[WARN] ' + args.map(a => typeof a === 'object' ? util.inspect(a, { depth: 3, colors: false }) : String(a)).join(' '));
      },
      error: (...args) => {
        logs.push('[ERROR] ' + args.map(a => typeof a === 'object' ? util.inspect(a, { depth: 3, colors: false }) : String(a)).join(' '));
      }
    };

    try {
      const browser = await getBrowser();
      const page = await getPage();

      if (!browser || !page) {
        return {
          content: [{ type: 'text', text: 'No active page is detected' }],
          isError: true
        };
      }

      const context = page.context();
      const fn = buildFunction(code);
      const result = await fn(page, context, browser, { chromium }, customConsole);

      let output = '';
      if (logs.length > 0) {
        output += `Console Output:\n${logs.join('\n')}\n\n`;
      }
      if (result !== undefined) {
        output += `Result:\n${formatResult(result)}`;
      } else if (logs.length === 0) {
        output += 'Executed successfully (no return value).';
      }

      return {
        content: [{ type: 'text', text: output.trim() }]
      };
    } catch (err) {
      let output = '';
      if (logs.length > 0) {
        output += `Console Output:\n${logs.join('\n')}\n\n`;
      }
      output += `Error: ${err.message}\n${err.stack || ''}`;
      return {
        content: [{ type: 'text', text: output.trim() }],
        isError: true
      };
    }
  }
);

function textResult(value, isError = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

server.registerTool(
  'replay_steps',
  {
    description: 'Replay the saved steps in a steps JS file against the live page, filled with one CSV row. Runs until the `success: true` step runs (status "success"), no saved step matches the page ("unknown_page", with ARIA snapshot), a step\'s page does not go away after its command ("stuck"), or a command throws ("error"). Completed step ids are recorded in the run\'s progress file only while the run is looping rows and this row is not already done or skipped.',
    inputSchema: {
      jsPath: z.string().describe('Path to the steps JS file.'),
      csvPath: z.string().describe('Path to the CSV/Excel data file.'),
      row: z.number().int().min(0).describe('Zero-based CSV row index.'),
      timeoutMs: z.number().int().min(500).default(8000).describe('How long to wait for a page to match a step, or to leave it.')
    }
  },
  async ({ jsPath, csvPath, row, timeoutMs }) => {
    const jsFile = resolvePath(jsPath);
    const csvFile = resolvePath(csvPath);
    if (!jsFile) return textResult(`Error: Steps file not found: "${jsPath}".`, true);
    if (!csvFile) return textResult(`Error: CSV file not found: "${csvPath}".`, true);

    try {
      const rows = readRows(csvFile);
      if (row >= rows.length) {
        return textResult(`Error: Requested row index ${row} exceeds available rows (${rows.length}).`, true);
      }
      const page = await getPage();
      if (!page) return textResult('No active page is detected', true);

      const steps = loadStepsFile(jsFile, { page, row: rows[row] });
      const tracked = isRecordingRow(loadState(jsFile), row);
      const result = await replaySteps({
        page,
        steps,
        timeoutMs,
        onStep: (stepId) => tracked && markStep({ jsPath: jsFile, row, stepId })
      });
      return textResult(result);
    } catch (err) {
      return textResult(`Error: ${err.message}`, true);
    }
  }
);

server.registerTool(
  'inspect_steps',
  {
    description: 'Load a steps JS file without a browser and list each step: id, success flag, number of detect checks, and remaining .click()/.tap() calls. Use to check the file still loads after editing it.',
    inputSchema: { jsPath: z.string().describe('Path to the steps JS file.') }
  },
  async ({ jsPath }) => {
    const jsFile = resolvePath(jsPath);
    if (!jsFile) return textResult(`Error: Steps file not found: "${jsPath}".`, true);
    try {
      const steps = inspectSteps(loadStepsFile(jsFile));
      return textResult({ jsPath: jsFile, count: steps.length, steps });
    } catch (err) {
      return textResult(`Error: ${err.message}`, true);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
