# Retrospective — photo sourcing, warming, and a two-hour scare that wasn't

**Date:** 2026-08-05 · **Companion to:** `docs/2026-08-05-photo-sourcing-design.md` (the spec)

The spec records *what* we built. This records *why*, the tradeoffs, and the two
mistakes made along the way — the reasoning a diff throws away.

---

## The problem we started from

Plates lacked variety and skewed atypical. Two causes in the old `fetchPhotoList`:

1. **Same-observation drain.** It ordered *observations* by votes, then looped
   *every* photo inside the first one until it had six — so all six plates were
   the same plant on the same day (habit shot, leaf, seed pod, odd close-up).
2. **Popularity ≠ typicality.** `order_by=votes` ranks by community faves, which
   reward the *striking* — fasciated, albino, aberrant individuals. Exactly the
   wrong thing for a study plate.

---

## Decisions & tradeoffs

### Selection: curated photos first, observations as fallback
`taxon_photos` from `/taxa/{id}` are iNat's *reference* set — chosen to represent
the species, not fave-ranked. We take those first; only when a taxon has fewer
than six do we top up from research-grade observations, one lead photo each,
**with `order_by` omitted** so the fallback isn't popularity-ranked either.

| Chose | Over | Why | Cost |
|-------|------|-----|------|
| Curated `taxon_photos` | Observations ranked by votes | Representativeness by construction; kills both the same-observation and mutant-bias problems | Two code paths; taxon_photos skew cc-by-nc |
| Observation fallback | Showing fewer plates for thin taxa | Keeps six varied plates everywhere | A second API call for thin taxa only |
| Drop `order_by=votes` | Keeping it as a quality signal | Faves *are* the bias | Fallback loses a weak quality hint — acceptable, it's edge-only |

### Curation scaffold now, curation later
`data/curate.json` + a pure `applyCuration(block/pin/slice)` (unit-tested). No UI.
A human can `block` a bad auto-pick or `pin` a chosen image; pins carry their own
attribution/licence and bypass the filter. **Tradeoff:** we build the hook but
defer the manual pass — automation gets us most of the way, and 500 taxa is small
enough to hand-fix the rest whenever needed.

### iNaturalist only — we declined Calflora
Mid-way the idea came up: fall back to Calflora when iNat "fails." We didn't,
for two reasons. First, iNat wasn't actually failing (see Mistake #2). Second and
decisive: **Calflora's photos are CalPhotos images** — individually copyrighted,
"free for non-commercial/educational use, commercial needs each photographer's
permission," and not redistributable. Wiring them in would reintroduce the exact
licensing risk the productization plan exists to remove. The compliant answer for
a genuinely thin taxon is a `curate.json` pin with an image we have rights to.

### License set left unchanged
We kept the current five-licence filter rather than folding in the cc0/cc-by
switch from the productization plan. That decision isn't finalized; front-running
it here would have coupled two unrelated changes. If NC is dropped later, it's
just another `--force` re-warm.

### Warming: throttle the API, not the downloads
The old rule was "throttle everything to ~1/sec, don't parallelise." The refined
rule: **only `api.inaturalist.org` calls are rate-limited**; image bytes come from
an S3 CDN that isn't, so downloads run in parallel and the warmer processes
several taxa at once, reusing the cached `inatId` to skip the resolve call.
Isolated cost dropped to ~0.6–1.3s/taxon. This updated CLAUDE.md invariant #8 and
added #9.

---

## Mistake #1 — a two-hour warm that was mostly a sleeping laptop

The full re-warm showed `ELAPSED 01:58:39` at 432/500. Alarming — the estimate was
~10 min. But:

- **Isolated timing said 0.6–1.3s/taxon** — no per-taxon slowness at all.
- The failures **clustered in a contiguous alphabetical block** (Iris → Lysimachia).
- Progress "flew" once the machine was awake (332→432 in minutes).

The laptop had **slept** mid-run. `etime` counts wall-clock including suspend, so
elapsed time lied; `AbortSignal.timeout` deadlines lapsed during sleep and fired on
wake (`aborted due to timeout`), and dropped TCP connections showed as `fetch
failed`. Nothing was slow — the process spent two hours suspended.

**Lessons.**
- Aggregate wall-clock lies when a process can be suspended. **Measure the isolated
  per-unit cost** before believing an end-to-end number.
- A **contiguous cluster** of failures (alphabetical, sequential) is a tell for a
  *time-based external event*, not a per-item cause.
- Run long unattended jobs under `caffeinate -i`. And a `--retry` that only re-does
  *empty* taxa misses ones left *partial* by the same event — we widened it to
  "anything short of a full set."

## Mistake #2 — "not on iNaturalist" was my query, not reality

Three taxa (*Juncus mexicanus*, *Raphanus sativus*, *Vulpia* spp.) reported
`no iNat taxon`, and I wrote them off as real gaps. The user pushed back — "I think
something you did was wrong" — and linked a Calflora page proving *Juncus mexicanus*
plainly exists.

It did. `resolveTaxonId` hard-coded `rank=species`; iNat has these as **subspecies**
(*Juncus balticus mexicanus*), so the rank filter returned zero. Dropping the rank
on a fallback search resolved all three instantly, with CC-licensed photos. The
"gap" was self-inflicted.

**Lessons.**
- **"Not found" usually means "my filter excluded it," not "absent."** Before
  declaring a data gap, broaden the query and confirm.
- When the domain expert says something's wrong, **investigate, don't defend.** The
  fastest path to the truth was reproducing their claim, not explaining mine.
- A blunt `rank=` constraint is brittle against a living taxonomy that demotes
  species to subspecies — the same class of drift the scoring-side synonym work hit.

---

## Where it landed

**500 / 500 full sets**, all CC-licensed from iNaturalist. The only genuine defect
was the rank bug; every other "missing" plate was the sleep. No second image source
was needed — which is also the compliant outcome.

## Follow-ups

- The running Docker container still serves the *old* server code (it serves the new
  photos fine, since those are read from disk); rebuild it (`docker compose up -d
  --build`) to pick up the pipeline and `resolveTaxonId` fix in the app itself.
- Curation (`data/curate.json`) is still an empty hook — a human pass over any plate
  that looks off is the last-mile quality lever.
- If the productization plan drops NC licences, re-warm with the narrower filter and
  re-check coverage; taxon_photos skew cc-by-nc, so some taxa will lean harder on the
  observation fallback.
