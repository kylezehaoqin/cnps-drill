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

## Architecture & conventions

Full reasoning and ADRs in `docs/architecture.md`. The load-bearing rules:

- **Extend within the constraint via native ES modules** — browsers and Node run
  them with no bundler, so logic splits into modules without breaking "no build".
  New tests `import` a module rather than the string-slice hack (see traps).
- **New study modes go through a mode registry, not `if/else`.** A mode is
  `{ id, prompt, score, reveal }`; add a module under `public/modes/`, don't
  branch `doCheck`/`renderDrill`. Discrimination drills, cloze, MCQ, and decks
  are all this same shape reusing the shared scheduler + scoring.
- **Pure core, thin shell.** Keep logic in pure functions (`pickTaxon`,
  `applyCuration`, `scoreBinomial` are the model); DOM/network stays at the edges.
  It's what makes the code testable without a framework.
- **`taxa.json` is the stable spine.** Per-taxon overrides and enrichment
  (diagnostic characters, etymology, range) live in id-keyed side-car files —
  `data/curate.json` is the pattern — lazy-loaded, never edited into `taxa.json`.
- **State schema is additive and versioned.** Only add fields; migrate on load;
  never break saved progress (see invariant on `localStorage`).
- **Storage and data sources sit behind small adapters** so file→DB (accounts)
  or a new photo source is a localized swap.
- Stay zero-dep vanilla + ES modules until a real trigger (a team, UI complexity
  outgrowing string templates, SSR/SEO). That is ADR-001 in `docs/architecture.md`.

The codebase is mid-transition to this shape: the matcher is extracted
(`public/matcher.mjs`) and `app.js` is now an ES module. Still pending:
extracting the scheduler and introducing the mode registry, behaviour-preserving
under `check.sh`.

## Layout

```
server.js              http, state API, iNaturalist photo proxy + disk cache
scripts/warm.js        bulk photo prefetch
test/scoring.test.mjs  the matcher tests — run these after any matcher change
public/index.html      shell markup
public/app.js          client logic, an ES module (imports matcher.mjs)
public/matcher.mjs     the answer matcher — pure, no DOM; imported by app.js + tests
public/styles.css      herbarium determination-slip aesthetic
data/taxa.json         the 500 taxa, generated once, treated as source of truth
data/photos/<id>/      cached plates + meta.json (attribution, licence)
data/states/           saved progress, one JSON per profile
```

## Workflow

**Run `./scripts/check.sh` after every change.** It is the only gate that
matters — eight steps covering syntax, that `matcher.mjs` still exports its
scorers, the scoring assertions including exhaustive 500x500 cross-collision
checks, dataset integrity, the DOM id contract between `app.js` and
`index.html`, a live server smoke test (including the `.mjs` MIME so the browser
will run the module), and the `require.main` guard. Nothing here has type
checking or a build step, so this script is what stands between a plausible-looking edit and
build step, so this script is what stands between a plausible-looking edit and
a silent runtime failure.

Slash commands: `/verify` runs it and explains failures, `/taxon` inspects how
the matcher scores a specific guess, `/ship` verifies then commits.

```bash
./scripts/check.sh                # everything — run this
node server.js                    # :8080
node test/scoring.test.mjs        # scoring only
node scripts/warm.js              # prefetch all photos (~25 min, throttled)
node scripts/warm.js --retry      # re-attempt taxa that came back empty
curl localhost:8080/api/cache-status
```

## Where the traps are

The matcher lives in `public/matcher.mjs` — pure, no DOM — and is `import`ed by
both `public/app.js` (an ES module: `index.html` loads it with
`<script type="module">`) and `test/scoring.test.mjs`. One source, imported two
ways; never copy the functions. The server must serve `.mjs` with a JavaScript
MIME or the browser refuses the module (check.sh step 6 guards this).

Matcher changes need a regression test in the same commit. Every rule in the
Invariants section below was written against a real failure, and several look
arbitrary without their reason attached — the three-letter stem rule, the
head-noun gate, the token-exclusion. Loosening any of them reopens a specific
collision that the exhaustive check will catch, so read the failure before
assuming the test is wrong.

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

**3. Fuzzy matching guards the three-letter stem, but forgives one typo inside
it unless the guess is itself a real name.**
When the stems match, `wordMatch` allows an edit distance up to
`0.25 * target.length`, capped at 3 (`Escholzia` for *Eschscholzia* passes on
the ratio; `parishii` for *parryi* fails). When the stems *differ*, a single
edit is still forgiven — `Monuartia` for *Minuartia* — but only if the guess is
not in `RESERVED` for that slot. That veto is what keeps *Hordeum marinum* and
*murinum* distinct now that a bare stem mismatch no longer rejects outright:
both are real epithets, so each vetoes the other. `RESERVED` is built once by
`indexNames(TAXA)` at boot (and in the tests); if it is empty the relaxation is
inert and `wordMatch` stays strict, so an un-indexed matcher can never
over-credit. The binomial slots pass `RESERVED.genera` / `RESERVED.epithets`;
the common-name path passes nothing and keeps the strict stem rule.

**4. `test/scoring.test.mjs` includes an exhaustive 500×500 cross-check.**
No taxon's binomial may score full credit against any other taxon. It currently
reports zero collisions. If a matcher change pushes that above zero, the change
is wrong regardless of what else it fixes.

**5. Hyphenated epithets are compared space-free.**
`key()` strips spaces, and `scoreBinomial` also tries adjacent-token joins, so
`filix-femina`, `filix femina` and `filixfemina` all land on one key. Six taxa
(*Athyrium filix-femina*, *Capsella bursa-pastoris*, *Elymus caput-medusae*,
*Oxalis pes-caprae*, *Quercus john-tuckeri*, *Veronica anagallis-aquatica*)
scored 1/2 against their own verbatim names before this.

**6. A shortened common name needs all three gates: subset, head-noun
agreement, and one non-generic word.** Subset alone produced 202 collisions —
"White Alder" matched "California White Fir", because both head nouns are
generic and the shared modifier carried the match. Head-noun agreement alone
lets a bare "sage" match every *Salvia*. The residual 21 collisions are
near-synonyms within a genus and are accepted deliberately; the test ratchets
that ceiling.

**7. "Gray or Foothill Pine" is two names, not one.** The head noun is
distributed across `or` alternatives during phrase building. Without it, "gray
pine" — the name most people use for *Pinus sabiniana* — matched nothing.

**8. The document keydown handler must ignore events from inputs.**
The answer field has its own Enter handler. When both fired, one keypress
checked the answer *and* graded it away before the determination slip rendered,
so a correct answer looked like it had been silently rejected.

**8a. Answer-check handlers must not leak a DOM event into `skipped`.**
Same symptom, different mechanism: `elem.onclick = fn` calls `fn(event)`, so
binding `$('#check').onclick = doCheck` smuggled a truthy `MouseEvent` into
`doCheck(skipped)` and scored every clicked answer as blank `0/2`. Bind through a
wrapper (`() => doCheck()`) *and* coerce `skipped = skipped === true` at the top
of `doCheck`; both hold. `check.sh` step 8 is the static guard.

**9. Every fetch exit path drains or cancels the response body.**
An unread body holds its socket in undici's pool with abort listeners attached;
a few hundred error responses produce `MaxListenersExceededWarning` and a slow
leak. See `drain()` and `req()` in `server.js`. All outbound calls also carry
`AbortSignal.timeout`.

**10. A near match earns the point but is not `clean`.**
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

**8. iNaturalist API calls stay throttled to ~1/sec; image downloads do not.**
`throttled()` in `server.js` serialises calls to `api.inaturalist.org` (taxon
resolve, taxon detail, observations) at ~1/sec — do not parallelise those. Image
bytes come from the S3 CDN (`inaturalist-open-data.s3.amazonaws.com`), which is
not rate-limited, so `download()` runs off the throttle and the warmer fetches
several taxa at once (`warm.js` concurrency pool, parallel downloads per taxon).
A re-warm reuses the cached `meta.inatId` to skip the resolve call.

**9. Plates are picked for typicality, not popularity.** `fetchCuratedPhotos`
uses the taxon's curated `taxon_photos` (representative by construction); only
when those run short does `fetchObservationPhotos` top up with one lead photo per
research-grade observation — **without `order_by=votes`**, because faves reward
the striking and aberrant, the opposite of a study plate. `data/curate.json`
(`applyCuration`) lets a human `block` a bad auto-pick or `pin` a chosen image
per taxon; pins carry their own attribution/licence and bypass the licence
filter. Every candidate that isn't pinned must pass `licenseOk`.

**10. Taxon resolution loosens rank but stays strict on identity.** `resolveTaxonId`
searches rank-constrained first, then rank-less (iNat may file a listed species as
a subspecies or under a merged genus), but every hit goes through `pickTaxon`,
which accepts a candidate only on an exact name or a genus (or `alts` synonym
genus) plus epithet match — otherwise `null`. Never resolve to iNat's fuzzy top
hit; a wrong `inatId` caches the wrong plant, worse than a missing plate. A real
genus move not in `alts` will read as absent — add the alt or a `curate.json` pin.
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
