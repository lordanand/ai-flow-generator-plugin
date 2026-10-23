**TASK:** Review a Playwright `steps` array (each step has `id`, `detect[]`, `command`) used to auto-navigate a multi-step form. Verify that every `detect` condition is unique **across the entire array**, not just within its own step. A step's `detect` entries exist to uniquely fingerprint that page state — if two steps share a matching `detect` condition, the runner may fire the wrong step's `command`.

**COMPARISON RULE:** For every `detect` entry in every step, compare it against every `detect` entry in every _other_ step (skip self-comparisons within the same step).

**FLAG AS DUPLICATE/CONFLICT IF:**

1. **Identical selector** — same locator method + same role/name/text string, regardless of quote style or whitespace differences.
2. **Same role + accessible name**, case-insensitive.
3. **Same `getByText` string**, or near-identical (differs only by punctuation/whitespace/case).
4. **Subset/superset relationship** — one step's condition (e.g. a button) also appears nested inside another step's detect list (e.g. as one of several options).

**RESOLUTION RULES:**

- Keep the condition on whichever step it most _specifically_ identifies — prefer the step whose `id` or question text semantically matches the condition.
- Remove it from the other step(s)' `detect` array.
- **Never leave a step with zero `detect` entries.** If removing a duplicate would empty a step's array, do **not** remove it — instead flag it as a conflict for manual review, with a one-line explanation (e.g. "these may be alternate branches of the flow, not true duplicates").
- Do not modify `command` logic — only touch `detect` arrays.

**OUTPUT FORMAT:**

1. A table of every duplicate pair found: `Step A id | Step B id | conflicting expression`.
2. The corrected `steps` array (JS/TS), with duplicates removed.
3. A list of any flagged conflicts left for manual review, with reasoning.
4. If no duplicates exist, state explicitly: _"All detect conditions are unique across the array — no changes made."_

**INPUT:** Paste or upload the actual `steps` array below this prompt before running it.
