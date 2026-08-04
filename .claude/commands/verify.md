---
description: Run the full check suite and report what broke
---

Run `./scripts/check.sh`.

If anything fails, fix it before doing anything else. Pay attention to which
step failed:

- **Step 2** means the matcher slice markers moved. `test/scoring.test.js`
  locates the matcher functions in `public/app.js` by string offset. Update
  `SLICE_START` / `SLICE_END` in the test file — do not duplicate the matcher.
- **Step 3** with a collision-count failure means a matcher change made two
  real taxa on the list indistinguishable. That is never an acceptable
  trade, regardless of what else the change fixed.
- **Step 5** means `public/app.js` queries a DOM id that `public/index.html`
  does not define and app.js does not create. This fails silently at runtime.
- **Step 6** warnings usually mean a `fetch` response body went unread.

Report results concisely. Do not summarise steps that passed.
