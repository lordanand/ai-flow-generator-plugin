// Checks everything the plugin needs before a run: Node.js, npm, the npm packages in
// package.json, and optionally the browser. Uses only Node built-ins, so it works before
// `npm install`. Prints a JSON report; exit code 0 = ready, 1 = something missing, 2 = bad usage.
//
// Usage: node scripts/check-deps.js [--browser brave|adspower] [--root <plugin folder>]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAVE_PATH, ADSPOWER_API_URLS } from '../lib/config.js';

const BROWSERS = ['brave', 'adspower'];
const ADSPOWER_TIMEOUT_MS = 3000;

function usage(message) {
  process.stderr.write(`${message}\nUsage: node scripts/check-deps.js [--browser brave|adspower] [--root <plugin folder>]\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = { root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), browser: null };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    if (argv[i] === '--root' && value) {
      args.root = path.resolve(value);
      i++;
    } else if (argv[i] === '--browser' && BROWSERS.includes(value)) {
      args.browser = value;
      i++;
    } else {
      usage(`Unknown or incomplete argument: ${argv[i]}${argv[i] === '--browser' ? ` (use --browser ${BROWSERS.join('|')})` : ''}`);
    }
  }
  return args;
}

function parseVersion(version) {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(version).trim());
  return match ? match.slice(1, 4).map((n) => Number(n ?? 0)) : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Supports the range forms package.json uses here: ^x.y.z, ~x.y.z, >=x.y.z and exact x.y.z.
 * Anything else counts as satisfied once the package is present.
 */
function satisfies(installed, range) {
  const have = parseVersion(installed);
  const match = /^(\^|~|>=)?\s*(\d+(?:\.\d+){0,2})$/.exec(String(range).trim());
  if (!have || !match) return true;
  const [, op, base] = match;
  const want = parseVersion(base);
  if (op === '>=') return compare(have, want) >= 0;
  if (op === '~') return have[0] === want[0] && have[1] === want[1] && compare(have, want) >= 0;
  if (op === '^') {
    if (compare(have, want) < 0) return false;
    if (want[0] > 0) return have[0] === want[0];
    if (want[1] > 0) return have[0] === 0 && have[1] === want[1];
    return compare(have, want) === 0;
  }
  return compare(have, want) === 0;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function checkNpm() {
  // npm is npm.cmd on Windows, which needs a shell; the command is a fixed string.
  const result = spawnSync('npm --version', { encoding: 'utf-8', shell: true });
  const version = result.status === 0 ? result.stdout.trim() : null;
  return { found: Boolean(version), version };
}

function checkPackages(root, dependencies) {
  return Object.entries(dependencies).map(([name, required]) => {
    const installed = readJson(path.join(root, 'node_modules', name, 'package.json'))?.version ?? null;
    return { name, required, installed, ok: Boolean(installed) && satisfies(installed, required) };
  });
}

async function checkAdsPower() {
  if (typeof fetch !== 'function') {
    return { type: 'adspower', apiUrl: null, ok: false };
  }
  for (const apiUrl of ADSPOWER_API_URLS) {
    try {
      await fetch(`${apiUrl}/status`, { signal: AbortSignal.timeout(ADSPOWER_TIMEOUT_MS) });
      return { type: 'adspower', apiUrl, ok: true };
    } catch {
      // Not listening at this address; try the next one.
    }
  }
  return { type: 'adspower', apiUrl: null, ok: false };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pkg = readJson(path.join(args.root, 'package.json'));
  if (!pkg) usage(`No package.json found in ${args.root}`);

  const requiredNode = pkg.engines?.node ?? null;
  const node = {
    version: process.versions.node,
    required: requiredNode,
    ok: requiredNode ? satisfies(process.versions.node, requiredNode) : true,
  };
  const npm = checkNpm();
  const packages = checkPackages(args.root, pkg.dependencies ?? {});

  let browser = null;
  if (args.browser === 'brave') {
    browser = { type: 'brave', path: BRAVE_PATH, ok: fs.existsSync(BRAVE_PATH) };
  } else if (args.browser === 'adspower') {
    browser = await checkAdsPower();
  }

  const fix = [];
  if (!node.ok) {
    fix.push(`Install Node.js ${requiredNode} (the LTS version from https://nodejs.org), then open a new terminal.`);
  }
  if (packages.some((p) => !p.ok)) {
    const command = fs.existsSync(path.join(args.root, 'package-lock.json')) ? 'npm ci --omit=dev' : 'npm install --omit=dev';
    fix.push(`${npm.found ? '' : 'Install npm (it comes with Node.js), then '}run "${command}" in ${args.root}`);
  }
  if (browser?.type === 'brave' && !browser.ok) {
    fix.push(`Install Brave, or set BRAVE_PATH to brave.exe (looked for ${BRAVE_PATH}).`);
  }
  if (browser?.type === 'adspower' && !browser.ok) {
    fix.push('Start AdsPower and turn on its Local API (Settings > Local API), or set ADSPOWER_API_URL.');
  }

  const report = {
    ok: fix.length === 0,
    pluginRoot: args.root,
    node,
    npm,
    packages,
    ...(browser && { browser }),
    fix,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}

main();
