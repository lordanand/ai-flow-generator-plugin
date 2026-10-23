import fs from 'node:fs';
import path from 'node:path';

// A run moves through these phases in order; verify/touch only start once every row is settled.
export const PHASES = ['rows', 'verify', 'touch', 'complete'];
const SETTLED = new Set(['done', 'skipped']);
// A steps file is a bare array literal: no `const steps =` and no `module.exports`.
const STEPS_SKELETON = '[]\n';

export function progressPath(jsPath) {
  return `${path.resolve(jsPath)}.progress.json`;
}

export function loadState(jsPath) {
  const file = progressPath(jsPath);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

export function saveState(state) {
  const file = progressPath(state.jsPath);
  const tmp = `${file}.tmp`;
  // Write-then-rename so a crash never leaves a half-written progress file.
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
  return state;
}

function requireState(jsPath) {
  const state = loadState(jsPath);
  if (!state) {
    throw new Error(`No run found for "${jsPath}". Call start_run first.`);
  }
  return state;
}

function rowEntry(state, row) {
  if (!Number.isInteger(row) || row < 0 || row >= state.totalRows) {
    throw new Error(`Row ${row} is out of range (0-${state.totalRows - 1}).`);
  }
  state.rows[row] ??= { status: 'pending', steps: [] };
  return state.rows[row];
}

function unsettledRows(state) {
  const rows = [];
  for (let i = 0; i < state.totalRows; i++) {
    if (!SETTLED.has(state.rows[i]?.status)) rows.push(i);
  }
  return rows;
}

function rowsWithStatus(state, status) {
  return Object.entries(state.rows)
    .filter(([, r]) => r.status === status)
    .map(([i]) => Number(i));
}

/**
 * First row that still needs a pass in the main loop (not done, skipped or failed), or null.
 * Failed rows are left for the end-of-run gate.
 */
export function nextRow(state) {
  for (let i = 0; i < state.totalRows; i++) {
    const status = state.rows[i]?.status;
    if (!SETTLED.has(status) && status !== 'failed') return i;
  }
  return null;
}

/**
 * Whether replayed steps for a row belong in the progress file: only while the run is looping
 * rows and that row isn't already done or skipped. Replays outside a run change nothing.
 */
export function isRecordingRow(state, row) {
  return state?.phase === 'rows' && !SETTLED.has(state.rows[row]?.status);
}

export function summarize(state) {
  return {
    progressFile: progressPath(state.jsPath),
    csvPath: state.csvPath,
    jsPath: state.jsPath,
    browser: state.browser,
    url: state.url,
    lastStepRule: state.lastStepRule,
    phase: state.phase,
    totalRows: state.totalRows,
    nextRow: state.phase === 'rows' ? nextRow(state) : null,
    done: rowsWithStatus(state, 'done').length,
    skipped: rowsWithStatus(state, 'skipped'),
    failed: rowsWithStatus(state, 'failed'),
    profilesLeft: state.browser === 'adspower' ? unusedProfiles(state) : undefined,
    verify: state.verify,
    touch: state.touch,
  };
}

/**
 * Creates the steps file skeleton (if missing or empty) and creates or resumes the progress file.
 * An existing run for a different CSV is refused unless `restart` is set.
 */
export function startRun({ csvPath, jsPath, totalRows, browser, profileIds = [], url, lastStepRule, restart = false }) {
  const absJs = path.resolve(jsPath);
  const absCsv = path.resolve(csvPath);

  if (!fs.existsSync(absJs) || fs.readFileSync(absJs, 'utf-8').trim() === '') {
    fs.mkdirSync(path.dirname(absJs), { recursive: true });
    fs.writeFileSync(absJs, STEPS_SKELETON, 'utf-8');
  }

  const existing = restart ? null : loadState(absJs);
  if (existing && existing.csvPath !== absCsv) {
    throw new Error(
      `A run for "${absJs}" already exists with CSV "${existing.csvPath}". Use the same CSV, or start over with restart: true.`
    );
  }

  const state = existing ?? {
    csvPath: absCsv,
    jsPath: absJs,
    phase: 'rows',
    profiles: [],
    rows: {},
    verify: { status: 'pending', flagged: [] },
    touch: { status: 'pending', outPath: path.join(path.dirname(absJs), `${path.basename(absJs, '.js')}-touch.js`) },
  };

  state.totalRows = totalRows;
  if (state.phase === 'verify' && unsettledRows(state).length) state.phase = 'rows';
  state.browser = browser ?? state.browser;
  state.url = url ?? state.url;
  state.lastStepRule = lastStepRule ?? state.lastStepRule;
  for (const id of profileIds) {
    if (!state.profiles.includes(id)) state.profiles.push(id);
  }
  if (state.browser === 'adspower' && !state.profiles.length) {
    throw new Error('AdsPower needs at least one profile id to start.');
  }
  // Rows interrupted mid-flow restart from the beginning: their browser is gone.
  for (const r of Object.values(state.rows)) {
    if (r.status === 'in_progress') {
      r.status = 'pending';
      r.steps = [];
    }
  }

  saveState(state);
  return { ...summarize(state), resumed: Boolean(existing) };
}

function unusedProfiles(state) {
  const used = new Set(Object.values(state.rows).map((r) => r.profileId).filter(Boolean));
  return state.profiles.filter((id) => !used.has(id));
}

/**
 * Returns the AdsPower profile for a row: the one already assigned to it (a restarted row
 * keeps its profile), else the next unused one from the list. null when the list is used up.
 */
export function nextProfile({ jsPath, row }) {
  const state = requireState(jsPath);
  const entry = rowEntry(state, row);
  if (!entry.profileId) {
    const [next] = unusedProfiles(state);
    if (!next) return { profileId: null, profilesLeft: [] };
    entry.profileId = next;
    saveState(state);
  }
  return { profileId: entry.profileId, profilesLeft: unusedProfiles(state) };
}

export function addProfiles({ jsPath, profileIds }) {
  const state = requireState(jsPath);
  for (const id of profileIds) {
    if (!state.profiles.includes(id)) state.profiles.push(id);
  }
  saveState(state);
  return { profiles: state.profiles, profilesLeft: unusedProfiles(state) };
}

export function markStep({ jsPath, row, stepId }) {
  const state = requireState(jsPath);
  const entry = rowEntry(state, row);
  entry.status = 'in_progress';
  entry.steps.push(stepId);
  saveState(state);
  return entry;
}

/**
 * Sets a row's status. "pending" resets a failed row so the main loop runs it again.
 */
export function markRow({ jsPath, row, status, error }) {
  const state = requireState(jsPath);
  const entry = rowEntry(state, row);
  entry.status = status;
  if (status === 'pending') {
    entry.steps = [];
    delete entry.finishedAt;
  } else {
    entry.finishedAt = new Date().toISOString();
  }
  if (error) entry.error = error;
  else delete entry.error;
  if (state.phase === 'rows' && unsettledRows(state).length === 0) state.phase = 'verify';
  saveState(state);
  return summarize(state);
}

/**
 * Records a finished verify/touch phase. verify is refused until every row is done or skipped.
 */
export function markPhase({ jsPath, phase, flagged, outPath }) {
  const state = requireState(jsPath);

  if (phase === 'verify') {
    const unsettled = unsettledRows(state);
    if (unsettled.length) {
      throw new Error(`Rows not finished yet: ${unsettled.join(', ')}. Finish or skip them before verifying.`);
    }
    state.verify = { status: 'done', flagged: flagged ?? [], finishedAt: new Date().toISOString() };
    state.phase = 'touch';
  } else if (phase === 'touch') {
    if (state.verify?.status !== 'done') {
      throw new Error('Run verify before the touch conversion.');
    }
    state.touch = { status: 'done', outPath: outPath ?? state.touch.outPath, finishedAt: new Date().toISOString() };
    state.phase = 'complete';
  } else {
    throw new Error(`Unknown phase "${phase}". Use "verify" or "touch".`);
  }

  saveState(state);
  return summarize(state);
}

export function getRunState({ jsPath }) {
  return summarize(requireState(jsPath));
}
