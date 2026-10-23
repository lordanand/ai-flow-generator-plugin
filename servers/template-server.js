import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import { resolvePath, readRows, renderTemplate } from '../lib/template.js';
import {
  startRun,
  nextProfile,
  addProfiles,
  markStep,
  markRow,
  markPhase,
  getRunState
} from '../lib/run-state.js';

const server = new McpServer({
  name: 'csv-template-server',
  version: '1.0.0'
});

async function handleTemplate({ filePath, csvPath, code, codes, row = 0 }) {
  const targetPath = filePath || csvPath;
  const targetCode = code || codes;

  if (!targetPath) {
    return { content: [{ type: 'text', text: 'Error: "filePath" parameter is required.' }], isError: true };
  }
  if (!targetCode) {
    return { content: [{ type: 'text', text: 'Error: "code" parameter is required.' }], isError: true };
  }

  const file = resolvePath(targetPath);
  if (!file) {
    return {
      content: [{ type: 'text', text: `Error: File not found: "${targetPath}".` }],
      isError: true
    };
  }

  try {
    const rows = readRows(file);

    if (!rows.length) {
      return { content: [{ type: 'text', text: `Error: No data rows found in "${file}".` }], isError: true };
    }

    if (row >= rows.length) {
      return {
        content: [{ type: 'text', text: `Error: Requested row index ${row} exceeds available rows (${rows.length}).` }],
        isError: true
      };
    }

    const codeStr = Array.isArray(targetCode) ? targetCode.join('\n') : targetCode;
    const output = renderTemplate(codeStr, rows[row]);

    return { content: [{ type: 'text', text: output }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Template error: ${err.message}` }],
      isError: true
    };
  }
}

const toolSchema = {
  description: 'Reads CSV/Excel data using xlsx and substitutes {{key}} placeholders in code using Handlebars.',
  inputSchema: {
    filePath: z.string().optional().describe('Path to CSV or Excel file (e.g. "D:/work/data.csv").'),
    csvPath: z.string().optional().describe('Alias for filePath.'),
    code: z.union([z.string(), z.array(z.string())]).optional().describe('Multiline code string or array of code strings containing {{key}} placeholders.'),
    codes: z.array(z.string()).optional().describe('Alias for code (array of strings).'),
    row: z.number().int().min(0).default(0).describe('Zero-based row index to use (default 0).')
  }
};

server.registerTool('replace_template', toolSchema, handleTemplate);
server.registerTool('fill_template', toolSchema, handleTemplate);

// Run-state tools: progress lives in "<jsPath>.progress.json" so a stopped run can resume.
function jsonResult(fn) {
  return async (args) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await fn(args), null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  };
}

// The steps file may not exist yet, so fall back to resolving against cwd.
const resolveJs = (jsPath) => resolvePath(jsPath) ?? path.resolve(jsPath);
const jsPathSchema = z.string().describe('Path to the steps JS file (e.g. "D:/work/script.js"). Prefer an absolute path.');
const rowSchema = z.number().int().min(0).describe('Zero-based CSV row index.');

server.registerTool(
  'start_run',
  {
    description: 'Start or resume a recorder run over every CSV row. Creates the steps JS file skeleton if missing and the progress file next to it. Returns totalRows, nextRow, done/failed rows and phase.',
    inputSchema: {
      csvPath: z.string().describe('Path to the CSV/Excel data file.'),
      jsPath: jsPathSchema,
      browser: z.enum(['brave', 'adspower']).describe('Browser to open for each row.'),
      profile_ids: z.array(z.string().min(1)).optional().describe('AdsPower profile ids, used one per row in order.'),
      url: z.string().min(1).describe('URL to open at the start of every row.'),
      last_step_rule: z.string().min(1).describe('The user\'s rule for when the flow is finished (which page/step is the last one).'),
      restart: z.boolean().default(false).describe('Discard existing progress and start from row 0 (the steps file is kept).')
    }
  },
  jsonResult(({ csvPath, jsPath, browser, profile_ids, url, last_step_rule, restart }) => {
    const csvFile = resolvePath(csvPath);
    if (!csvFile) throw new Error(`File not found: "${csvPath}".`);
    const totalRows = readRows(csvFile).length;
    if (!totalRows) throw new Error(`No data rows found in "${csvFile}".`);
    return startRun({
      csvPath: csvFile,
      jsPath: resolveJs(jsPath),
      totalRows,
      browser,
      profileIds: profile_ids,
      url,
      lastStepRule: last_step_rule,
      restart
    });
  })
);

server.registerTool(
  'next_profile',
  {
    description: 'AdsPower only: get the profile id for a row (keeps a restarted row\'s profile, otherwise takes the next unused one). Returns profileId null when no ids are left — then ask the user and call add_profiles.',
    inputSchema: { jsPath: jsPathSchema, row: rowSchema }
  },
  jsonResult(({ jsPath, row }) => nextProfile({ jsPath: resolveJs(jsPath), row }))
);

server.registerTool(
  'add_profiles',
  {
    description: 'AdsPower only: add more profile ids to the run.',
    inputSchema: { jsPath: jsPathSchema, profile_ids: z.array(z.string().min(1)).min(1) }
  },
  jsonResult(({ jsPath, profile_ids }) => addProfiles({ jsPath: resolveJs(jsPath), profileIds: profile_ids }))
);

server.registerTool(
  'mark_step',
  {
    description: 'Record that a step id completed for a row (marks the row in progress).',
    inputSchema: { jsPath: jsPathSchema, row: rowSchema, stepId: z.string().min(1) }
  },
  jsonResult(({ jsPath, row, stepId }) => markStep({ jsPath: resolveJs(jsPath), row, stepId }))
);

server.registerTool(
  'mark_row',
  {
    description: 'Set a row\'s status: done (reached the success step), failed (with error), skipped (user chose to skip), or pending (retry a failed row).',
    inputSchema: {
      jsPath: jsPathSchema,
      row: rowSchema,
      status: z.enum(['done', 'failed', 'skipped', 'pending']),
      error: z.string().optional()
    }
  },
  jsonResult(({ jsPath, row, status, error }) => markRow({ jsPath: resolveJs(jsPath), row, status, error }))
);

server.registerTool(
  'mark_phase',
  {
    description: 'Record a finished end-of-run phase. "verify" is refused until every row is done or skipped; "touch" needs verify first.',
    inputSchema: {
      jsPath: jsPathSchema,
      phase: z.enum(['verify', 'touch']),
      flagged: z.array(z.string()).optional().describe('verify: detector conflicts left for manual review.'),
      outPath: z.string().optional().describe('touch: path of the touch script written.')
    }
  },
  jsonResult(({ jsPath, phase, flagged, outPath }) =>
    markPhase({ jsPath: resolveJs(jsPath), phase, flagged, outPath: outPath && path.resolve(outPath) })
  )
);

server.registerTool(
  'get_run_state',
  {
    description: 'Summary of a run: phase, next row, done/failed/skipped rows, AdsPower profiles left, verify/touch status.',
    inputSchema: { jsPath: jsPathSchema }
  },
  jsonResult(({ jsPath }) => getRunState({ jsPath: resolveJs(jsPath) }))
);

const transport = new StdioServerTransport();
await server.connect(transport);
