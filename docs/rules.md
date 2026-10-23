# Playwright Automation Rules

## Prerequisites

If the user provides this file only (or required inputs are missing), ask the user to provide:

1. **Prompt**: The automation task prompt or description.
2. **Data**: Data in CSV format containing headers and only one row of data.
3. **Target JS File**: A JS file where code will be saved. If not provided, a new file will be created (e.g. `./develop/script.js`).

## Workflow

1. Ensure prerequisites are met: confirm task prompt, CSV form data, and the target JS output file (create new file if not provided). If missing, ask the user first.
2. `get_page_snapshot` to get the current ARIA snapshot.
3. Identify form-relevant fields from the snapshot; write code.
4. Use code in this style:
   ```js
   await page.getByRole("textbox", { name: "Name *" }).click();
   ```
5. Call `replace_template` (passing drafted code and CSV `filePath`) to replace `{{header}}` syntax with data, then pass the returned code to `execute_code` to fill in data.
6. Follow the **Script Building Workflow** below to verify the step worked before persisting it to the target JS file.

---

## Locator Priority Order

Always prefer locators in this exact order. Only fall back to the next one if the current one cannot be used.

```
getByRole
getByLabel
getByPlaceholder
getByText
locator
```

### 1. `getByRole(role, options?)`

Locate by ARIA role + accessible name. **Always try this first.**

- `role: string` — e.g. button, checkbox, link, heading, textbox, radio, tab, combobox, list, listitem, table, row, cell, img, dialog, menu, menuitem, option, switch, slider, progressbar, etc.
- `options`: `name?` (string|RegExp), `exact?`, `checked?`, `disabled?`, `expanded?`, `pressed?`, `selected?`, `level?`, `description?`, `includeHidden?`

### 2. `getByLabel(text, options?)`

Locate inputs by associated `<label>`, `aria-labelledby`, or `aria-label`.

- `text: string | RegExp`, `options`: `exact?`

### 3. `getByPlaceholder(text, options?)`

Locate inputs by `placeholder` attribute.

- `text: string | RegExp`, `options`: `exact?`

### 4. `getByText(text, options?)`

Locate elements by visible text. Use only when role/label/placeholder don't apply.

- `text: string | RegExp`, `options`: `exact?`

### 5. `locator(selectorOrLocator, options?)`

Last resort — CSS/XPath or compound filtering.

- `options`: `has?`, `hasNot?`, `hasText?`, `hasNotText?`

**Rule:** Never use raw CSS selectors, XPath, `data-*` test-id lookups, or `nth()/first()/last()` chaining unless methods 1–4 are all impossible (e.g. an interactive element with no ARIA role, no label, no placeholder, and non-unique text). In that case, `locator('[data-test-id="..."]')` is the correct use of method 5 — still last-resort, not an exception.

**Rule:** Never use `page.evaluate()`, `page.evaluateHandle()`, or any inline JS injection. Always use the locator methods and actions described here.

**Note on `detect` arrays specifically:** for _detecting_ which page you're on (vs. _acting_ on it), prefer whichever locator is most stable and least likely to collide with other pages, even if that means an attribute selector (method 5) instead of `getByText`. A `data-test-id` on a page-unique element is often more reliable for detection than matching visible copy, which can change wording. The priority order still governs locators used for _actions_ inside `command`.

---

## Actions (after locating an element)

- **`check(options?)`** — checks a checkbox/radio. Options: `force?`, `position?`, `scroll?`, `timeout?`, `trial?`, `signal?`, `noWaitAfter?` (deprecated)
- **`click(options?)`** — clicks the element. Options: `button?`, `clickCount?`, `delay?`, `force?`, `modifiers?`, `position?`, `scroll?`, `steps?`, `timeout?`, `trial?`, `signal?`, `noWaitAfter?` (deprecated)
- **`dblclick(options?)`** — same as `click()` minus `clickCount` (always 2 clicks)
- **`fill(value, options?)`** — clears and types the value directly. Options: `force?`, `timeout?`, `signal?`, `noWaitAfter?` (deprecated)
- **`focus(options?)`** — focuses the element. Options: `timeout?`, `signal?`

**Rule:** Prefer `fill()` over typing key-by-key for text inputs. Prefer `click()`/`check()` with default options; only add `force`, `position`, or `trial` when default actionability checks genuinely block a valid interaction.

---

## Reading Accessibility Snapshots

Page state arrives as a YAML-style ARIA tree, e.g.:

```yaml
- textbox "Name *":
    - /placeholder: Your name
- button "Select country"
- textbox "you@example.com"
```

Identify every form-relevant element: `textbox`, `checkbox`, `radio`, `combobox`, `button`, `switch`, `slider`, `listbox`/`option`, etc. Build locators from the accessible name/role shown, per the priority order above.

---

## Interaction Rules

1. **Any input field:** always `.click()` first, then `.fill()`. Never `.fill()` without clicking first.
2. **Combobox / custom dropdown:** `.click()` to open → `.fill()`/type the value → press `ArrowDown` → press `Enter` to confirm.

---

## Script Building Workflow

Governs how the target JS file (e.g. `./develop/script.js`) is built up as an array of step objects — one per page/screen: detect whether the current page is that screen, then fill and submit it.

### Step Object Shape

```js
{
  id: "How much are you looking for",
  detect: [
    () =>
      page
        .locator("div")
        .filter({ hasText: /^How much are you looking for\?$/ })
        .first()
        .isVisible(),
    () => page.locator('[data-test-id="btn-cf-100"]').isVisible(),
    () => page.locator('[data-test-id="btn-cf-500"]').isVisible(),
    () => page.locator('[data-test-id="btn-cf-1000"]').isVisible(),
    () => page.locator('[data-test-id="btn-cf-2500"]').isVisible(),
  ],
  command: async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    await page.locator('[data-test-id="btn-cf-500"]').click();
    await page.getByRole("combobox", { name: "State" }).click();
    await page.getByRole("combobox", { name: "State" }).fill("{{state}}");
    await page.getByRole("combobox", { name: "State" }).press("ArrowDown");
    await page.getByRole("combobox", { name: "State" }).press("Enter");
    await sleep(1000);
    await page.locator('[data-test-id="form-nav-submit"]').click();
  },
}
```

- `id`: short, human-readable, based on the visible heading/question on that page.
- `detect`: one or more `.isVisible()` checks confirming you're on this page; any single `true` counts as a match. Favor the most stable, page-unique element(s) (see note above).
- `command`: async function filling/advancing this page, per Locator Priority Order and Interaction Rules. Data values must come from supplied form-data headers as `{{header_name}}` placeholders — never a hardcoded value or invented header.

### Process for Each New Step

1. **Snapshot first.** `get_page_snapshot` before writing any code — keep for step-6 comparison.
2. **Check for an existing matching step.** If the target JS file already has a step whose `detect` matches this page (same question/heading, same distinguishing elements), skip it — move to the next unhandled page.
3. **Read the snapshot** and identify form-relevant elements (textbox, checkbox, radio, combobox, button, switch, slider, listbox/option, etc.).
4. **Draft the step** — descriptive `id`, `detect` checks, `command` body per the rules above. Use `{{header}}` placeholders exactly matching supplied headers.
5. **Replace placeholders and execute.** Call `replace_template` with the drafted `command` and CSV `filePath` to resolve `{{header}}` tokens into real data. Pass the returned code to `execute_code` against the live page — do not touch the target JS file yet. (Note: Step 7 must always append the original drafted step with `{{header}}` placeholders, not the resolved data).
6. **Verify.** `get_page_snapshot` again and compare to the step-1 snapshot:
   - **Unchanged** (nothing progressed) → failed. Stop, report exactly what was run and the current page state, ask how to proceed. No guessing, blind retries, or invented fixes.
   - **Changed** (new page/fields/confirmed progress) → passed.
7. **Only after passing**, append the step to the target JS file, after all previous entries, without editing or removing existing ones.
8. Repeat from step 1 for the next page.

### Additional Rules

- If the user provides this file only, ask the user to provide the task prompt, data in CSV format (containing headers and one row of data), and the target JS file (create a new file if not provided).
- If data is not provided, ask the user for data in CSV format, containing headers and only one row of data.
- If the output JS file is not provided, ask the user for the file path or create a new one.
- Never write a step into the target JS file before its `command` is confirmed working via the before/after snapshot comparison.
- Never add a step whose `detect` matches an already-existing step — skip it instead.
- Keep `id`s unique and readable at a glance.
- All data-driven values must reference exact supplied header names as `{{header_name}}` — never a hardcoded literal.
- Always use `replace_template` with the CSV `filePath` and drafted code before sending code to `execute_code`.
