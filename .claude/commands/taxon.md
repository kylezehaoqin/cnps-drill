---
description: Inspect how the matcher scores a guess against a taxon
argument-hint: [guess] -> [scientific name]
---

The user wants to know how the matcher treats: $ARGUMENTS

Write a throwaway node script that loads the matcher out of `public/app.js`
the same way `test/scoring.test.js` does (indirect eval of the slice between
`function norm(` and the pool section marker), then reports for the given
guess and taxon:

- `scoreBinomial` result: genus, species, pts, exact, max, full, clean
- `scoreCommon` result
- the normalised forms of both sides, so the reason is visible

Then say whether the behaviour is correct. If it is wrong, propose the fix but
do not apply it until the user agrees — matcher changes are the highest-risk
edits in this repo and each one needs a regression test added to
`test/scoring.test.js`.
