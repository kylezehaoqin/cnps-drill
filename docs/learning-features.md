# Feature roadmap — from a drill into a real learning tool

**Date:** 2026-08-05 · Companion to `docs/productization-plan.md`

## Framing

It's already a strong spaced-repetition **drill**: typed recall scored the way the Board scores,
photo→sci/common/family/habit modes, the minute-scale cram ladder, family filters, leech tracking,
an exam mode against the 75% bar. That's a good foundation. The gap between "flashcards" and "learns
to identify plants in the field" is a handful of specific capabilities grounded in how people learn
to **discriminate categories** — which is exactly what sight-ID is.

Ordered by learning ROI, not by ease.

---

## 1. Discrimination training — the highest-value addition

Sight-ID is a *discrimination* task: telling *Salvia apiana* from *S. mellifera*, one oak from the
next. Isolated flashcards teach recognition-in-isolation; the exam and the field demand telling
look-alikes **apart**. This is the single biggest lever, and it reuses the photo cache we just built.

- **Confusion-pair drills:** show two (or more) similar taxa together and ask which is which. Build
  the confusion sets from taxonomy (same genus) *and* from the user's own error data — the pairs
  they actually mix up.
- **"Which is X" / odd-one-out:** four similar photos, pick the target.
- **Adaptive confusables:** when a user answers taxon A as taxon B, schedule A and B close together
  so the contrast gets trained, not just the individual cards.

## 2. Understand, don't just memorize

- **Diagnostic characters on reveal:** the 2–3 features that separate this taxon from its
  look-alikes (leaf, phyllary, bark, habit). Turns a name into a *decision rule*. Source from Jepson.
- **Etymology / name meaning:** *agrifolia* = holly-leaved, *tridentata* = three-toothed. Latin
  epithets become mnemonics once decoded — show the meaning.
- **Habitat / phenology context:** where it grows, elevation, bloom time. The field uses context,
  and context aids recall.

## 3. Onboarding & scaffolding (so 500 blank fields don't crush a beginner)

- **Recognition before recall:** multiple-choice for new/young cards (pick the name from four),
  graduating to free typing as a card matures. Builds confidence and matches how people actually
  learn a new category.
- **Genus-first gestalt:** learn to recognize the genus ("that's a *Ceanothus*"), then the species
  within it.
- **Guided family sessions** (the filter exists): a path through the lopsided families (Asteraceae
  72, Poaceae 37) with the shared characters called out up front.

## 4. Image depth (the new photo pipeline sets this up)

- **Organ-tagged plates:** flower / leaf / bark / habit / fruit, so a plant is learnable from any
  part — the field rarely hands you the perfect flowering specimen.
- **Range of variation:** flowering vs vegetative, seasonal states; the exam may show either.
- **Zoom / gallery** on the diagnostic detail.

## 5. Exam realism & readiness

- **A readiness estimate:** "at your current accuracy on *unseen* taxa you'd score ~68%; 82% of the
  pool is solid" — predict pass probability against the 75% bar. This is the metric users actually
  care about, and the drill tally alone doesn't tell them.
- **Full mock exams** matching the Board's format, scoring, and timing, with a **post-mortem** of
  misses grouped by family and by confusion pair.
- **Weak-spot sessions:** one tap to drill only your leeches *and their confusables*.

## 6. Engagement / retention (light touch)

- **Streaks + a daily plan** tied to the exam countdown — the ladder already computes the target;
  surface it ("do 40 today to stay on track for Friday").
- **Progress you can feel:** family-mastery bars, "solid" counts, a shrinking pool.
- Keep it calm and study-focused; avoid gamification that competes with learning.

## 7. Platform

- **Installable mobile PWA + offline:** field botanists study on trails and in cars. The app is
  already web-based and offline-capable (`OFFLINE` mode, `localStorage`); a manifest + service worker
  makes it installable and usable with no signal. High fit for this audience, modest effort.

---

## Deliberately out of scope (for now)

- The exam's **keying** and **CEQA/protocol** components — this tool covers sight-ID; be explicit
  about that rather than half-building the others.
- Social / shared-deck features — scope creep before retention is proven.

## Suggested priority

1. **Discrimination / confusion training** (§1) — biggest learning ROI, reuses the photos.
2. **Diagnostic characters on reveal** (§2) — turns memorization into understanding.
3. **Recognition-first scaffolding** (§3) — fixes the beginner cliff, helps retention.
4. **Readiness estimate + mock-exam post-mortem** (§5) — gives users the number they want.
5. **Mobile/offline PWA** (§7) — matches how this audience studies.

Everything past retention (§6) waits until the first cohort actually comes back and passes.

---

# Second wave

Deeper, mostly data-driven ideas that extend the sections above rather than repeat them.

**Shared prerequisite:** a card currently stores only *counts* — `{ step, due, reps, lapses, right,
wrong, last }` (`public/app.js:53`). It does not record *what* the user typed when wrong. Capturing
the mis-answer at grade time (a small `grade()` / `doCheck()` change) unlocks the flagship below and
sharpens several others.

## Flagship — an error-driven personal confusion graph

The matcher already scores a typed answer and can tell a *valid-but-wrong* name from a typo. Persist
those mis-answers, build a per-user graph of "typed A for B," and use it to (a) auto-generate
targeted **A-vs-B** remediation and (b) schedule confusable pairs together. This is the moat a static
flashcard app can't have: it feeds the discrimination drills (§1) with the user's *real* confusions
instead of taxonomy guesses, and it plugs straight into the existing weakest-first due-sort
(`app.js:342`). Start here — most of wave 2 gets better with this signal.

## A. Turn every miss into a lesson

- **"Why you missed it":** on reveal after a wrong answer, show the diagnostic character that
  separates the taxon from what the user actually typed — the highest-leverage teachable moment, and
  the concrete payoff of §2's diagnostic characters.
- **Cumulative "boss" reviews:** periodic mixed cumulative quizzes to puncture the illusion of
  mastery that massed, same-session practice creates.

## B. Vary and tune the retrieval (desirable difficulties)

- **Hint ladder:** stuck → reveal genus → first letter → full name. Keeps retrieval effortful without
  a hard give-up (which teaches nothing).
- **Cloze / half-prompts:** "*Quercus* ____" (fill the epithet) or "____ *agrifolia*" (fill the
  genus). Targets whichever half is weak — and since the matcher already scores genus and epithet
  **separately**, the plumbing is largely there.
- **Confidence calibration:** rate "sure / unsure" before reveal and track over- vs under-confidence.
  Miscalibration is a real exam failure mode; it's a toggle plus one stat.
- **Fluency / speed:** record time-to-answer. Recognition *speed* distinguishes true mastery from
  effortful recall and matters in a paced exam — `isSolid()` could require accuracy **and** speed.
- **Adaptive new-card rate:** auto-tune intake to recent accuracy/load (today `newLimit` is a fixed
  `state.cfg` value) to keep the user in productive struggle and head off overload-driven quitting.

## C. Relevance & motivation

- **Custom / field-trip decks:** drill "the taxa I actually need" — a region, a course list, or
  species logged from an iNaturalist outing. Relevance drives daily adherence more than streaks do.
- **Range maps + phenology** (CalFlora / Calscape) for field realism — *where* and *when*, not just
  *what*.
- **Audio pronunciation** of the Latin — low effort, real value; people avoid names they can't say.
- **Printable / exportable review** for screen-free, offline, paper study.

## D. Long-term retention (post-exam)

- A proper **FSRS-style scheduler** for the `LADDER_LONG` phase, so the tool stays useful *after* the
  cram — turning one-time exam crammers into long-term users. Retention is what makes it a product,
  not a single-use utility.

## Suggested priority (wave 2)

1. **Capture mis-answers → confusion graph** — unlocks the flagship and gives §1 real signal.
2. **"Why you missed it"** feedback — best teachable moment, small change.
3. **Cloze / half-prompts** — reuses separate genus/epithet scoring, targets the weak half.
4. **Confidence calibration + speed** — metacognition and fluency, cheap, high signal.
5. **Custom / field-trip decks** — relevance and motivation.

---

# Decision — comparing the learning features

Scoring only the features that move **learning efficiency/effectiveness** (platform, motivation,
and relevance-only items are excluded — PWA, streaks, custom decks, audio, printable). Two axes that
matter and are usually conflated:

- **Effectiveness** — does it make knowledge *stick and transfer* to the field/exam?
- **Efficiency** — does it cut *wasted* study time (not re-drilling what you know, not drowning)?

And the axis that decides feasibility more than "size" does:

- **New per-taxon data?** — anything needing content we don't have (diagnostic characters, range
  maps) is a **500× sourcing project**, not a code change. This is the real gate.

| Feature | Effectiveness | Efficiency | Evidence base | Build | New per-taxon data? | Depends on |
|---|---|---|---|---|---|---|
| **Confusion graph** (capture mis-answers + adaptive scheduling) | Med (enabler) | **High** | High (error-driven) | S+M | **No** | — |
| **Confusion-pair discrimination drills** (§1) | **High** | **High** | High (contrastive) | M | No* | better w/ graph |
| **Cloze / half-prompts** (genus *or* epithet) | Med | **High** | Med | **S** | **No** | — |
| **Fluency / speed** signal | Med | Med | Med (automaticity) | S | **No** | — |
| **Confidence calibration** | Med | Low | Med (metacognition) | **S** | **No** | — |
| **Hint ladder** (genus → letter → full) | Med | Med | Med (desirable difficulty) | **S** | **No** | — |
| **Recognition-first** scaffolding (§3) | Med | High (beginners) | Med | M | No | — |
| **Adaptive new-card rate** (§B) | Low | **High** | Med (cognitive load) | M | No | — |
| **Diagnostic characters on reveal** (§2) | **High** | Med | High (rule-based transfer) | M | **YES — heavy** | content source |
| **"Why you missed it"** (§A) | **High** | High | High (feedback at error) | M | **YES — heavy** | diag. chars + graph |
| **Readiness estimate** (§5) | Low (directs, doesn't teach) | Med | — (metric) | M | No | — |
| **FSRS long-term** scheduler (§D) | Med | **High** | High (spacing) | L | No | post-exam |

\* pairs can be seeded from taxonomy (same genus); they get much better with the confusion graph.

## The few that matter most

Three clusters fall out of the matrix.

**Build now — high impact, no content dependency, small-to-medium effort:**
1. **Error-driven confusion graph** (capture + adaptive scheduling). The foundation: cheap, no new
   data, and it makes the tool adapt to *this* learner's real mistakes. Everything discrimination-
   related gets better once this exists.
2. **Confusion-pair discrimination drills.** The actual differentiator and the skill the exam tests —
   telling look-alikes apart. Uses the photos we just fixed, plus the graph for real pairs.
3. **Cloze / half-prompts.** The cheapest efficiency win; stops re-drilling the half you already know,
   and the matcher already scores genus and epithet separately.

Layer in the near-free signals alongside these: **fluency/speed** and **confidence calibration** are
tiny and make the scheduler and the readiness estimate smarter later.

**Decide separately — highest *teaching* value, but a content project:**
- **Diagnostic characters on reveal** + **"why you missed it."** These are the strongest
  effectiveness items in the table and turn memorization into field-usable rules — but both require
  sourcing 2–3 diagnostic features for ~500 taxa (Jepson). That's a curation effort, not a code
  sprint. Worth committing to, but as its own project with its own budget — don't let it block the
  three above.

**Later / product phase:** **recognition-first scaffolding** matters once beginners arrive;
**readiness estimate** rides along with exam-mode work; **FSRS** is for post-exam retention.

## Table-stakes vs nice-to-have

To your instinct that some wave-1 items are "just necessary": **discrimination training (§1)** and
**diagnostic characters (§2)** are table-stakes for anything calling itself an *ID* trainer — the
difference is §1 is cheap and §2 is a content project. Everything else is genuine upside, not a
requirement.

**Recommended build order:** confusion-graph capture → discrimination drills → cloze/half-prompts
(these three, none blocked on content) → then commit-or-defer the diagnostic-character layer.
