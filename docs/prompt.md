# Task Prompt: Building the Automated Form-Fill Script

## Setup

- The browser is already open on the target form/page via MCP. Never ask the user for a URL and never attempt to navigate to one yourself — just call `get_page_snapshot` directly to read whatever page is currently loaded and start the workflow from there.
- Before doing anything else, read `rules.md` to learn the locator priority order, allowed Playwright actions, and interaction rules. Follow it exactly for every locator and action choice — no exceptions.
- You will be given a form-data source with column headers (e.g. `state`, `amount`, `email`). These headers are the only values you may reference. Insert them into generated code as handlebars placeholders in the exact form `{{header_name}}` — never hardcode a literal value in their place, and never invent a header that wasn't given to you.
- You are automating a multi-step/multi-page form using Playwright via MCP tools (`get_page_snapshot`, `execute_code`).
- The output of this work is `./develop/script.js`, which contains only a bare array of step objects (`[ {...}, ... ]`, no `const steps =` or `module.exports = steps;`) — one per distinct page in the flow.

## Step object shape

Each entry in the array must look like this:

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
},
```

- **`id`** — a short, descriptive label named after what the page is asking (e.g. its visible heading or question).
- **`detect`** — one or more checks, each ending in `.isVisible()`, that confirm you're on this specific page. A step counts as detected if _any one_ of its checks resolves visible. Favor the most stable, page-unique element(s) available, even if that means an attribute selector — for detection, uniqueness matters more than accessibility semantics.
- **`command`** — the fill/click/submit logic for that page, written per the Locator Priority Order and Interaction Rules in `rules.md`.

## Workflow — repeat for every page in the flow

1. **Snapshot.** Call `get_page_snapshot` to capture the current ARIA snapshot. Keep it for comparison in step 6.
2. **Check for duplicates.** Look at the steps already present in `./develop/script.js`. If an existing step's `detect` already matches this page, skip it — do not add a second entry for the same page.
3. **Read the snapshot** and pick out every form-relevant element: textbox, checkbox, radio, combobox, button, switch, slider, listbox/option, etc.
4. **Draft the step.** Write the `id`, `detect`, and `command`, following the Locator Priority Order and Interaction Rules in `rules.md`. Use `{{header}}` placeholders for any data-driven value.
5. **Trial-run the code.** Call `execute_code` with the drafted `command` body against the live page. Do not touch `script.js` yet — this is a trial, not a commit.
6. **Verify it actually worked.** Call `get_page_snapshot` again and compare it against the snapshot from step 1:
   - **Same snapshot** (same page, same fields, nothing progressed) → the code did not work. Stop. Tell the user exactly what was run and what the page currently looks like, and ask how to proceed. Do not guess, retry blindly, or invent a fix.
   - **Different snapshot** (new page, new fields, or other confirmed progress) → the step passed.
7. **Only once the step has passed**, append its object to the array in `./develop/script.js`, after all previously added steps, without modifying or removing any existing entries.
8. Move to the next page and repeat from step 1.

## Hard rules

- Never write a step into `script.js` before confirming, via the before/after snapshot diff, that its `command` actually works.
- Never add a step whose `detect` matches one already present in `script.js`.
- Every data-driven value in a step must be a `{{header_name}}` placeholder matching a supplied header exactly — never a hardcoded literal or an invented field name.
- Follow `rules.md` for every locator and action choice without exception.
