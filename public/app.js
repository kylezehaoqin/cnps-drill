'use strict';
/* CNPS Sight-ID Drill — client */

/* ============================ constants ============================ */

const HABITS = {
  AF:'Annual fern / ally', AG:'Annual grass / graminoid', AH:'Annual herb',
  AV:'Annual vine', BH:'Biennial herb', PF:'Perennial fern / ally',
  PG:'Perennial grass / graminoid', PH:'Perennial herb', PV:'Perennial vine',
  P:'Perennial', S:'Shrub', T:'Tree', ST:'Shrub / tree',
};
const habitLabel = h => h.split('/').map(x => HABITS[x.trim()] || x).join(' / ');

const MODES = {
  photo2sci: { label: 'Photo \u2192 Latin',  ask: 'Name this specimen',            typed: true,  photo: true },
  photo2com: { label: 'Photo \u2192 common', ask: 'Common name for this specimen', typed: true,  photo: true },
  sci2com:   { label: 'Latin \u2192 common', ask: 'Give the common name',          typed: true,  photo: false },
  com2sci:   { label: 'Common \u2192 Latin', ask: 'Give the scientific name',      typed: true,  photo: false },
  sci2fam:   { label: 'Latin \u2192 family', ask: 'Which family?',                 typed: false, photo: false },
  sci2hab:   { label: 'Latin \u2192 habit',  ask: 'Which habit class?',            typed: false, photo: false },
};

const HABIT_GROUPS = {
  'Trees & shrubs':        t => /^(T|S|ST|S\/T|T\/S|PH\/S|S\/V)$/.test(t.habit),
  'Grasses & graminoids':  t => /G/.test(t.habit),
  'Herbs':                 t => /^(AH|PH|BH|A\/PH|A\/BH|AH\/BH|AH\/PH|P)$/.test(t.habit),
  'Ferns & allies':        t => /F$/.test(t.habit),
  'Vines':                 t => /V/.test(t.habit),
};

/* Cram ladder in minutes — the exam is days away, so day-scale
   SM-2 intervals are useless. Long-term ladder is for after. */
const LADDER_CRAM = [1, 6, 20, 60, 240, 720, 1440, 2880];
const LADDER_LONG = [10, 1440, 4320, 10080, 21600, 43200, 86400];
const MIN = 60000;

const DEFAULT_CFG = {
  modes: ['photo2sci'], family: '', habits: [], nativity: 'all',
  genusOnly: false, newLimit: 40, ladder: 'cram', examDate: '',
  strict: false, profile: 'default',
};

/* ============================ state ============================ */

let TAXA = [], BY_ID = new Map(), FAMILIES = [];
let state = { cards: {}, seenToday: 0, dayStamp: dayStamp(), history: [], cfg: { ...DEFAULT_CFG } };
let queue = [], current = null, activeMode = 'photo2sci';
let revealed = false, answeredCorrect = null, photoIndex = 0, photoData = null;
let exam = null;

function dayStamp() { const d = new Date(); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
function card(id) {
  if (!state.cards[id]) state.cards[id] = { step: -1, due: 0, reps: 0, lapses: 0, right: 0, wrong: 0, last: 0 };
  return state.cards[id];
}
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; }

/* ============================ persistence ============================ */
/* localStorage is the source of truth and is written synchronously on every
   answer. The server copy is a best-effort mirror so progress follows the
   device. Either can be missing without breaking the other. */

const LS_KEY = () => `cnps-drill:${state.cfg.profile}`;
let syncTimer = null, lastServerOk = 0;

function saveLocal() {
  try {
    localStorage.setItem(LS_KEY(), JSON.stringify(state));
    return true;
  } catch (e) { return false; }
}

function save() {
  const localOk = saveLocal();
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    try {
      const r = await fetch(`/api/state/${encodeURIComponent(state.cfg.profile)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
      if (!r.ok) throw new Error(r.status);
      lastServerOk = Date.now();
      setSync(`saved \u00b7 ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, false);
    } catch (e) {
      setSync(localOk ? 'saved on this device \u00b7 server sync failed' : 'NOT SAVED \u2014 storage blocked', !localOk);
    }
  }, 600);
}

function setSync(msg, bad) {
  const el = $('#sync');
  if (el) { el.textContent = msg; el.classList.toggle('bad', !!bad); }
}

async function load(profile) {
  const cfgProfile = profile || localStorage.getItem('cnps-drill:lastProfile') || 'default';
  let local = null, server = null;
  try { local = JSON.parse(localStorage.getItem(`cnps-drill:${cfgProfile}`) || 'null'); } catch {}
  try {
    const r = await fetch(`/api/state/${encodeURIComponent(cfgProfile)}`);
    if (r.ok) server = await r.json();
  } catch {}

  // Whichever has more total reps wins; ties go to local.
  const weight = s => s ? Object.values(s.cards || {}).reduce((n, k) => n + (k.reps || 0), 0) : -1;
  const chosen = weight(server) > weight(local) ? server : local;

  if (chosen) {
    state = Object.assign({ cards: {}, seenToday: 0, dayStamp: dayStamp(), history: [] }, chosen);
    state.cfg = Object.assign({ ...DEFAULT_CFG }, chosen.cfg || {});
  }
  state.cfg.profile = cfgProfile;
  if (!Array.isArray(state.cfg.modes) || !state.cfg.modes.length) state.cfg.modes = ['photo2sci'];
  if (!Array.isArray(state.history)) state.history = [];
  if (state.dayStamp !== dayStamp()) { state.dayStamp = dayStamp(); state.seenToday = 0; }
  localStorage.setItem('cnps-drill:lastProfile', cfgProfile);
}

/* ============================ answer matching ============================ */

function norm(s) {
  return String(s).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(ssp|subsp|var|spp|forma|cv)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
/* Hyphenated epithets (filix-femina, bursa-pastoris, pes-caprae) normalise to
   two words. Comparing them space-free lets "filix femina", "filix-femina"
   and "filixfemina" all land on the same key. */
const key = s => norm(s).replace(/ /g, '');

function lev(a, b) {
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
function wordMatch(guess, target, strict) {
  if (!guess || !target) return 'miss';
  if (guess === target) return 'got';
  if (strict) return 'miss';
  if (target.length < 5 || guess.length < 3) return 'miss';
  if (guess.slice(0, 3) !== target.slice(0, 3)) return 'miss';
  const d = lev(guess, target);
  if (d > 3) return 'miss';
  return d / target.length <= 0.25 ? 'near' : 'miss';
}
const scored = r => r === 'got' || r === 'near';
const best = (a, b) => (a === 'got' || b === 'got') ? 'got' : (a === 'near' || b === 'near') ? 'near' : 'miss';

/* Scores a Latin binomial the way the Board does: one point genus, one point
   specific epithet. Genus-only taxa are worth one point total. */
function scoreBinomial(input, taxon, strict) {
  const toks = norm(input).split(' ').filter(Boolean);
  if (!toks.length) return { genus: 'miss', species: taxon.epithet ? 'miss' : null,
                             pts: 0, exact: 0, max: taxon.epithet ? 2 : 1, full: false, clean: false };

  const gTarget = key(taxon.genus);
  const eTarget = taxon.epithet ? key(taxon.epithet) : '';
  const altG = (taxon.alts || []).map(a => key(norm(a).split(' ')[0])).filter(Boolean);
  const altE = (taxon.alts || []).map(a => key(norm(a).split(' ').slice(1).join(' '))).filter(Boolean);

  const match = (cand, primary, alts) => {
    let r = wordMatch(cand, primary, strict);
    for (const a of alts) { if (r === 'got') break; r = best(r, wordMatch(cand, a, strict)); }
    return r;
  };

  let genus = 'miss', genusToken = -1;
  toks.forEach((t, i) => {
    const r = match(t, gTarget, altG);
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
      species = best(species, match(c, eTarget, altE));
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
function scoreCommon(input, taxon, strict) {
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

/* ============================ pool + scheduling ============================ */

function pool() {
  const c = state.cfg;
  return TAXA.filter(t => {
    if (c.family && t.family !== c.family) return false;
    if (c.nativity === 'native' && t.alien) return false;
    if (c.nativity === 'alien' && !t.alien) return false;
    if (c.genusOnly && !t.genusOnly) return false;
    if (c.habits.length && !c.habits.some(g => HABIT_GROUPS[g] && HABIT_GROUPS[g](t))) return false;
    return true;
  });
}

const ladder = () => (state.cfg.ladder === 'cram' ? LADDER_CRAM : LADDER_LONG);
const isSolid = k => k && k.step >= ladder().length - 2;

function counts() {
  const p = pool(), now = Date.now();
  let due = 0, neu = 0, learn = 0, solid = 0;
  for (const t of p) {
    const k = state.cards[t.id];
    if (!k || k.reps === 0) { neu++; continue; }
    if (isSolid(k)) solid++; else learn++;
    if (k.due <= now) due++;
  }
  return { due, neu, learn, solid, total: p.length };
}

function buildQueue(preserveCurrent) {
  const p = pool(), now = Date.now();
  const due = [], neu = [];
  for (const t of p) {
    const k = state.cards[t.id];
    if (!k || k.reps === 0) neu.push(t);
    else if (k.due <= now) due.push(t);
  }
  // Weakest first among due: more lapses and lower accuracy surface sooner.
  due.sort((a, b) => {
    const ka = state.cards[a.id], kb = state.cards[b.id];
    const sa = ka.lapses * 2 - (ka.right / Math.max(1, ka.right + ka.wrong));
    const sb = kb.lapses * 2 - (kb.right / Math.max(1, kb.right + kb.wrong));
    return sb - sa;
  });
  shuffle(neu);
  const room = Math.max(0, state.cfg.newLimit - state.seenToday);
  queue = due.concat(neu.slice(0, room));
  if (preserveCurrent && current && p.some(t => t.id === current.id)) return;
  if (!queue.length && p.length) queue = shuffle(p.slice()).slice(0, 20);
}

function nextCard() {
  if (!queue.length) buildQueue();
  current = queue.shift() || null;
  revealed = false; answeredCorrect = null; photoIndex = 0; photoData = null;
  activeMode = state.cfg.modes[(Math.random() * state.cfg.modes.length) | 0];
  renderDrill();
  renderTally();
}

function grade(q) {   // 0 again, 1 hard, 2 good, 3 easy
  const k = card(current.id);
  const wasNew = k.reps === 0;
  const L = ladder();
  if (q === 0) {
    k.lapses++; k.wrong++; k.step = 0;
    queue.splice(Math.min(queue.length, 3 + ((Math.random() * 4) | 0)), 0, current);
  } else {
    k.right++;
    if (q === 1) k.step = Math.max(0, k.step);
    if (q === 2) k.step = Math.min(L.length - 1, k.step + 1);
    if (q === 3) k.step = Math.min(L.length - 1, k.step + 2);
  }
  k.due = Date.now() + L[Math.max(0, k.step)] * MIN;
  k.reps++; k.last = Date.now();
  if (wasNew) state.seenToday++;
  state.history.push({ t: Date.now(), id: current.id, q, mode: activeMode });
  if (state.history.length > 4000) state.history = state.history.slice(-3000);
  save();
  nextCard();
}

/* ============================ photos ============================ */

const photoCache = new Map();

async function getPhotos(id) {
  if (photoCache.has(id)) return photoCache.get(id);
  const p = fetch(`/api/photos/${id}`).then(r => r.json()).catch(() => ({ photos: [], error: 'offline' }));
  photoCache.set(id, p);
  return p;
}

function renderPlate(host, taxon) {
  host.innerHTML = `<div class="plate loading"><div class="msg">loading plate\u2026</div></div>`;
  getPhotos(taxon.id).then(data => {
    if (!current || current.id !== taxon.id) return;
    photoData = data;
    drawPlate(host, taxon);
  });
}

function drawPlate(host, taxon) {
  const photos = (photoData && photoData.photos) || [];
  if (!photos.length) {
    host.innerHTML = `<div class="plate"><div class="msg">
      No cached plate for this taxon.<br>
      Run <b>node scripts/warm.js --retry</b> on the server,<br>
      or grade from the name alone.</div></div>`;
    return;
  }
  photoIndex = ((photoIndex % photos.length) + photos.length) % photos.length;
  const ph = photos[photoIndex];
  host.innerHTML = `
    <div class="plate">
      <img src="${esc(ph.url)}" alt="Unidentified specimen plate">
      <div class="ph-nav">
        <button data-d="-1" aria-label="Previous photo">\u2190</button>
        <span>plate ${photoIndex + 1} / ${photos.length}${ph.place ? ' \u00b7 ' + esc(ph.place) : ''}</span>
        <button data-d="1" aria-label="Next photo">\u2192</button>
      </div>
    </div>
    <div class="credit" id="credit"></div>`;
  host.querySelectorAll('.ph-nav button').forEach(b => {
    b.onclick = () => { photoIndex += Number(b.dataset.d); drawPlate(host, taxon); if (revealed) showCredit(); };
  });
  if (revealed) showCredit();
}

function showCredit() {
  const el = $('#credit');
  const photos = (photoData && photoData.photos) || [];
  if (!el || !photos.length) return;
  const ph = photos[photoIndex];
  el.textContent = [ph.attribution, ph.license ? ph.license.toUpperCase() : '', 'via iNaturalist']
    .filter(Boolean).join(' \u00b7 ');
}

/* ============================ drill rendering ============================ */

function renderDrill() {
  const stage = $('#stage');
  if (!current) {
    stage.innerHTML = `<div class="specimen done">
      <h2>Pool is empty</h2>
      <p>No taxa match the current filters. Widen them in Setup.</p></div>`;
    return;
  }
  const t = current, k = card(t.id), M = MODES[activeMode];
  const acc = (k.right + k.wrong) ? Math.round(100 * k.right / (k.right + k.wrong)) + '%' : '\u2014';
  const solid = isSolid(k) ? ' \u00b7 solid' : '';

  let head = '';
  if (M.photo) {
    const want = activeMode === 'photo2sci'
      ? '<b style="color:var(--det)">SCIENTIFIC NAME</b>'
      : '<b style="color:var(--det)">COMMON NAME</b>';
    head = `<div id="plate"></div><div class="ask">Write the ${want} for this specimen</div>`;
  } else if (activeMode === 'com2sci') {
    head = `<div class="ask">${M.ask}</div><p class="prompt">${esc(t.common)}</p>
            <p class="prompt-sub">${esc(habitLabel(t.habit))} \u00b7 ${esc(t.family)}</p>`;
  } else {
    head = `<div class="ask">${M.ask}</div><p class="prompt latin">${esc(t.sci)}</p>`;
  }

  stage.innerHTML = `<div class="specimen">
    <div class="accession"><span>CNPS-${String(t.id + 1).padStart(3, '0')}</span>
      <span>reps ${k.reps} \u00b7 acc ${acc}${solid}</span></div>
    ${head}
    <div id="responder"></div>
  </div>`;

  if (M.photo) renderPlate($('#plate'), t);

  const responder = $('#responder');
  if (M.typed) {
    const latin = activeMode === 'photo2sci' || activeMode === 'com2sci';
    responder.innerHTML = `<div class="entry">
      <label for="ans">${latin ? 'Determination \u2014 genus + specific epithet' : 'Common name'}</label>
      <input type="text" id="ans" class="${latin ? '' : 'plain'}" autocomplete="off"
             autocapitalize="off" autocorrect="off" spellcheck="false"
             placeholder="${latin ? 'e.g. Quercus agrifolia' : 'e.g. coast live oak'}">
      <div class="entry-row">
        <button class="btn" id="check">Check determination</button>
        <button class="btn ghost" id="skip" style="flex:0 0 auto;padding-left:16px;padding-right:16px">Don't know</button>
      </div>
    </div><div id="post"></div>`;
    const input = $('#ans');
    input.focus();
    input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); doCheck(); } };
    $('#check').onclick = doCheck;
    $('#skip').onclick = () => doCheck(true);
  } else {
    renderChoices(responder, t, activeMode);
  }
}

function renderChoices(host, t, mode) {
  const isFam = mode === 'sci2fam';
  const correct = isFam ? t.family : t.habit;
  const source = isFam ? TAXA.filter(x => x.habit === t.habit).map(x => x.family) : Object.keys(HABITS);
  const opts = new Set([correct]);
  let guard = 0;
  while (opts.size < 4 && guard++ < 500) { const v = source[(Math.random() * source.length) | 0]; if (v) opts.add(v); }
  const list = shuffle([...opts]);
  host.innerHTML = `<div class="choices">` + list.map(v =>
    `<button data-v="${esc(v)}">${esc(isFam ? v : v + ' \u2014 ' + habitLabel(v))}</button>`).join('')
    + `</div><div id="post"></div>`;
  host.querySelectorAll('.choices button').forEach(b => {
    b.onclick = () => {
      if (revealed) return;
      const ok = b.dataset.v === correct;
      host.querySelectorAll('.choices button').forEach(x => {
        x.disabled = true;
        if (x.dataset.v === correct) x.classList.add('right');
        else if (x === b) x.classList.add('wrong');
      });
      reveal(ok, null);
    };
  });
}

function doCheck(skipped) {
  if (revealed) return;
  const t = current;
  const val = skipped ? '' : ($('#ans') ? $('#ans').value.trim() : '');
  if (!skipped && !val) { $('#ans').focus(); return; }

  let scoreHTML = '', ok = false;
  if (activeMode === 'photo2sci' || activeMode === 'com2sci') {
    const s = skipped ? { genus: 'miss', species: t.epithet ? 'miss' : null, pts: 0, exact: 0, max: t.epithet ? 2 : 1, full: false, clean: false }
                      : scoreBinomial(val, t, state.cfg.strict);
    ok = s.full;
    if (!ok && !skipped && scoreCommon(val, t, false).full) {
      const slipHTML = `<div class="score"><span class="pt near">that is the common name and it is right \u2014 this card wanted the binomial</span></div>`;
      reveal(false, slipHTML);
      return;
    }
    const chips = [`<span class="pt ${s.genus}">genus ${s.genus !== 'miss' ? '1' : '0'}/1</span>`];
    if (s.species !== null) chips.push(`<span class="pt ${s.species}">species ${s.species !== 'miss' ? '1' : '0'}/1</span>`);
    else chips.push(`<span class="pt got">genus-level taxon</span>`);
    if (!s.clean && s.pts) chips.push(`<span class="pt near">spelling off \u2014 point given, but write it out again</span>`);
    scoreHTML = `<div class="score">${chips.join('')}<span class="pt">${s.pts}/${s.max} points</span></div>`;
  } else {
    const s = skipped ? { result: 'miss', full: false } : scoreCommon(val, t, state.cfg.strict);
    ok = s.full;
    const chips = [`<span class="pt ${s.result}">${
      s.result === 'got' ? 'correct' : s.result === 'near' ? 'close enough' : 'not it'}</span>`];
    // Two photo modes look almost identical, so answering the wrong one is
    // easy and being told "not it" for a correct binomial is maddening.
    if (!ok && !skipped && scoreBinomial(val, t, false).full) {
      chips.push(`<span class="pt near">that is the scientific name and it is right \u2014 this card wanted the common name</span>`);
      ok = true;
    }
    scoreHTML = `<div class="score">${chips.join('')}</div>`;
  }
  reveal(ok, scoreHTML);
}

function reveal(ok, scoreHTML) {
  revealed = true; answeredCorrect = ok;
  const t = current;
  const showLatinFirst = activeMode === 'photo2sci' || activeMode === 'com2sci' || activeMode === 'photo2com';

  const slip = document.createElement('div');
  slip.className = 'slip';
  slip.innerHTML =
    `<div class="answer latin">${esc(t.sci)}${t.genusOnly ? '<span class="flag">genus level</span>' : ''}</div>
     <p class="answer-sub">${esc(t.common)}</p>
     <div class="fields">
       <div class="field"><label>Family</label><span>${esc(t.family)}</span></div>
       <div class="field"><label>Habit</label><span>${esc(t.habit)} \u00b7 ${esc(habitLabel(t.habit))}</span></div>
       <div class="field"><label>Status</label><span class="${t.alien ? 'alien' : ''}">${t.alien ? 'Naturalized non-native' : 'Native'}</span></div>
     </div>
     <div class="looks">
       <a href="https://www.inaturalist.org/search?q=${encodeURIComponent(t.query)}" target="_blank" rel="noopener">iNaturalist</a>
       <a href="https://www.calflora.org/entry/wgh.html?srch=t&taxon=${encodeURIComponent(t.query)}" target="_blank" rel="noopener">Calflora</a>
       <a href="https://ucjeps.berkeley.edu/eflora/search_eflora.html?where-taxon=${encodeURIComponent(t.query)}" target="_blank" rel="noopener">Jepson eFlora</a>
     </div>`;

  const responder = $('#responder');
  const post = $('#post');
  responder.parentNode.insertBefore(slip, responder);

  const suggested = ok ? 2 : 0;
  const gradeHTML = (scoreHTML || '') + `<div class="grade">
      <button data-q="0"${suggested === 0 ? ' style="border-width:2px"' : ''}>Again<small>blank</small></button>
      <button data-q="1">Hard<small>dragged it up</small></button>
      <button data-q="2"${suggested === 2 ? ' style="border-width:2px"' : ''}>Good<small>knew it</small></button>
      <button data-q="3">Easy<small>instant</small></button>
    </div><div class="keyhint">1 \u2013 4 to grade \u00b7 enter for ${ok ? 'Good' : 'Again'}</div>`;

  if (post) post.innerHTML = gradeHTML; else responder.innerHTML = gradeHTML;

  const ansEl = $('#ans');
  if (ansEl) { ansEl.readOnly = true; ansEl.blur(); }
  document.querySelectorAll('.grade button').forEach(b => { b.onclick = () => grade(Number(b.dataset.q)); });
  const firstGrade = document.querySelector('.grade button[data-q="' + (ok ? '2' : '0') + '"]');
  if (firstGrade) firstGrade.focus();
  if (MODES[activeMode].photo) showCredit();
}

function renderTally() {
  const c = counts();
  $('#t-due').textContent = c.due;
  $('#t-new').textContent = Math.max(0, Math.min(c.neu, state.cfg.newLimit - state.seenToday));
  $('#t-learn').textContent = c.learn;
  $('#t-solid').textContent = c.solid;
  $('#t-pool').textContent = c.total;
  renderCountdown();
}

/* ============================ countdown ============================ */

function renderCountdown() {
  const el = $('#countdown');
  if (!state.cfg.examDate) {
    el.style.display = 'none';
    return;
  }
  el.style.display = '';
  const exam = new Date(state.cfg.examDate + 'T08:00:00');
  const ms = exam - Date.now();
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor(ms / 3600000);
  const c = counts();
  const unsolid = c.total - c.solid;
  const perDay = days > 0 ? Math.ceil(unsolid / days) : unsolid;

  let big, txt;
  if (ms < 0) { big = 'today'; txt = 'Exam date has passed or is today. Good luck.'; }
  else if (days < 1) { big = `${hours}h`; txt = `${unsolid} taxa not yet solid. Run the exam simulator, then sleep.`; }
  else {
    big = `${days}d`;
    txt = `${c.solid} of ${c.total} solid. ${unsolid} to go \u2014 about ${perDay} per day to clear the pool.`;
  }
  el.className = 'countdown' + (days > 7 ? ' calm' : '');
  el.innerHTML = `<span class="big">${big}</span><span class="txt">${esc(txt)}</span>`;
}

/* ============================ setup ============================ */
/* Every control writes straight into cfg and calls applyConfig(), which
   rebuilds the queue and re-renders the live card. No reload, no reset. */

function applyConfig(hard) {
  save();
  buildQueue(!hard);
  if (hard || !current || !pool().some(t => t.id === current.id)) nextCard();
  else if (!revealed) { activeMode = state.cfg.modes[(Math.random() * state.cfg.modes.length) | 0]; renderDrill(); }
  renderTally();
  renderPoolNote();
}

function renderSetup() {
  const modeRow = $('#mode-row');
  modeRow.innerHTML = Object.entries(MODES).map(([k, v]) =>
    `<button class="chip" data-mode="${k}" aria-pressed="${state.cfg.modes.includes(k)}">${v.label}</button>`).join('');
  modeRow.querySelectorAll('button').forEach(b => b.onclick = () => {
    const k = b.dataset.mode, i = state.cfg.modes.indexOf(k);
    if (i >= 0) { if (state.cfg.modes.length === 1) return; state.cfg.modes.splice(i, 1); }
    else state.cfg.modes.push(k);
    b.setAttribute('aria-pressed', state.cfg.modes.includes(k));
    applyConfig(false);
  });

  const habitRow = $('#habit-row');
  habitRow.innerHTML = Object.keys(HABIT_GROUPS).map(g =>
    `<button class="chip" data-h="${g}" aria-pressed="${state.cfg.habits.includes(g)}">${g}</button>`).join('');
  habitRow.querySelectorAll('button').forEach(b => b.onclick = () => {
    const g = b.dataset.h, i = state.cfg.habits.indexOf(g);
    if (i >= 0) state.cfg.habits.splice(i, 1); else state.cfg.habits.push(g);
    b.setAttribute('aria-pressed', state.cfg.habits.includes(g));
    applyConfig(true);
  });

  const misc = $('#misc-row');
  misc.innerHTML =
    `<button class="chip" data-nat="all" aria-pressed="${state.cfg.nativity === 'all'}">All taxa</button>
     <button class="chip" data-nat="native" aria-pressed="${state.cfg.nativity === 'native'}">Native only</button>
     <button class="chip" data-nat="alien" aria-pressed="${state.cfg.nativity === 'alien'}">Non-native only</button>
     <button class="chip" data-genus aria-pressed="${state.cfg.genusOnly}">Genus-level only</button>
     <button class="chip det" data-strict aria-pressed="${state.cfg.strict}">Strict spelling</button>`;
  misc.querySelectorAll('[data-nat]').forEach(b => b.onclick = () => {
    state.cfg.nativity = b.dataset.nat; renderSetup(); applyConfig(true);
  });
  misc.querySelector('[data-genus]').onclick = e => {
    state.cfg.genusOnly = !state.cfg.genusOnly;
    e.currentTarget.setAttribute('aria-pressed', state.cfg.genusOnly); applyConfig(true);
  };
  misc.querySelector('[data-strict]').onclick = e => {
    state.cfg.strict = !state.cfg.strict;
    e.currentTarget.setAttribute('aria-pressed', state.cfg.strict); save();
  };

  const fam = $('#f-family');
  if (fam.options.length <= 1) {
    FAMILIES.forEach(f => {
      const o = document.createElement('option');
      o.value = f; o.textContent = `${f} (${TAXA.filter(t => t.family === f).length})`;
      fam.appendChild(o);
    });
  }
  fam.value = state.cfg.family;
  fam.onchange = () => { state.cfg.family = fam.value; applyConfig(true); };

  const nl = $('#f-newlimit');
  nl.value = state.cfg.newLimit;
  nl.oninput = () => { state.cfg.newLimit = Math.max(0, Number(nl.value) || 0); applyConfig(false); };

  const ld = $('#f-ladder');
  ld.value = state.cfg.ladder;
  ld.onchange = () => { state.cfg.ladder = ld.value; applyConfig(false); };

  const ed = $('#f-exam');
  ed.value = state.cfg.examDate;
  ed.onchange = () => { state.cfg.examDate = ed.value; save(); renderCountdown(); };

  const pr = $('#f-profile');
  pr.value = state.cfg.profile;
  pr.onchange = async () => {
    const v = pr.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'default';
    pr.value = v;
    await load(v);
    renderSetup(); applyConfig(true);
  };

  renderPoolNote();
  refreshCacheStatus();
}

function renderPoolNote() {
  const c = counts();
  const el = $('#pool-note');
  if (el) el.textContent =
    `${c.total} taxa in pool \u2014 ${c.neu} untouched, ${c.learn} in progress, ${c.solid} solid.`;
}

async function refreshCacheStatus() {
  const el = $('#cache-note');
  if (!el) return;
  try {
    const s = await fetch('/api/cache-status').then(r => r.json());
    const pct = Math.round(100 * s.warm / s.total);
    el.innerHTML = `Photo cache: <b>${s.warm}</b> of ${s.total} taxa have plates (${pct}%).` +
      (s.warm < s.total ? ` Run <code>node scripts/warm.js</code> on the server to fill the rest.` : '');
  } catch { el.textContent = 'Photo cache status unavailable.'; }
}

/* ============================ exam simulator ============================ */

function startExam(n) {
  const p = pool().slice();
  if (p.length < 5) { alert('Pool too small. Widen the filters first.'); return; }
  shuffle(p);
  exam = { items: p.slice(0, Math.min(n, p.length)), i: 0, answers: [], startedAt: Date.now() };
  renderExam();
}

function renderExam() {
  const host = $('#exam-stage');
  if (!exam) {
    host.innerHTML = `<fieldset><legend>Exam simulator</legend>
      <p class="hint" style="margin:0 0 14px">One hundred taxa drawn at random from the current pool, photo only,
      no feedback until the end. Scored the way the Board does it: one point genus, one point specific epithet,
      genus-level taxa worth one. The pass mark is 75%.</p>
      <div class="opt-row">
        <button class="btn" id="ex-100">Run 100-taxon exam</button>
        <button class="btn ghost" id="ex-25">Quick 25</button>
      </div></fieldset>
      <div id="exam-history"></div>`;
    $('#ex-100').onclick = () => startExam(100);
    $('#ex-25').onclick = () => startExam(25);
    renderExamHistory();
    return;
  }
  if (exam.i >= exam.items.length) return renderExamResult();

  const t = exam.items[exam.i];
  host.innerHTML = `
    <div class="exam-head"><span>Exam \u00b7 no feedback</span><span>${exam.i + 1} / ${exam.items.length}</span></div>
    <div class="specimen" style="border-top:0">
      <div id="ex-plate"></div>
      <div class="ask">Write the determination</div>
      <div class="entry">
        <input type="text" id="ex-ans" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
               placeholder="genus + specific epithet">
        <div class="entry-row">
          <button class="btn" id="ex-next">Next specimen</button>
          <button class="btn ghost" id="ex-quit" style="flex:0 0 auto;padding:0 16px">End exam</button>
        </div>
      </div>
    </div>`;

  const plateHost = $('#ex-plate');
  plateHost.innerHTML = `<div class="plate loading"><div class="msg">loading plate\u2026</div></div>`;
  getPhotos(t.id).then(d => {
    if (!exam || exam.items[exam.i] !== t) return;
    const ph = (d.photos || [])[0];
    plateHost.innerHTML = ph
      ? `<div class="plate"><img src="${esc(ph.url)}" alt="Exam specimen"></div>`
      : `<div class="plate"><div class="msg">No plate cached \u2014 identify from the name below.<br>
         <span style="font-family:var(--serif);font-style:italic;font-size:15px">${esc(t.family)}, ${esc(habitLabel(t.habit))}</span></div></div>`;
  });

  const input = $('#ex-ans');
  input.focus();
  const advance = () => {
    exam.answers.push({ id: t.id, input: input.value.trim() });
    exam.i++;
    renderExam();
  };
  input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); advance(); } };
  $('#ex-next').onclick = advance;
  $('#ex-quit').onclick = () => { exam.items = exam.items.slice(0, exam.i); renderExamResult(); };
}

function renderExamResult() {
  const rows = exam.answers.map(a => {
    const t = BY_ID.get(a.id);
    const s = scoreBinomial(a.input, t, false);
    return { t, input: a.input, s };
  });
  const pts = rows.reduce((n, r) => n + r.s.pts, 0);
  const max = rows.reduce((n, r) => n + r.s.max, 0);
  const pct = max ? Math.round(100 * pts / max) : 0;
  const pass = pct >= 75;
  const mins = Math.round((Date.now() - exam.startedAt) / 60000);

  state.history.push({ t: Date.now(), exam: true, pct, pts, max, n: rows.length });
  // Missed taxa go straight back into the front of the drill rotation.
  rows.filter(r => !r.s.full).forEach(r => {
    const k = card(r.t.id);
    k.step = 0; k.due = Date.now(); k.wrong++;
  });
  save();

  $('#exam-stage').innerHTML = `
    <fieldset><legend>Result</legend>
      <p class="result-big ${pass ? 'pass' : 'fail'}">${pct}%</p>
      <p class="hint" style="margin-top:6px">${pts} of ${max} points across ${rows.length} specimens in ${mins} min.
        ${pass ? 'Above the 75% pass mark.' : 'Below the 75% pass mark.'}
        Every miss has been pushed back to the front of the drill queue.</p>
      <div class="opt-row" style="margin-top:12px">
        <button class="btn ghost" id="ex-again">Run another</button>
        <button class="btn ghost" id="ex-done">Back to drill</button>
      </div>
    </fieldset>
    <fieldset><legend>Every specimen</legend>
      <div class="scroll"><table><tbody>
        <tr><th>Correct</th><th>You wrote</th><th>Pts</th></tr>
        ${rows.map(r => `<tr>
          <td><span class="lat">${esc(r.t.sci)}</span><br>
              <span style="color:var(--ink2);font-size:12px">${esc(r.t.common)}</span></td>
          <td style="font-family:var(--mono);font-size:12px;color:${r.s.full ? 'var(--moss)' : 'var(--det)'}">
              ${esc(r.input || '\u2014 blank \u2014')}</td>
          <td class="num">${r.s.pts}/${r.s.max}</td></tr>`).join('')}
      </tbody></table></div>
    </fieldset>`;
  $('#ex-again').onclick = () => { exam = null; renderExam(); };
  $('#ex-done').onclick = () => { exam = null; renderExam(); showTab('drill'); buildQueue(); nextCard(); };
}

function renderExamHistory() {
  const el = $('#exam-history');
  const runs = state.history.filter(h => h.exam).slice(-10).reverse();
  if (!runs.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<fieldset><legend>Past attempts</legend><table><tbody>
    <tr><th>When</th><th>Score</th><th>Specimens</th></tr>
    ${runs.map(r => `<tr>
      <td>${new Date(r.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
      <td style="font-family:var(--mono);color:${r.pct >= 75 ? 'var(--moss)' : 'var(--det)'}">${r.pct}%</td>
      <td class="num">${r.n}</td></tr>`).join('')}
  </tbody></table></fieldset>`;
}

/* ============================ progress ============================ */

function renderProgress() {
  const rows = [];
  for (const f of FAMILIES) {
    let r = 0, w = 0, solid = 0, n = 0;
    for (const t of TAXA.filter(x => x.family === f)) {
      n++;
      const k = state.cards[t.id];
      if (k) { r += k.right; w += k.wrong; if (isSolid(k)) solid++; }
    }
    if (r + w >= 3) rows.push({ f, r, w, n, solid, pct: r / (r + w) });
  }
  rows.sort((a, b) => a.pct - b.pct);
  $('#fam-table').innerHTML = rows.length
    ? `<tr><th>Family</th><th>Accuracy</th><th>Solid</th></tr>` + rows.slice(0, 25).map(x => {
        const pct = Math.round(x.pct * 100);
        const cls = pct < 60 ? 'weak' : pct < 80 ? 'mid' : '';
        return `<tr><td>${esc(x.f)}</td>
          <td><span class="bar ${cls}" style="width:${Math.max(2, pct * 0.8)}px"></span>
              <span style="font-family:var(--mono);font-size:11px;margin-left:7px">${pct}%</span></td>
          <td class="num">${x.solid}/${x.n}</td></tr>`;
      }).join('')
    : `<tr><td style="border:0;color:var(--ink2)">No family has three answers yet.</td></tr>`;

  const leeches = TAXA.filter(t => { const k = state.cards[t.id]; return k && k.lapses >= 3; })
    .sort((a, b) => state.cards[b.id].lapses - state.cards[a.id].lapses);
  $('#leech-table').innerHTML = leeches.length
    ? `<tr><th>Taxon</th><th>Common</th><th>Lapses</th></tr>` + leeches.slice(0, 30).map(t =>
        `<tr><td class="lat">${esc(t.sci)}</td>
             <td style="color:var(--ink2)">${esc(t.common)}</td>
             <td class="num">${state.cards[t.id].lapses}</td></tr>`).join('')
    : `<tr><td style="border:0;color:var(--ink2)">Nothing has lapsed three times yet.</td></tr>`;

  const today = state.history.filter(h => !h.exam && Date.now() - h.t < 86400000);
  const right = today.filter(h => h.q >= 2).length;
  $('#today-note').textContent = today.length
    ? `${today.length} answers in the last 24 hours \u00b7 ${Math.round(100 * right / today.length)}% graded Good or Easy.`
    : 'No answers in the last 24 hours.';
}

/* ============================ browse ============================ */

function renderBrowse() {
  const q = $('#search').value.trim().toLowerCase();
  const sort = $('#browse-sort').value;
  let list = TAXA.filter(t => !q || t.sci.toLowerCase().includes(q)
    || t.common.toLowerCase().includes(q) || t.family.toLowerCase().includes(q));

  if (sort === 'fam') list.sort((a, b) => a.family.localeCompare(b.family) || a.sci.localeCompare(b.sci));
  else if (sort === 'habit') list.sort((a, b) => a.habit.localeCompare(b.habit) || a.sci.localeCompare(b.sci));
  else if (sort === 'weak') list.sort((a, b) => {
    const ka = state.cards[a.id], kb = state.cards[b.id];
    const pa = ka && (ka.right + ka.wrong) ? ka.right / (ka.right + ka.wrong) : 2;
    const pb = kb && (kb.right + kb.wrong) ? kb.right / (kb.right + kb.wrong) : 2;
    return pa - pb;
  });

  $('#browse-table').innerHTML = `<tr><th>Taxon</th><th>Common name</th><th>Family</th><th>Habit</th></tr>` +
    list.map(t => {
      const k = state.cards[t.id];
      const cls = !k || !k.reps ? '' : isSolid(k) ? 'solid' : k.step > 1 ? 'young' : 'learn';
      return `<tr>
        <td><span class="dot ${cls}"></span><span class="lat">${esc(t.sci)}</span>${t.alien ? ' <span style="color:var(--det);font-family:var(--mono)">*</span>' : ''}</td>
        <td style="color:var(--ink2)">${esc(t.common)}</td>
        <td style="font-family:var(--mono);font-size:11.5px">${esc(t.family)}</td>
        <td style="font-family:var(--mono);font-size:11.5px">${esc(t.habit)}</td></tr>`;
    }).join('');
  $('#browse-count').textContent = `${list.length} shown`;
}

/* ============================ tabs + keys ============================ */

function showTab(name) {
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('on', p.id === 'p-' + name));
  if (name === 'setup') renderSetup();
  if (name === 'progress') renderProgress();
  if (name === 'browse') renderBrowse();
  if (name === 'exam') renderExam();
}

document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));

document.addEventListener('keydown', e => {
  if (!$('#p-drill').classList.contains('on')) return;
  // The input has its own Enter handler. If this one also fired on Enter, a
  // single keypress would check the answer and grade it away before the
  // determination slip was ever visible.
  if (/input|select|textarea/i.test(e.target.tagName)) return;
  if (revealed) {
    if (['1', '2', '3', '4'].includes(e.key)) { e.preventDefault(); grade(Number(e.key) - 1); }
    if (e.key === 'Enter') { e.preventDefault(); grade(answeredCorrect ? 2 : 0); }
  }
});

/* ============================ boot ============================ */

(async function init() {
  try {
    TAXA = await fetch('/api/taxa').then(r => r.json());
  } catch (e) {
    document.body.innerHTML = '<p style="padding:30px;font-family:monospace">Could not load taxa. Is the server running?</p>';
    return;
  }
  BY_ID = new Map(TAXA.map(t => [t.id, t]));
  FAMILIES = [...new Set(TAXA.map(t => t.family))].sort();

  await load();
  $('#who').innerHTML = `profile <b>${esc(state.cfg.profile)}</b>`;

  $('#btn-reset').onclick = async () => {
    if (!confirm('Clear all scheduling and accuracy for this profile? This cannot be undone.')) return;
    state.cards = {}; state.seenToday = 0; state.history = [];
    save(); applyConfig(true); renderProgress(); renderBrowse();
  };
  $('#btn-export').onclick = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `cnps-drill-${state.cfg.profile}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };
  $('#search').oninput = renderBrowse;
  $('#browse-sort').onchange = renderBrowse;

  renderSetup();
  buildQueue();
  nextCard();
  setInterval(renderTally, 30000);
  setSync('ready');
})();
