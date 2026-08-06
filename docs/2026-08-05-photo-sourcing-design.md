# Photo sourcing & warming — design

**Date:** 2026-08-05 · **Status:** implemented (server.js, warm.js, test/photos.test.js, data/curate.json)

## Problem

Plates lack variety and skew atypical. Two root causes in `server.js`:

1. **Same-observation drain.** `fetchPhotoList` orders *observations* by votes, then loops
   *every* photo inside each observation until it has N. If the top observation has ≥N photos,
   all N plates are the same plant on the same day — habit shot, leaf, seed pod, odd close-up.
2. **Popularity ≠ typicality.** `order_by=votes` ranks by community faves, which reward the
   *striking* (fasciated, albino, aberrant individuals) — the opposite of the representative
   specimen a study tool needs.

Warming is also slow (~25–40 min): every outbound call, including S3 image downloads, is
serialized through the ~1/sec throttle.

## Goals

- Representative, varied plates: iNat's curated reference images first, varied observations as
  fallback, no popularity ranking.
- A manual override so a human can fix the handful automation still gets wrong.
- Faster warming without abusing the iNaturalist API.
- Regenerate the existing 500 taxa cleanly (old photos may be discarded).

Non-goals: a curation UI; a second image provider (Calflora/CalPhotos); changing the license
set (that's the productization plan's decision — this change keeps the current `LICENSES`).

---

## 1. Selection (Approach A)

New candidate builder, replacing the inner loop of `fetchPhotoList`:

**Primary — curated taxon photos.** `GET /v1/taxa/{inatId}` → `taxon_photos` (already in curated
order, `default_photo` first). For each, keep only licenses in `LICENSES`; map to a candidate:

```
{ photoId, src: medium_url, attribution, license, source: 'taxon' }
```

**Fallback — varied observations (only if primary yields < N).** `GET /v1/observations` with
`quality_grade=research`, license-filtered, **with `order_by` omitted** (iNat's default ordering,
not votes). Take **only `photos[0]`** of each observation. Append as
`source: 'observation'`, carrying `observed` / `place` as today.

Dedup by `photoId` across both sources. Take the first N after curation (below).

`meta.json` photo entries gain **`photoId`** (needed so a curator knows what to block).

## 2. Curation scaffold (C) — hook now, content later

`data/curate.json`, committed empty (`{}`):

```json
{
  "<taxonId>": {
    "block": [<iNat photoId>, ...],
    "pin":   [{ "url": "<medium jpg>", "attribution": "<credit>", "license": "cc-by" }]
  }
}
```

`applyCuration(candidates, entry, n)` — a **pure function** (testable, no network):
1. drop candidates whose `photoId` ∈ `entry.block`;
2. prepend `entry.pin` entries (each already a full candidate with its own attribution/license,
   so compliance holds; pins are never license-filtered away);
3. return the first `n`.

Loaded once and cached in `server.js`, re-read when the file mtime changes. Missing file → `{}`.
No UI ships now; `docs` explains the format and how to find a `photoId` (it's in `meta.json`).

## 3. Warm acceleration

**Throttle scope narrows to the API only.** `throttled()` continues to serialize calls to
`api.inaturalist.org` at ~1/sec. `download()` hits `inaturalist-open-data.s3.amazonaws.com`
(a CDN, not rate-limited) and is **removed from the throttle**.

- Within a taxon, download the N images **in parallel** (`Promise.all`) instead of sequentially.
- In `warm.js`, process taxa through a **bounded concurrency pool** (default 6). Because API
  calls still funnel through the single `throttled()` queue, the API rate stays ~1/sec globally
  while multiple taxa's download phases overlap.
- **Reuse cached `inatId`.** `ensurePhotos` skips `resolveTaxonId` when `meta.inatId` exists, so a
  re-warm is one API call/taxon (`/taxa/{id}`) plus a fallback call only for thin taxa.

Expected wall-clock for a full re-warm: API-bound, ~8–12 min (was ~25–40).

**Invariant update (CLAUDE.md).** The "~1/sec throttle / do not parallelise the warmer" invariant
becomes: *API calls to iNaturalist are throttled to ~1/sec via `throttled()`; S3 image downloads
are not API calls and may run in parallel. Do not parallelise the API calls.*

## 4. Regeneration

`warm.js --force` re-fetches even taxa that already have cached photos (today `ensurePhotos`
returns early when `meta.photos.length`; `force` must also bypass that success-cache branch, not
just the negative cache). Rollout: `rm -rf data/photos/*` then `node scripts/warm.js --force`.

`warm.js` prints a **coverage report** at the end: taxa with N plates / with <N / with 0, so the
quality gain is measurable and thin taxa are visible for later curation.

---

## Components & boundaries

| Unit | Responsibility | Depends on | Testable without network |
|------|----------------|------------|--------------------------|
| `fetchCuratedPhotos(inatId)` | taxon_photos → license-filtered candidates | iNat API | no (integration) |
| `fetchObservationPhotos(inatId, need)` | one photos[0] per research obs, neutral order | iNat API | no (integration) |
| `applyCuration(cands, entry, n)` | block / pin / slice | none | **yes (unit)** |
| `loadCuration()` | read+cache `curate.json` by mtime | fs | yes (unit) |
| `ensurePhotos(id, force)` | orchestrate, download in parallel, write meta | above + `download` | partial |
| `warm.js` pool | bounded-concurrency driver + coverage report | `ensurePhotos` | manual |

## Testing

- **Unit (added to `test/`):** `applyCuration` (block removes, pin prepends and survives a license
  it wouldn't otherwise pass, slice to N); `loadCuration` (missing file → `{}`, mtime reload);
  the license-filter/dedup helper on a fixture of fake taxon_photos.
- **Integration (manual):** run `warm.js --force --limit 30`, inspect plates, read the coverage
  report; confirm API calls stay ~1/sec (log timing) while downloads overlap.
- `check.sh` gains a syntax/require check for the new code paths; the pure functions run in the
  scoring-test harness style (no framework).

## Risks

- taxon_photos can still include a cultivated or odd shot — mitigated by the curation blocklist.
- Dropping `order_by=votes` on the fallback trades a weak quality signal for variety; acceptable
  because taxon_photos carry the common case and the fallback is edge-only.
- taxon_photos skew toward cc-by-nc; if the productization plan later drops NC, coverage shrinks
  and more taxa hit the observation fallback. Noted, not solved here.
