# CLAUDE.md

Context for working on this repo. Read this before changing anything in
`public/app.js` or `server.js`.

## What this is

A sight-ID trainer for the **CNPS Field Botanist certification**. It drills the
Board of Certification's list of 500 common and characteristic California plants
from photographs, with typed answers scored the way the Board scores them.

Built for one person sitting the exam on **Friday 7 August 2026**. That deadline
drove several design choices that would be wrong for a general-purpose flashcard
app — see *Scheduling* below.

## Constraints that are not negotiable

- **Zero runtime dependencies.** Node stdlib only, no npm install, no build step,
  no bundler, no framework. `public/` is served as-is. If a change needs a
  dependency, the change is wrong.
- **Node 18+** for global `fetch`.
- Must run on a small VPS behind nginx or Caddy, and must keep working when the
  network is down (`OFFLINE=1`).

## Layout

```
server.js              http, state API, iNaturalist photo proxy + disk cache
scripts/warm.js        bulk photo prefetch
test/scoring.test.js   the matcher tests — run these after any matcher change
public/index.html      shell markup
public/app.js          all client logic (~900 lines, no modules)
public/styles.css      herbarium determination-slip aesthetic
data/taxa.json         the 500 taxa, generated once, treated as source of truth
data/photos/<id>/      cached plates + meta.json (attribution, licence)
data/states/           saved progress, one JSON per profile
```

## Commands

```bash
node server.js                    # :8080
node test/scoring.test.js         # 48 assertions, must stay green
node scripts/warm.js              # prefetch all photos (~25 min, throttled)
node scripts/warm.js --retry      # re-attempt taxa that came back empty
curl localhost:8080/api/cache-status
```

## Invariants

These were each written in response to a real bug. Breaking one reintroduces it.

**1. `server.js` must not call `listen()` on import.**
`scripts/warm.js` imports it for `ensurePhotos()`. The guard is
`if (require.main === module)`. Without it, warming inside a container where the
server is already running dies with `EADDRINUSE`.

**2. One input token cannot pay for both the genus and the species slot.**
`scoreBinomial` records `genusToken` and skips that index when scoring the
epithet. Without it, `Cornus nuttallii` scored 2/2 against *Corylus cornuta* —
the token `cornus` fuzzy-matched the genus *and* the epithet `cornuta`.

**3. Fuzzy matching requires an intact three-letter stem.**
`wordMatch` rejects anything whose first three characters differ, then allows an
edit distance up to `0.25 * target.length`, capped at 3. Both halves matter:
*Hordeum marinum* and *Hordeum murinum* are both on the list and are one letter
apart, and only the stem rule keeps them distinct. `Escholzia` for
*Eschscholzia* passes on the ratio; `parishii` for *parryi* fails on both.

**4. `test/scoring.test.js` includes an exhaustive 500×500 cross-check.**
No taxon's binomial may score full credit against any other taxon. It currently
reports zero collisions. If a matcher change pushes that above zero, the change
is wrong regardless of what else it fixes.

**5. A near match earns the point but is not `clean`.**
`pts` counts got + near; `exact` counts got only; `clean` means `exact === max`.
A human grader accepts a spelling slip that still identifies the taxon, so the
simulator would be pessimistic otherwise. The amber flag in the UI keys off
`clean`, not `pts`.

**6. Progress writes to `localStorage` synchronously, server sync is
best-effort.** Either can fail without taking the other down. On load, whichever
copy has more total reps wins. Do not make the server the sole source of truth —
the earlier version used a sandbox-only storage API and silently lost everything.

**7. Photo attribution is displayed on reveal and stored in `meta.json`.**
Images come from iNaturalist filtered to CC0 / CC-BY / CC-BY-NC / CC-BY-SA /
CC-BY-NC-SA. The licences require attribution and none permit redistributing the
cache as a dataset. Keep the credit line.

**8. Outbound calls to iNaturalist stay throttled to ~1/sec.** `throttled()` in
`server.js` serialises them. Do not parallelise the warmer.

## Scheduling

`LADDER_CRAM` is in **minutes**: 1, 6, 20, 60, 240, 720, 1440, 2880. Ordinary
spaced repetition schedules in days, which is useless when the exam is days away
— a card scheduled for next Tuesday never comes back. `LADDER_LONG` is the
conventional ladder for after the exam. `isSolid()` means "within two steps of
the end of the current ladder", so its meaning shifts with the ladder — that is
intentional.

Cards are stored as `{step, due, reps, lapses, right, wrong, last}`. There is no
ease factor; the ladder is fixed and lapses reset to step 0.

## Known gaps

- Genus-level flagging is inferred from `spp.` in the name. CNPS marks those in
  red on the source PDF and colour does not survive text extraction. 60 are
  flagged; cross-check against the Excel on the CNPS study guide page.
- No authentication anywhere. Anyone with the URL can read and overwrite any
  profile. Basic auth belongs in the reverse proxy — see `nginx.conf.example`.
- iNaturalist coverage of genus-only entries is thin; some have no plate and
  fall back to drilling from the name.
- `data/taxa.json` was generated once from the CNPS PDF and hand-patched for
  `Abies concolor/lowiana`. There is no regeneration script — edit the JSON.
- No keying practice, no CEQA/protocol material. This tool covers one of the
  three Field Botanist exam components.

## Style

Comments explain *why*, especially where the code looks arbitrary — the stem
rule, the token-exclusion, the minute-scale ladder all look like mistakes
without their reasons attached. Match that. No comments that restate the code.
