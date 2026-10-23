# Playwright Pointer → Touch Event Converter

Convert the JavaScript array of step objects below (each with `id`, `detect`,
and `command`) using these rules. Modify ONLY the `command` function bodies.

## Rules

1. Add this helper at the top of every `command` body that needs it:
   const touch = async (locator) => {
   const el = await locator.elementHandle();
   await page.evaluate((el) => {
   const rect = el.getBoundingClientRect();
   const x = rect.left + rect.width / 2;
   const y = rect.top + rect.height / 2;
   const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
   el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [t] }));
   el.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, changedTouches: [t] }));
   el.click();
   }, el);
   };
2. Replace every `.click()` / `.tap()` call on a locator:
   `someLocator.click()` → `await touch(someLocator)`
   No `.click()` or `.tap()` should remain in a command that touches an element.
3. Leave unchanged: `.fill()`, `.press()`, `.isVisible()`, `.count()`,
   `.waitForTimeout()`, `.url()`, and any `sleep()` helper.
4. Never modify `detect` arrays or `id` fields — copy verbatim.
5. If a `command` has no click/tap calls, copy it unchanged.
6. Output the full array, unabridged — no summarizing or omitting steps. Output only the bare array `[ ... ]`: never add `const steps =` or `module.exports = steps;`.
7. Output only the JS code block, no prose.

## Input
