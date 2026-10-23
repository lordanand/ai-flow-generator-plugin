---
name: run-flow-recorder
description: Record and replay a multi-step web form over every row of a CSV in Brave or AdsPower, saving each verified step to a JS steps file and progress to a resumable file, then verify detectors and build a touch-event copy of the script.
argument-hint: "[csv] [js] [brave | adspower <profile_id...>] [url]"
disable-model-invocation: true
---

# Run Flow Recorder

Fill a multi-step web form once per CSV row. Saved steps are replayed automatically; you record a new step only when a page has no saved step. Progress is saved after every step and row so the run can resume. When every row is finished, verify the detectors and write the touch-event script.

Arguments given: `$ARGUMENTS`

## Files you follow

All paths are relative to the plugin root (two folders up from this skill):

- `docs/rules.md` — locator priority, allowed actions, interaction rules. Read it before recording any step and follow it for every locator and action.
- `docs/verify-detector.md` — the Verify Detectors prompt (phase 5).
- `docs/touch-converter.md` — the Pointer → Touch Converter prompt (phase 6).

## Tools

- Browser: `open_browser`, `close_browser`, `get_page_snapshot` (brave-snapshot server).
- Code: `execute_code`, `replay_steps`, `inspect_steps` (brave-execute server).
- Data and progress: `replace_template`, `start_run`, `next_profile`, `add_profiles`, `mark_step`, `mark_row`, `mark_phase`, `get_run_state` (csv-template server).

Always pass absolute paths for `csvPath` and `jsPath`.

## 1. Collect inputs

Take what you can from the arguments, then ask in chat for each missing item, one message for all of them:

1. **CSV file path** — the data; every row is one run of the form.
2. **JS steps file path** — where steps are saved (for example `D:/work/script.js`). It is created if it doesn't exist.
3. **Browser** — `brave` or `adspower`.
   - AdsPower needs a **profile id**. The user may give one id or a list; each row uses the next unused id. At least one id is required to start.
4. **URL** — opened at the start of every row.
5. **Last-step rule** — ask: "Which page or step is the last one, so I know the form is finished?" Using up all the row's data does not prove the form is done; only this rule does.

Then call `get_run_state` for the JS path. If a run exists, show the user its phase, rows done / total, and failed rows, and ask: **resume** or **start over**. Start over passes `restart: true` to `start_run` (the steps file is kept).

## 2. Start the run

Call `start_run` with all inputs. It returns `totalRows`, `nextRow`, `phase`, `failed`. Continue from the phase it reports:

- `rows` → phase 3 from `nextRow` (or phase 4 if `nextRow` is null).
- `verify` → phase 5. `touch` → phase 6. `complete` → tell the user the run is already finished and stop.

## 3. Row loop — every row, first to last, one fresh browser per row

Repeat for `row = nextRow` until `get_run_state` returns `nextRow: null`:

1. **Profile (AdsPower only).** Call `next_profile`. If `profileId` is null, ask the user for the next profile id now, call `add_profiles`, then `next_profile` again.
2. **Open.** `open_browser` with the browser, profile id and URL. If it says a browser is already open, call `close_browser` and try once more.
3. **Replay.** `replay_steps` with `jsPath`, `csvPath`, `row`. Act on `status`:
   - `success` → go to step 5.
   - `unknown_page` → record the page (step 4), then call `replay_steps` again.
   - `stuck` → the step ran but the page did not change. Treat it like a failed trial run in step 4: fix that step's code in the JS file based on the snapshot, then replay again.
   - `error` → read the error and snapshot. If a saved step's locator broke, fix that step and replay. If the site itself rejected the row, ask the user whether to skip the row.
4. **Record one page.**
   1. `get_page_snapshot`; keep it for comparison.
   2. If the page is a loading screen or an interstitial with nothing to fill, and you are not sure what to do, ask the user.
   3. Check the page against the **last-step rule**. If it matches and the JS file has no `success: true` step yet, ask the user to confirm this is the last step. The step you save for it gets `success: true`. Its `command` does whatever the rule says finishes the form (it may be empty).
   4. Draft the step: `id` from the page heading or question; `detect` checks unique to this page; `command` per `docs/rules.md` and the Global Form Rules below, with data as `{{header}}` placeholders using exact CSV headers (or their all-lowercase form).
   5. `replace_template` with the drafted `command` body, the CSV path and this `row`.
   6. `execute_code` with the resolved code.
   7. `get_page_snapshot` again. Still the same page → the code did not work: re-read the first snapshot, correct the code (wrong locator, missing click before fill, wrong combobox sequence) and retry from 5. If a corrected attempt still fails, stop, show the user what you ran and the page state, and ask how to proceed.
   8. Page moved on (or this was the `success` step) → append the step inside the array in the JS file (see Steps file format), with `{{header}}` placeholders intact, after all existing steps, without changing them. Then `mark_step` with its id.
   9. If it was the `success` step, go to step 5. Otherwise go back to step 3 (replay).
5. **Finish the row.** `close_browser`, then `mark_row` with `status: "done"`. Tell the user in one line, for example: `Row 3/40 done — profile k1a2b4, 9 steps (1 new).`
6. **Failed or skipped row.** `close_browser`, then `mark_row` with `failed` (and the error) or `skipped` (if the user chose to skip). Continue with the next row.

Each row must start with `open_browser` and end with `close_browser`, even when the previous row failed.

## 4. Gate — all rows finished

Call `get_run_state`. If `failed` is not empty, list those rows with their errors and ask the user: **retry** them (call `mark_row` with `pending` for each, then go back to phase 3) or **skip** them (`mark_row` with `skipped`). Do not continue until every row is `done` or `skipped`.

## 5. Verify detectors

1. `inspect_steps` on the JS file; keep the step ids and count.
2. Read `docs/verify-detector.md` and apply it to the whole steps array in the JS file.
3. Write the corrected array back to the same JS file. Only `detect` arrays may change; keep every `id`, `command` and the `success` flag as they are.
4. `inspect_steps` again: same ids in the same order, every step still has at least one detect check, and the file loads. If not, fix the file before continuing.
5. `mark_phase` with `phase: "verify"` and `flagged` set to the conflicts left for manual review (one line each).

## 6. Touch conversion

1. Read `docs/touch-converter.md` and apply it to the verified JS file.
2. Write the result to `<name>-touch.js` next to the JS file (for `script.js` → `script-touch.js`). Do not change `script.js`. Use the same bare-array format (see Steps file format).
3. `inspect_steps` on the touch file: same ids and detect counts as `script.js`, `clickCalls` is 0 for every step, and the file loads.
4. `mark_phase` with `phase: "touch"` and `outPath`.

## 7. Done

Tell the user the task is complete:

- rows done and rows skipped (from `get_run_state`),
- number of steps in the JS file,
- detector conflicts flagged for manual review, if any,
- paths of the JS file, the touch file and the progress file.

## Steps file format

`script.js` and `script-touch.js` contain only the array of step objects, nothing before or after it:

```js
[
  {
    id: "Tell us about yourself",
    detect: [() => page.getByRole("heading", { name: "Tell us about yourself" }).isVisible()],
    command: async () => {
      await page.getByRole("button", { name: "Continue" }).click();
    },
  },
]
```

Never add `const steps =`, `module.exports = steps;`, `export default` or a trailing `;`. A new file starts as `[]`. If an existing file still has the `const steps = [...]; module.exports = steps;` wrapper, leave it as it is unless the user asks you to remove it.

## Global Form Rules

These apply to every field you fill, on every form:

1. **Date padding.** CSV dates come as `mm/dd/yyyy`. Zero-pad month and day before use (`1/2/2024` → `01/02/2024`), then convert to whatever format the field needs.
2. **SSN last four.** If a field needs only the last four SSN digits, do not invent a header such as `{{ssnlastfour}}`. Use the existing SSN placeholder and take its last four characters in code.

## Hard rules

- Never save a step before its trial run moved the page on.
- Never add a step whose `detect` matches a step already in the file; reuse the saved one.
- Never hardcode a CSV value in a saved step, and never invent a header.
- Never start verify or touch conversion while any row is not `done` or `skipped`.
- Never mark a row `done` unless the `success: true` step ran.
