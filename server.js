#!/usr/bin/env node
'use strict';
/*
 * CNPS Sight-ID Drill — server
 * Node 18+, zero dependencies.
 *
 *   GET  /                      app
 *   GET  /api/taxa              the 500 taxa
 *   GET  /api/state/:profile    saved progress (JSON), anonymous named profile
 *   PUT  /api/state/:profile    save progress (disabled by ANON_PROFILES=0)
 *   POST /api/auth/register     {username, password} -> session cookie
 *   POST /api/auth/login        {username, password} -> session cookie
 *   POST /api/auth/logout
 *   GET  /api/auth/me           {user: {username}} | {user: null}
 *   GET  /api/me/state          the signed-in user's progress
 *   PUT  /api/me/state          save it
 *   GET  /api/photos/:id        photo manifest for taxon id (fetches + caches on miss)
 *   GET  /photos/:id/:n.jpg     cached image bytes
 *   GET  /api/cache-status      how warm the photo cache is
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const auth = require('./lib/auth');
const { openStore } = require('./lib/store');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const PHOTOS = path.join(DATA, 'photos');
const STATES = path.join(DATA, 'states');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PHOTOS_PER_TAXON = Number(process.env.PHOTOS_PER_TAXON || 6);
const OFFLINE = process.env.OFFLINE === '1';
// Open sign-up by default; SIGNUP=0 once the people who need accounts have them.
const SIGNUP = process.env.SIGNUP !== '0';
// The pre-account named profiles: anyone with the URL can read or overwrite
// any of them. Kept on so existing saves keep working; ANON_PROFILES=0 turns
// them off once everyone has moved into an account.
const ANON_PROFILES = process.env.ANON_PROFILES !== '0';
const SESSION_MS = 30 * 86400e3;

const TAXA = JSON.parse(fs.readFileSync(path.join(DATA, 'taxa.json'), 'utf8'));
const BY_ID = new Map(TAXA.map(t => [t.id, t]));

for (const d of [PHOTOS, STATES]) fs.mkdirSync(d, { recursive: true });

/* ------------------------------------------------------------------ */
/* iNaturalist photo fetching                                          */
/* ------------------------------------------------------------------ */

const INAT = 'https://api.inaturalist.org/v1';
const LICENSES = 'cc0,cc-by,cc-by-nc,cc-by-sa,cc-by-nc-sa';
const LICENSE_SET = new Set(LICENSES.split(','));
const licenseOk = code => LICENSE_SET.has(code);
const UA = 'cnps-sight-id-drill/1.0 (self-hosted study tool)';

// data/curate.json lets a human override the auto-picked plates per taxon:
//   { "<taxonId>": { "block": [photoId...], "pin": [{url,attribution,license}...] } }
// A block drops a bad auto-pick; a pin forces a chosen image to the front and is
// never license-filtered (the curator vouched for it). Pure, so it is unit-tested
// without the network — see test/photos.test.js.
function applyCuration(candidates, entry, n) {
  const block = new Set((entry && entry.block) || []);
  const pins = ((entry && entry.pin) || []).map(p => ({
    src: p.url, attribution: p.attribution || '', license: p.license || '', source: 'pin',
  }));
  const kept = candidates.filter(c => !block.has(c.photoId));
  return [...pins, ...kept].slice(0, n);
}

// Which iNat search hit actually IS this taxon. iNat may file a listed species
// under a subspecies or a reassigned genus, so we loosen rank but stay strict on
// identity: a candidate must share the genus (or a synonym genus from `alts`)
// and, for a species, carry the epithet. Nothing valid -> null; we never fall
// through to iNat's fuzzy top hit and cache the wrong plant. Pure, unit-tested.
const RANK_WEIGHT = { genus: 5, species: 4, subspecies: 3, variety: 2, subvariety: 2, form: 1 };
function pickTaxon(candidates, taxon) {
  const list = candidates || [];
  const q = (taxon.query || '').toLowerCase();
  const exact = list.find(c => (c.name || '').toLowerCase() === q);
  if (exact) return exact.id;

  // Accept the genus/epithet of the listed name AND of every alt binomial —
  // synonym taxa list a former name while iNat serves the current one, and both
  // parts can differ (Pennisetum setaceum -> Cenchrus setaceus). Genus from the
  // first token, epithet from the last.
  const genusOK = new Set(), epithetOK = new Set();
  const learn = s => {
    const t = String(s || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (t[0]) genusOK.add(t[0]);
    if (t.length > 1) epithetOK.add(t[t.length - 1]);
  };
  learn(`${taxon.genus} ${taxon.epithet || ''}`);
  for (const a of taxon.alts || []) learn(a);
  const needEpithet = !(taxon.genusOnly || !taxon.epithet);

  const valid = list.filter(c => {
    const toks = (c.name || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!toks.length || !genusOK.has(toks[0])) return false;
    return needEpithet ? toks.some(t => epithetOK.has(t)) : true;
  });
  if (!valid.length) return null;
  valid.sort((a, b) => {
    const aa = a.is_active === false ? 0 : 1, ba = b.is_active === false ? 0 : 1;
    if (aa !== ba) return ba - aa;                                  // active first
    return (RANK_WEIGHT[b.rank] || 0) - (RANK_WEIGHT[a.rank] || 0); // then broadest rank
  });
  return valid[0].id;
}

// Serialise outbound calls; iNat asks for <=60/min and no bursts. The queue is
// a chain of promises, so each link must settle rather than accumulate.
let chain = Promise.resolve();
let lastCall = 0;
function throttled(fn) {
  const run = chain.then(async () => {
    const wait = Math.max(0, 1100 - (Date.now() - lastCall));
    if (wait) await new Promise(r => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  chain = run.then(() => {}, () => {});   // never let a rejection stall the queue
  return run;
}

// An unread response body holds its socket open. Undici keeps those sockets in
// the agent pool with abort listeners still attached, so a few hundred error
// responses produce MaxListenersExceededWarning and a slow leak. Every exit
// path from here drains or cancels the body.
async function drain(res) {
  try { if (res.body && !res.bodyUsed) await res.body.cancel(); } catch { /* already gone */ }
}

const TIMEOUT = Number(process.env.FETCH_TIMEOUT_MS || 20000);

async function req(url, accept) {
  const res = await fetch(url, {
    headers: accept ? { 'User-Agent': UA, Accept: accept } : { 'User-Agent': UA },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) { await drain(res); throw new Error(`${res.status} ${url}`); }
  return res;
}

async function jget(url) {
  const res = await req(url, 'application/json');
  try { return await res.json(); }
  catch (e) { await drain(res); throw e; }
}

async function resolveTaxonId(taxon) {
  const rank = taxon.genusOnly || !taxon.epithet ? 'genus' : 'species';
  const q = encodeURIComponent(taxon.query);

  // Rank-constrained first (an exact species hit is the common case). If that
  // finds nothing, drop the rank — iNat may have demoted this species to a
  // subspecies (Juncus mexicanus -> Juncus balticus mexicanus) or merged its
  // genus (Vulpia -> Festuca). pickTaxon validates identity on both paths, so a
  // rank-less search can never resolve to the wrong plant.
  let id = pickTaxon((await jget(`${INAT}/taxa?q=${q}&rank=${rank}&per_page=5`)).results, taxon);
  if (id == null) id = pickTaxon((await jget(`${INAT}/taxa?q=${q}&per_page=5`)).results, taxon);
  return id;
}

const medium = url => (url || '').replace('/square.', '/medium.');

// Curated reference photos for the taxon. These are the community/curator set
// shown on the iNat taxon page — chosen to represent the species, not ranked by
// faves (which reward the striking and atypical). No query-level licence filter
// exists here, so filter each one ourselves.
async function fetchCuratedPhotos(inatId) {
  const j = await jget(`${INAT}/taxa/${inatId}`);
  const t = (j.results || [])[0] || {};
  const out = [];
  const seen = new Set();
  for (const tp of t.taxon_photos || []) {
    const p = tp.photo || {};
    if (!p.id || seen.has(p.id) || !licenseOk(p.license_code)) continue;
    const src = medium(p.medium_url || p.url);
    if (!src) continue;
    seen.add(p.id);
    out.push({ photoId: p.id, src, attribution: p.attribution || '', license: p.license_code, source: 'taxon' });
  }
  return out;
}

// Fallback for taxa with few curated photos: one representative photo per
// research-grade observation, for variety across individuals and places. NB no
// `order_by=votes` — popularity is exactly the bias we are avoiding.
async function fetchObservationPhotos(inatId) {
  const url = `${INAT}/observations?taxon_id=${inatId}&quality_grade=research`
    + `&photos=true&license=${LICENSES}&photo_license=${LICENSES}`
    + `&per_page=${PHOTOS_PER_TAXON * 3}`;
  const j = await jget(url);
  const out = [];
  const seen = new Set();
  for (const obs of j.results || []) {
    const p = (obs.photos || [])[0];   // the observation's own lead image only
    if (!p || !p.url || seen.has(p.id) || !licenseOk(p.license_code)) continue;
    seen.add(p.id);
    out.push({
      photoId: p.id, src: medium(p.url),
      attribution: p.attribution || '', license: p.license_code,
      observed: obs.observed_on || '',
      place: (obs.place_guess || '').split(',').slice(0, 2).join(',').trim(),
      source: 'observation',
    });
  }
  return out;
}

// Curated set first; top up from observations only if short. Deduped by photoId.
async function buildCandidates(inatId) {
  let cands = await throttled(() => fetchCuratedPhotos(inatId));
  if (cands.length < PHOTOS_PER_TAXON) {
    const more = await throttled(() => fetchObservationPhotos(inatId));
    const seen = new Set(cands.map(c => c.photoId));
    for (const c of more) if (!seen.has(c.photoId)) { seen.add(c.photoId); cands.push(c); }
  }
  return cands;
}

// data/curate.json, re-read when its mtime changes. Missing/invalid -> {}.
let curationCache = { mtime: -1, data: {} };
function loadCuration() {
  const f = path.join(DATA, 'curate.json');
  let stat;
  try { stat = fs.statSync(f); } catch { curationCache = { mtime: -1, data: {} }; return curationCache.data; }
  if (stat.mtimeMs !== curationCache.mtime) {
    try { curationCache = { mtime: stat.mtimeMs, data: JSON.parse(fs.readFileSync(f, 'utf8')) || {} }; }
    catch { curationCache = { mtime: stat.mtimeMs, data: {} }; }
  }
  return curationCache.data;
}

async function download(url, dest) {
  const res = await req(url);
  let buf;
  try { buf = Buffer.from(await res.arrayBuffer()); }
  catch (e) { await drain(res); throw e; }
  if (buf.length < 900) throw new Error('img too small');
  await fsp.writeFile(dest, buf);
  return buf.length;
}

const inflight = new Map();

async function ensurePhotos(id, force) {
  const dir = path.join(PHOTOS, String(id));
  const metaPath = path.join(dir, 'meta.json');
  let prevInatId;
  try {
    const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
    prevInatId = meta.inatId;   // reused below to skip the resolve call — but NOT under --force
    // --force re-fetches even a warm taxon (used to regenerate the whole set).
    if (!force && meta.photos && meta.photos.length) return meta;
    // A transient network fault must not lock a taxon out of retries for
    // hours; --retry passes force to punch through the negative cache.
    if (!force && meta.failedAt && Date.now() - meta.failedAt < 6 * 3600e3) return meta;
  } catch { /* cache miss */ }

  if (OFFLINE) return { id, photos: [], offline: true };
  if (inflight.has(id)) return inflight.get(id);

  const job = (async () => {
    const taxon = BY_ID.get(id);
    await fsp.mkdir(dir, { recursive: true });
    let meta = { id, sci: taxon.sci, query: taxon.query, photos: [], fetchedAt: Date.now() };
    try {
      // --force re-resolves: the cache may hold a wrong id from an older, looser
      // resolver, and reusing it would re-download the wrong plant.
      const inatId = (!force && prevInatId) || await throttled(() => resolveTaxonId(taxon));
      if (!inatId) throw new Error('no iNat taxon');
      meta.inatId = inatId;

      const candidates = await buildCandidates(inatId);
      const picked = applyCuration(candidates, loadCuration()[String(id)], PHOTOS_PER_TAXON);

      // Drop any leftover plates from a previous warm so a shorter new set
      // cannot leave orphaned files behind.
      for (const f of await fsp.readdir(dir)) if (f.endsWith('.jpg')) await fsp.unlink(path.join(dir, f)).catch(() => {});

      // Images come from the S3 CDN, not the rate-limited API, so download them
      // in parallel. Index-based names may skip a number on a failed download;
      // the client reads file names from meta, so gaps are harmless.
      const saved = await Promise.all(picked.map(async (p, i) => {
        const file = `${i}.jpg`;
        try {
          await download(p.src, path.join(dir, file));
          return { file, photoId: p.photoId, attribution: p.attribution, license: p.license,
                   observed: p.observed || '', place: p.place || '', source: p.source };
        } catch { return null; }
      }));
      meta.photos = saved.filter(Boolean);
      if (!meta.photos.length) meta.failedAt = Date.now();
    } catch (e) {
      meta.failedAt = Date.now();
      meta.error = String(e.message || e);
    }
    await fsp.writeFile(metaPath, JSON.stringify(meta));
    return meta;
  })().finally(() => inflight.delete(id));

  inflight.set(id, job);
  return job;
}

/* ------------------------------------------------------------------ */
/* http                                                                */
/* ------------------------------------------------------------------ */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',   // ES modules must be served with a JS MIME
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };

function send(res, code, body, headers = {}) {
  res.writeHead(code, Object.assign({ 'Content-Length': Buffer.byteLength(body) }, headers));
  res.end(body);
}
const json = (res, code, obj, h = {}) =>
  send(res, code, JSON.stringify(obj), Object.assign({ 'Content-Type': MIME['.json'] }, h));

function safeProfile(p) {
  const s = String(p || 'default').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  return s || 'default';
}

async function readBody(req, limit = 4e6) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/* ------------------------------------------------------------------ */
/* accounts                                                            */
/* ------------------------------------------------------------------ */

// Opened on first use, not on import: scripts/warm.js requires this file and
// never touches accounts.
let store = null;
const db = () => store || (store = openStore({
  dbFile: process.env.DB_FILE || path.join(DATA, 'accounts.db'),
  dir: path.join(DATA, 'accounts'),
}));

// Behind Caddy the app sees plain http; the proxy says what the browser used.
const isHttps = req => !!req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https'
  || process.env.COOKIE_SECURE === '1';

// CSRF: SameSite=Lax already keeps the cookie off cross-site fetches, and
// requiring a JSON body forces a CORS preflight on any cross-site form post.
// The Origin check is the belt to those braces.
function writeAllowed(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return false;
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

// Sliding expiry: a session in use is renewed once it is past half its life,
// so someone studying daily is never signed out, and an idle one lapses.
function currentUser(req, res) {
  const tok = auth.parseCookies(req.headers.cookie)[auth.COOKIE];
  if (!tok) return null;
  const hash = auth.tokenHash(tok);
  const s = db().getSession(hash);
  if (!s) return null;
  if (s.expires - Date.now() < SESSION_MS / 2) {
    db().touchSession(hash, Date.now() + SESSION_MS);
    res.setHeader('Set-Cookie', auth.sessionCookie(tok, { maxAge: SESSION_MS, secure: isHttps(req) }));
  }
  return { id: s.userId, username: s.username };
}

function startSession(req, res, user) {
  const tok = auth.newToken();
  db().createSession(auth.tokenHash(tok), user.id, Date.now() + SESSION_MS);
  res.setHeader('Set-Cookie', auth.sessionCookie(tok, { maxAge: SESSION_MS, secure: isHttps(req) }));
}

// Two counters per login attempt. Per name and client: ten tries locks that
// pair for fifteen minutes, so a stranger cannot lock someone else out. Per
// name alone, a higher bar stops a guesser who rotates addresses.
// Attempts count when they arrive, before scrypt runs: counting after the
// await let a parallel burst pass the check before any of it was counted.
const failures = new Map();
const LOCK_AFTER = 10, LOCK_NAME_AFTER = 50, LOCK_MS = 15 * 60e3;

// Caddy is the only client that can reach the port (127.0.0.1 in compose) and
// it overwrites X-Forwarded-For with the real address. A direct client's own
// header is not trusted.
function clientIp(req) {
  const peer = req.socket.remoteAddress || '';
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const xff = req.headers['x-forwarded-for'];
  return loopback && xff ? String(xff).split(',').pop().trim() : peer;
}

function live(key) {
  const f = failures.get(key);
  if (f && Date.now() - f.first > LOCK_MS) { failures.delete(key); return null; }
  return f || null;
}
function lockedOut(name, ip) {
  const pair = live(`${name}|${ip}`), all = live(name);
  return (!!pair && pair.n >= LOCK_AFTER) || (!!all && all.n >= LOCK_NAME_AFTER);
}
function bump(key, by) {
  const f = live(key);
  if (f) f.n += by; else if (by > 0) failures.set(key, { n: by, first: Date.now() });
}
function noteAttempt(name, ip) {
  // scrypt caps logins at roughly 80 a second, so the map stays small; sweep
  // expired entries anyway so it cannot grow for good.
  if (failures.size > 10000) for (const k of [...failures.keys()]) live(k);
  bump(`${name}|${ip}`, 1); bump(name, 1);
}
function noteSuccess(name, ip) {
  failures.delete(`${name}|${ip}`);
  bump(name, -1);
}

async function readJson(req, limit) {
  try { return JSON.parse(await readBody(req, limit)); } catch { return null; }
}

async function handleAuth(req, res, p) {
  if (p === '/api/auth/me') {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
    const u = currentUser(req, res);
    return json(res, 200, { user: u && { username: u.username }, signup: SIGNUP }, { 'Cache-Control': 'no-store' });
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  if (!writeAllowed(req)) return json(res, 403, { error: 'cross-origin or non-JSON request' });

  if (p === '/api/auth/logout') {
    const tok = auth.parseCookies(req.headers.cookie)[auth.COOKIE];
    if (tok) db().deleteSession(auth.tokenHash(tok));
    return json(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie(isHttps(req)) });
  }

  const body = await readJson(req, 4096) || {};
  const name = auth.cleanUsername(body.username);

  if (p === '/api/auth/register') {
    if (!SIGNUP) return json(res, 403, { error: 'sign-up is closed' });
    if (!name) return json(res, 400, { error: 'username: 3–32 letters, digits, - or _' });
    if (!auth.passwordOk(body.password)) return json(res, 400, { error: 'password: at least 8 characters' });
    const user = db().createUser(name, await auth.hashPassword(body.password));
    if (!user) return json(res, 409, { error: 'that username is taken' });
    startSession(req, res, user);
    return json(res, 201, { user: { username: user.username } });
  }

  if (p === '/api/auth/login') {
    const nope = () => json(res, 401, { error: 'wrong username or password' });
    if (!name || typeof body.password !== 'string' || body.password.length > 200) return nope();
    const ip = clientIp(req);
    if (lockedOut(name, ip)) return json(res, 429, { error: 'too many attempts — try again in 15 minutes' });
    noteAttempt(name, ip);
    const user = db().findUser(name);
    const ok = user ? await auth.verifyPassword(body.password, user.pass) : await auth.burnVerify(body.password);
    if (!ok) return nope();
    noteSuccess(name, ip);
    startSession(req, res, user);
    return json(res, 200, { user: { username: user.username } });
  }

  return json(res, 404, { error: 'not found' });
}

async function handleMyState(req, res) {
  const u = currentUser(req, res);
  if (!u) return json(res, 401, { error: 'not signed in' });
  if (req.method === 'GET') {
    const s = db().loadState(u.id);
    return send(res, 200, s || 'null', { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  }
  if (req.method === 'PUT' || req.method === 'POST') {
    if (!writeAllowed(req)) return json(res, 403, { error: 'cross-origin or non-JSON request' });
    const body = await readBody(req);
    try { JSON.parse(body); }
    catch { return json(res, 400, { error: 'body must be valid JSON' }); }
    db().saveState(u.id, body);
    return json(res, 200, { ok: true, savedAt: Date.now() });
  }
  return json(res, 405, { error: 'method not allowed' });
}

async function serveFile(res, file, cache) {
  try {
    const buf = await fsp.readFile(file);
    const etag = '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"';
    send(res, 200, buf, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': cache || 'no-cache',
      ETag: etag,
    });
    return true;
  } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = decodeURIComponent(url.pathname);

  try {
    /* ---- taxa ---- */
    // Short cache: the dataset is edited (synonym alts, fixes) close to the exam,
    // and a day-long cache silently serves stale taxa until a hard refresh.
    if (p === '/api/taxa') return json(res, 200, TAXA, { 'Cache-Control': 'public, max-age=300' });

    /* ---- accounts ---- */
    if (p.startsWith('/api/auth/')) return await handleAuth(req, res, p);
    if (p === '/api/me/state') return await handleMyState(req, res);

    /* ---- state ---- */
    let m = p.match(/^\/api\/state\/([^/]+)$/);
    if (m) {
      if (!ANON_PROFILES) return json(res, 410, { error: 'anonymous profiles are off — sign in' });
      const file = path.join(STATES, safeProfile(m[1]) + '.json');
      if (req.method === 'GET') {
        try { return send(res, 200, await fsp.readFile(file), { 'Content-Type': MIME['.json'] }); }
        catch { return json(res, 200, null); }
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await readBody(req);
        try { JSON.parse(body); }
        catch { return json(res, 400, { error: 'body must be valid JSON' }); }
        const tmp = file + '.' + process.pid + '.tmp';
        await fsp.writeFile(tmp, body);
        await fsp.rename(tmp, file);
        return json(res, 200, { ok: true, savedAt: Date.now() });
      }
      return json(res, 405, { error: 'method not allowed' });
    }

    /* ---- photo manifest ---- */
    m = p.match(/^\/api\/photos\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      if (!BY_ID.has(id)) return json(res, 404, { error: 'unknown taxon' });
      const meta = await ensurePhotos(id);
      return json(res, 200, {
        id,
        photos: (meta.photos || []).map((ph, i) => ({
          url: `/photos/${id}/${ph.file}`,
          attribution: ph.attribution, license: ph.license,
          observed: ph.observed, place: ph.place,
        })),
        error: meta.error || null,
        offline: !!meta.offline,
      }, { 'Cache-Control': 'public, max-age=3600' });
    }

    /* ---- photo bytes ---- */
    m = p.match(/^\/photos\/(\d+)\/(\d+\.jpg)$/);
    if (m) {
      const ok = await serveFile(res, path.join(PHOTOS, m[1], m[2]), 'public, max-age=2592000, immutable');
      if (ok) return;
      return json(res, 404, { error: 'no such photo' });
    }

    /* ---- cache status ---- */
    if (p === '/api/cache-status') {
      let warm = 0, empty = 0;
      for (const t of TAXA) {
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(PHOTOS, String(t.id), 'meta.json'), 'utf8'));
          if (meta.photos && meta.photos.length) warm++; else empty++;
        } catch { /* not fetched */ }
      }
      return json(res, 200, { total: TAXA.length, warm, empty, cold: TAXA.length - warm - empty, offline: OFFLINE });
    }

    /* ---- static ---- */
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
    let rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    if (rel.includes('..')) return json(res, 400, { error: 'bad path' });
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) return json(res, 400, { error: 'bad path' });
    if (await serveFile(res, file)) return;
    // SPA fallback
    if (await serveFile(res, path.join(PUBLIC, 'index.html'))) return;
    return json(res, 404, { error: 'not found' });

  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
});

/* Only bind a port when this file is the entry point. scripts/warm.js
   imports it for ensurePhotos(), and must not start a second listener. */
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`cnps-drill listening on http://${HOST}:${PORT}`);
    console.log(`  data dir: ${DATA}`);
    console.log(`  taxa: ${TAXA.length}${OFFLINE ? '  (OFFLINE — serving cached photos only)' : ''}`);
  });
}

module.exports = { db, ensurePhotos, TAXA, server, applyCuration, licenseOk, pickTaxon, resolveTaxonId };
