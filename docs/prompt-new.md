# Form-Fill Automation Task

## Setup

- **Browser:** Already open via MCP. Never ask for or navigate to a URL —
  start by calling `get_page_snapshot`.
- **Rules:** Read and follow `rules.md` (locator priority, allowed actions,
  interaction rules, file-editing rules) strictly.
- **Global Form Rules:** Read and follow the `Global Form Rules` section
  below. These are data-handling rules that apply to every form and every
  step, regardless of which form is being filled.
- **Form-Specific Step Rules:** Read and follow the `Form-Specific Step
Rules` section at the end of this document. It gives per-step guidance
  for _this_ form only, and supplements — never overrides — `rules.md`.
- **Placeholders:** Data values must use supplied CSV headers as
  `{{header_name}}` — never hardcode literals or invent keys. Placeholders
  are matched case-sensitively against the CSV header, or against its fully
  lowercased form — no other casing variant resolves, so use the header
  exactly as given or all-lowercase.
- **Output:** `./develop/script.js` — only a bare array of step objects (`[ {...}, ... ]`); never add `const steps =` or `module.exports = steps;`.

## Global Form Rules

These are data-handling rules for filling fields — not step-detection or
locator rules (those stay in `rules.md`). They apply to **every** form and
**every** step, regardless of what's in `Form-Specific Step Rules` below,
and must be applied whenever the code you're drafting touches this kind of
data.

1. **Date padding.** CSV date values are always supplied as `mm/dd/yyyy`.
   Before using a date value, zero-pad the month and day: a single-digit
   month or day (e.g. `1`, `2`) becomes two digits (`01`, `02`) — e.g.
   `1/2/2024` → `01/02/2024`. The form's own date field may expect a
   different display/input format than `mm/dd/yyyy`; that varies per form,
   so after padding still convert to whatever format the specific field
   requires.
2. **SSN last four.** If a step needs only the last four digits of the
   SSN, do not invent a new placeholder (e.g. no `{{ssnlastfour}}` — no
   such CSV header exists). Instead, resolve the existing `{{ssn}}`
   placeholder as usual and derive the last four digits from it in code
   (e.g. taking the last four characters of the resolved SSN string), then
   use the derived value to fill the field.

## Tools in Play

- **`get_page_snapshot`** — returns the current ARIA snapshot as text. If no
  browser/page is open, it instead returns `"No active page is detected"`
  with `isError: true`.
- **`replace_template`** (alias `fill_template`) — takes `filePath` (the CSV
  path) and `code` (the drafted `command` body as a string, containing
  `{{header}}` tokens), plus an optional `row` (defaults to `0`, correct
  here since the CSV has exactly one data row). Returns the code with
  placeholders resolved to real values.
- **`execute_code`** — takes a `code` string and runs it live against the
  page, with `page`, `context`, `browser`, `playwright`, and `console`
  available. Used only to trial-run a step's resolved code, never to write
  to `script.js`. If no browser/page is open, it also returns `"No active
page is detected"` with `isError: true`.

## Step Structure

```js
{
  id: "Loan Amount",
  detect: [
    () => page.getByRole("heading", { name: "Loan Amount" }).isVisible(),
    () => page.locator('[data-test-id="amount-500"]').isVisible(),
  ],
  command: async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    await page.getByRole("combobox", { name: "State" }).click();
    await page.getByRole("combobox", { name: "State" }).fill("{{state}}");
    await page.getByRole("combobox", { name: "State" }).press("ArrowDown");
    await page.getByRole("combobox", { name: "State" }).press("Enter");
    await sleep(500);
    await page.getByRole("button", { name: "Continue" }).click();
  },
}
```

- **`id`**: Short label from page heading/question.
- **`detect`**: Array of `() => ...isVisible()`. Matches if **any** resolves
  true. Must only contain elements strictly unique to this page (never
  generic submit/next buttons).
- **`command`**: Execution logic following `rules.md`.

## Workflow (Per Page)

1. **Snapshot.** Call `get_page_snapshot`.
   - If the result is `"No active page is detected"`, tell the user the
     browser isn't running and ask them to start it first, then stop —
     do not proceed or attempt to launch/navigate anything yourself.
   - Otherwise, save this snapshot for comparison in step 6.
2. **Understand the page, and check for existing code.** Read the snapshot
   and identify form-relevant elements per `rules.md` (textbox, checkbox,
   radio, combobox, button, switch, slider, listbox/option, etc.). Then
   check whether `script.js` already contains a step whose `detect`
   matches this page:
   - **Match found** → reuse that step's `command` code as-is — do not
     re-draft it. Skip step 3 entirely and go straight to step 4 (Resolve
     placeholders) using this reused code.
   - **No match** → continue to step 3 to draft new code for this page.
3. **Draft the code.** (Only reached if step 2 found no existing match.)
   Apply any relevant `Global Form Rules` to the fields on this page (e.g.
   pad dates, derive SSN-last-four) regardless of whether this step has a
   `Form-Specific Step Rules` entry. Then identify the step name (per the
   `id` convention above), and check the `Form-Specific Step Rules` section
   for an entry matching that step name.
   - **Entry found** → follow its instruction as the primary guide for
     what this step's `command` should do, while still applying the
     Locator Priority Order and Interaction Rules from `rules.md` for
     _how_ to do it.
   - **No entry** → draft using `rules.md` alone, as before.
     In both cases, write the `command` body with data values as
     `{{header_name}}` placeholders — never a hardcoded value or invented
     header.
4. **Resolve placeholders.** Call `replace_template` with the code from
   step 2 (reused) or step 3 (freshly drafted), plus the CSV `filePath`,
   to substitute real values in for the `{{header}}` tokens.
5. **Trial-run.** Pass the resolved code from step 4 to `execute_code`
   against the live page. Do not modify `script.js` yet.
6. **Verify.** Call `get_page_snapshot` again and check whether the page is
   still on the same step as before (e.g. the same unique heading/elements
   from this step's `detect` are still the ones showing):
   - **Still the same step** → the command didn't work. Re-examine the
     original (step-1) snapshot, correct the code — wrong locator, missing
     click-before-fill, wrong combobox sequence, etc. — and repeat from
     step 4. This is a deliberate rewrite based on what the page actually
     showed, not a blind retry of the same code. If a genuinely corrected
     attempt still fails to advance the page, stop, report exactly what
     was run and the current page state, and ask the user how to proceed
     — do not keep guessing.
   - **Progressed to a new step** → passed, continue to step 7.
7. **Persist (new steps only).** If this step's code was reused from an
   existing entry in step 2, it's already saved — do not append a
   duplicate. Only when the code was freshly drafted in step 3: append the
   verified step — with `{{header}}` placeholders intact, not the resolved
   data — to `./develop/script.js`, after all existing entries, without
   editing or removing any of them. Then check the new step's `detect`
   array against every other step's `detect` entries: if any individual
   check is duplicated across steps, remove it from all but the step that
   most uniquely relies on it, so no detector is repeated across step
   objects.
8. **When in doubt, ask.** If it's unclear whether the current page is an
   actual form step to fill (vs. an interstitial, loading, or informational
   page with nothing to submit), stop and ask the user whether to keep
   working on it or skip/stop.
9. Repeat from step 1 for the next page until the form flow is complete.

## Form-Specific Step Rules

Per-form guidance, one line per step. Before drafting new code for any
step, always check first whether an entry exists here for that step's
name. If one exists, use it as the primary guidance for that step's
command — it gives a shorter, more direct path to completing that
specific step than working it out from scratch. Each entry names a step
(matching the `id` used in `script.js`) and states what that step's
`command` should do. This section is specific to the current form only —
it does not carry over to other forms/CSVs, and supplements rather than
replaces the general locator/interaction rules in `rules.md`. Leave unused
for a form until entries are added below.

Format:

```
1. <Form step name used to identify step>: <what to do>
2. <Form step name used to identify step>: <what to do>
```

{{step_rules}}
