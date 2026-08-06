# Engineering architecture & conventions

**Date:** 2026-08-05 · Read this before adding features. The load-bearing rules also live in
`CLAUDE.md` (auto-loaded each session) so they bind future work; this doc holds the reasoning.

## The load-bearing constraint

**Zero runtime dependencies, no build step, Node stdlib only, offline-capable.** `public/` is served
as-is; the client is plain JS; the server is hand-rolled `http`. This was chosen for a one-person tool
on a small VPS and it has paid off in deploy/ops simplicity and longevity. **Every decision below
stays inside it.** The goal is *extensible within the constraint*, never "adopt a framework."

## Where the current shape strains

- `public/app.js` is a **~900-line single file, no modules** — all globals (`state`, `activeMode`,
  `doCheck`, `grade`, `renderDrill`, `scoreBinomial`…).
- Study **modes are `if/else` branches** inside `doCheck` / `renderDrill` keyed off `activeMode`.
  Every new mode (discrimination, cloze, MCQ, decks) adds more branches to the God file.
- The matcher is unit-tested by **slicing app.js by string offset** and `eval`-ing it — a documented
  trap (move a marker, tests silently pass while testing nothing).
- The roadmap adds many modes + per-taxon enrichment (diagnostic characters, etymology, range) +
  analytics (confusion graph, readiness). Without structure this degrades fast.

## Principles already true — keep enforcing

- **Pure core, thin shell.** `pickTaxon`, `applyCuration`, `scoreBinomial`, `licenseOk` are pure and
  unit-tested; DOM/IO sits at the edges. This is the single most important habit given no framework —
  it's what makes the code testable without one.
- **Progress must survive.** State is additive; `localStorage` + best-effort server sync; "more reps
  wins." Never break old saves.
- **Side-car overrides don't touch the spine.** `data/curate.json` overrides photos per taxon without
  editing `taxa.json`. Generalize this pattern (below).

## Target structure — within zero-dep / no-build

### 1. Native ES modules (the keystone)
Browsers and Node both run ES modules with **no bundler**. Split `app.js` into focused modules and
let tests `import` them instead of `eval`-slicing:

```
public/
  main.js         boot + wiring
  store.js        state shape, load/save, schema migration
  scheduler.js    ladder / due / leech / isSolid
  matcher.js      norm, scoreBinomial, scoreCommon, pickTaxon-side (client scoring)
  api.js          fetch helpers for /api/*
  modes/          one file per study mode (see registry)
  ui.js           small render helpers (no framework)
```
This alone kills the string-slice test hack — `test/` imports `matcher.js` directly.

### 2. Study-mode registry — the biggest extensibility win  *(done)*
Instead of `activeMode === '...'` branches scattered through `renderDrill` / `doCheck` / `reveal`,
the six modes are entries in one `MODES` registry, each **data** that render/check/reveal dispatch off:

```js
// public/app.js
const MODES = {
  photo2sci: { label, ask, typed: true,  photo: true,  prompt: 'photo',  answer: 'latin'  },
  com2sci:   { label, ask, typed: true,  photo: false, prompt: 'common', answer: 'latin'  },
  sci2fam:   { label, ask, typed: false, photo: false, prompt: 'latin',  choice: 'family' },
  // …
};
```
`prompt` = what the card shows (photo | common | latin); `answer` = how a typed reply is scored
(latin | common); `choice` = the field a multiple-choice mode asks for. **A new mode is a new entry,
not a new branch.** A radically different future mode (discrimination, cloze, MCQ) whose render/score
don't fit these attributes adds its own behaviour *functions* to its entry — the registry is still
the single dispatch point, reusing the shared scheduler + scoring.

### 3. Storage adapter (repository)
Put state access behind a tiny interface — `loadState(profile)` / `saveState(profile, state)` — so
today's `data/states/<profile>.json` files can become a real DB when accounts arrive, with the swap
localized to one module. (Directly serves the productization plan's auth phase.)

### 4. Data-source adapter
Photo sourcing already has implicit strategies (`fetchCuratedPhotos`, `fetchObservationPhotos`).
Formalize a `PhotoSource` interface so a future source could plug in behind the same shape — with the
licensing caveat from the productization plan (Calflora/CalPhotos aren't commercial-safe).

### 5. Side-car enrichment convention
`taxa.json` stays the **stable spine**. Optional enrichment lives in separate id-keyed files,
lazy-loaded only when a feature needs them:

```
data/enrich/diagnostic.json   { "<id>": ["phyllary appressed", ...] }
data/enrich/etymology.json    { "<id>": "agrifolia = holly-leaved" }
data/enrich/range.json        …phenology, confusion-pairs, etc.
```
Generalizes `curate.json`. Keeps the core stable, makes the content-heavy roadmap items (diagnostic
characters, etymology, range) incremental and independently sourced.

### 6. Versioned, additive state schema
Add a `schemaVersion` and migrate on load. Only **add** fields (mis-answers, per-mode stats,
confidence, timing) — never rename/remove. This is how the confusion graph and fluency features land
without breaking anyone's saved progress.

## Server

Keep the stdlib `http` router, but structure it: a **route table** + concern modules
(`photos`, `state`, `auth`-later) instead of one growing `if` chain. Storage behind the adapter.
No Express — it violates the constraint and isn't needed at this scale.

## Testing

- Migrate the matcher off the string-slice hack to `import` + **`node:test`** (stdlib, Node 18+).
- Keep `scripts/check.sh` as the single gate; keep pushing logic into pure functions so coverage is
  cheap and network/DOM stays at the edges.

## The one real fork — ADR-001: stay lean vs. adopt a build/framework

**Decision (now): stay zero-dep vanilla + native ES modules.** It's the project's whole ethos, keeps
deploy/ops trivial, and ES modules + `node:test` give real structure without a toolchain.

**Revisit only when a concrete trigger fires:**
- a *team* forms (shared conventions/tooling start to pay for themselves), or
- UI interactivity outgrows hand-rolled string-template rendering (lots of stateful components), or
- SSR/SEO or a marketing site needs a different stack.

Until then, lean wins. If a trigger fires, record it as ADR-002 here before changing course.

## How this makes the roadmap cheap

| Roadmap feature (`learning-features.md`) | Becomes / reuses |
|---|---|
| Discrimination drills, cloze, MCQ, recognition-first | **mode registry** entries (reuse scheduler + scoring) |
| Confusion graph, fluency/speed, confidence | **additive state fields** captured in the mode shell + an analytics read |
| Readiness estimate, weak-spot sessions | **analytics** over per-card stats (no new storage) |
| Diagnostic characters, etymology, range/phenology | **side-car enrichment** files + one loader |
| Custom / field-trip decks | a **deck** built from the existing filters + scheduler (+ iNat via the api adapter) |
| Auth / per-user accounts | **storage adapter** swap (file → DB) |

The point: after a modest refactor (modules + mode registry + adapters + side-car convention), each
roadmap item is a small, isolated addition — not another branch in a 900-line file.

## Structural refactor — done

The behaviour-preserving refactor is complete, in three slices under `check.sh` (each verified in a
real browser):

1. **`matcher.mjs`** — the answer matcher as a pure ES module; `app.js` is now `<script type="module">`
   and the scoring test imports the module (retiring the string-slice/eval hack). `.mjs` served with a
   JS MIME.
2. **`scheduler.mjs`** — the ladder + grade transitions, now with unit tests they never had.
3. **`MODES` registry** — render/check/reveal dispatch off per-mode data; no `activeMode === '...'`
   branches remain.

Still available when needed (not yet built): the storage adapter (§3, for accounts), the data-source
adapter (§4), and the side-car enrichment convention (§5) — pull these in as the features that need
them arrive. Next: pick a feature from `learning-features.md` and build it as a registry entry +
additive state, not a branch.
