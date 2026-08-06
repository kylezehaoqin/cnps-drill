/* Answer matching — how a typed determination is scored, the way the Board
   scores it. Pure functions, no DOM: imported by public/app.js and by
   test/scoring.test.mjs (which is why this is a standalone ES module rather than
   a slice of app.js). Change a rule here and add a regression test in the same
   commit — see CLAUDE.md Invariants. */

export function norm(s) {
  return String(s).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(ssp|subsp|var|spp|forma|cv)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
/* Hyphenated epithets (filix-femina, bursa-pastoris, pes-caprae) normalise to
   two words. Comparing them space-free lets "filix femina", "filix-femina"
   and "filixfemina" all land on the same key. */
export const key = s => norm(s).replace(/ /g, '');

export function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/* Tolerance: an intact three-letter stem plus an edit distance under a
   quarter of the target length. Both halves earn their keep. Hordeum
   marinum and murinum are both on the list and differ by one letter, so
   only the stem rule keeps them apart; the ratio is what lets "Escholzia"
   through for "Eschscholzia". A near match scores the point the way a human
   grader would treat a slip, and is flagged amber so the slip stays visible.
   Strict mode demands an exact match. */
export function wordMatch(guess, target, strict, reserved) {
  if (!guess || !target) return 'miss';
  if (guess === target) return 'got';
  if (strict) return 'miss';
  if (target.length < 5 || guess.length < 3) return 'miss';
  if (guess.slice(0, 3) !== target.slice(0, 3)) {
    // The three-letter stem is normally sacred (it is the only thing keeping
    // Hordeum marinum and murinum apart). But a single typo landing inside the
    // stem — Monuartia for Minuartia — otherwise scores nothing, which no human
    // grader would do. Forgive one edit in the stem ONLY when the typed word is
    // not itself a real name in this slot; that veto is what still separates
    // marinum from murinum, since both are real epithets on the list. No index
    // (common-name path, or matcher used before indexNames ran) -> stay strict,
    // so an un-indexed matcher can never over-credit.
    if (!reserved || !reserved.size || reserved.has(guess)) return 'miss';
    return lev(guess, target) <= 1 ? 'near' : 'miss';
  }
  const d = lev(guess, target);
  if (d > 3) return 'miss';
  return d / target.length <= 0.25 ? 'near' : 'miss';
}
export const scored = r => r === 'got' || r === 'near';
export const best = (a, b) => (a === 'got' || b === 'got') ? 'got' : (a === 'near' || b === 'near') ? 'near' : 'miss';

/* Every real name in each binomial slot, so the stem-typo relaxation in
   wordMatch can forgive a slip without forgiving a guess that is itself a
   distinct taxon. Populated once from the taxa list (indexNames) at boot and in
   the tests; empty until then, which keeps the relaxation inert and safe. */
const RESERVED = { genera: new Set(), epithets: new Set() };
export function indexNames(taxa) {
  RESERVED.genera.clear();
  RESERVED.epithets.clear();
  for (const t of taxa || []) {
    if (t.genus) RESERVED.genera.add(key(t.genus));
    if (t.epithet) RESERVED.epithets.add(key(t.epithet));
    for (const alt of t.alts || []) {
      const parts = norm(alt).split(' ').filter(Boolean);
      if (parts[0]) RESERVED.genera.add(key(parts[0]));
      const ep = key(parts.slice(1).join(' '));
      if (ep) RESERVED.epithets.add(ep);
    }
  }
}

/* Scores a Latin binomial the way the Board does: one point genus, one point
   specific epithet. Genus-only taxa are worth one point total. */
export function scoreBinomial(input, taxon, strict) {
  const toks = norm(input).split(' ').filter(Boolean);
  if (!toks.length) return { genus: 'miss', species: taxon.epithet ? 'miss' : null,
                             pts: 0, exact: 0, max: taxon.epithet ? 2 : 1, full: false, clean: false };

  const gTarget = key(taxon.genus);
  const eTarget = taxon.epithet ? key(taxon.epithet) : '';
  const altG = (taxon.alts || []).map(a => key(norm(a).split(' ')[0])).filter(Boolean);
  const altE = (taxon.alts || []).map(a => key(norm(a).split(' ').slice(1).join(' '))).filter(Boolean);

  const match = (cand, primary, alts, reserved) => {
    let r = wordMatch(cand, primary, strict, reserved);
    for (const a of alts) { if (r === 'got') break; r = best(r, wordMatch(cand, a, strict, reserved)); }
    return r;
  };

  let genus = 'miss', genusToken = -1;
  toks.forEach((t, i) => {
    const r = match(t, gTarget, altG, RESERVED.genera);
    if (r === 'got' && genus !== 'got') { genus = 'got'; genusToken = i; }
    else if (r === 'near' && genus === 'miss') { genus = 'near'; genusToken = i; }
  });

  let species = null;
  if (eTarget) {
    species = 'miss';
    // A token that already paid for the genus cannot also pay for the species,
    // or "Cornus nuttallii" scores full marks against Corylus cornuta.
    const rest = toks.filter((_, i) => i !== genusToken);
    const cands = rest.slice();
    if (rest.length > 1) {
      cands.push(rest.join(''));                                  // filix femina -> filixfemina
      for (let i = 0; i < rest.length - 1; i++) cands.push(rest[i] + rest[i + 1]);
    }
    for (const c of cands) {
      species = best(species, match(c, eTarget, altE, RESERVED.epithets));
      if (species === 'got') break;
    }
  }

  const pts   = (scored(genus) ? 1 : 0) + (scored(species) ? 1 : 0);
  const exact = (genus === 'got' ? 1 : 0) + (species === 'got' ? 1 : 0);
  const max   = 1 + (eTarget ? 1 : 0);
  return { genus, species, pts, exact, max, full: pts === max, clean: exact === max };
}

/* Words that carry no identifying weight in a California common name. A guess
   made only of these is not an answer. */
const GENERIC = new Set(('common western eastern northern southern coast coastal california californian '
  + 'sierra sierran desert mountain mountains valley giant dwarf small large tall little great '
  + 'grass grasses brome bunchgrass sedge rush reed fern oak pine fir cedar cypress willow maple '
  + 'alder ash walnut cherry rose currant gooseberry sage sagebrush bush shrub tree vine herb weed '
  + 'flower flowered leaf leaved leaves plant wild true false native').split(' '));

/* Common names carry alternates separated by commas, ampersands or "or", and
   people answer with a shortened form far more often than the full string.
   "gray pine" for "Gray or Foothill Pine" and "poison oak" for "Western Poison
   Oak" both have to land. */
export function scoreCommon(input, taxon, strict) {
  const guess = norm(input);
  if (!guess) return { result: 'miss', full: false };
  const gToks = guess.split(' ').filter(w => w && w !== 'or');
  if (!gToks.length) return { result: 'miss', full: false };

  const phrases = new Set([norm(taxon.common)]);
  taxon.common.split(/,|&/).forEach(chunk => {
    // "Gray or Foothill Pine" names two things, and the head noun belongs to
    // both. Without distributing it, "gray pine" — the name most people
    // actually use for Pinus sabiniana — matches nothing.
    const alts = chunk.split(/\bor\b/i).map(norm).filter(Boolean);
    const tail = alts.length ? alts[alts.length - 1].split(' ') : [];
    alts.forEach(a => {
      const w = a.split(' ');
      phrases.add(a);
      if (w.length < tail.length) phrases.add(w.concat(tail.slice(w.length)).join(' '));
    });
  });

  let out = 'miss';
  for (const phrase of phrases) {
    const pToks = phrase.split(' ').filter(w => w && w !== 'or');
    out = best(out, wordMatch(guess.replace(/ /g, ''), phrase.replace(/ /g, ''), strict));
    if (out === 'got') return { result: 'got', full: true };
    if (strict) continue;

    // A shortened answer is accepted only when three things hold: every word
    // of the guess appears in the phrase, the head noun lines up, and the
    // guess carries at least one non-generic word. All three are load-bearing.
    // Subset alone let "White Alder" match "California White Fir" — 202 such
    // collisions across the list, because the head nouns are generic and the
    // shared modifier carried the match on its own.
    if (!gToks.some(w => !GENERIC.has(w))) continue;
    const has = w => pToks.some(p => p === w || scored(wordMatch(w, p, false)));
    if (!gToks.every(has)) continue;
    const head = gToks[gToks.length - 1], pHead = pToks[pToks.length - 1];
    if (head !== pHead && !scored(wordMatch(head, pHead, false))) continue;
    out = best(out, 'near');
  }
  return { result: out, full: out !== 'miss' };
}
