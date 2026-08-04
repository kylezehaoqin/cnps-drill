#!/usr/bin/env node
'use strict';
/*
 * CNPS Sight-ID Drill — server
 * Node 18+, zero dependencies.
 *
 *   GET  /                      app
 *   GET  /api/taxa              the 500 taxa
 *   GET  /api/state/:profile    saved progress (JSON)
 *   PUT  /api/state/:profile    save progress
 *   GET  /api/photos/:id        photo manifest for taxon id (fetches + caches on miss)
 *   GET  /photos/:id/:n.jpg     cached image bytes
 *   GET  /api/cache-status      how warm the photo cache is
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const PHOTOS = path.join(DATA, 'photos');
const STATES = path.join(DATA, 'states');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PHOTOS_PER_TAXON = Number(process.env.PHOTOS_PER_TAXON || 6);
const OFFLINE = process.env.OFFLINE === '1';

const TAXA = JSON.parse(fs.readFileSync(path.join(DATA, 'taxa.json'), 'utf8'));
const BY_ID = new Map(TAXA.map(t => [t.id, t]));

for (const d of [PHOTOS, STATES]) fs.mkdirSync(d, { recursive: true });

/* ------------------------------------------------------------------ */
/* iNaturalist photo fetching                                          */
/* ------------------------------------------------------------------ */

const INAT = 'https://api.inaturalist.org/v1';
const LICENSES = 'cc0,cc-by,cc-by-nc,cc-by-sa,cc-by-nc-sa';
const UA = 'cnps-sight-id-drill/1.0 (self-hosted study tool)';

// Serialise outbound calls; iNat asks for <=60/min and no bursts.
let chain = Promise.resolve();
let lastCall = 0;
function throttled(fn) {
  chain = chain.then(async () => {
    const wait = Math.max(0, 1100 - (Date.now() - lastCall));
    if (wait) await new Promise(r => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  }).catch(() => {});
  return chain;
}

async function jget(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function resolveTaxonId(taxon) {
  const rank = taxon.genusOnly || !taxon.epithet ? 'genus' : 'species';
  const url = `${INAT}/taxa?q=${encodeURIComponent(taxon.query)}&rank=${rank}&per_page=5`;
  const j = await jget(url);
  const wanted = taxon.query.toLowerCase();
  const hit = (j.results || []).find(r => (r.name || '').toLowerCase() === wanted)
           || (j.results || [])[0];
  return hit ? hit.id : null;
}

async function fetchPhotoList(inatId) {
  const url = `${INAT}/observations?taxon_id=${inatId}&quality_grade=research`
    + `&photos=true&license=${LICENSES}&photo_license=${LICENSES}`
    + `&order_by=votes&per_page=${PHOTOS_PER_TAXON * 2}`;
  const j = await jget(url);
  const out = [];
  const seen = new Set();
  for (const obs of j.results || []) {
    for (const p of obs.photos || []) {
      if (!p.url || seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({
        src: p.url.replace('/square.', '/medium.'),
        attribution: p.attribution || '',
        license: p.license_code || '',
        observed: obs.observed_on || '',
        place: (obs.place_guess || '').split(',').slice(0, 2).join(',').trim(),
      });
      if (out.length >= PHOTOS_PER_TAXON) return out;
    }
  }
  return out;
}

async function download(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`img ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 900) throw new Error('img too small');
  await fsp.writeFile(dest, buf);
  return buf.length;
}

const inflight = new Map();

async function ensurePhotos(id, force) {
  const dir = path.join(PHOTOS, String(id));
  const metaPath = path.join(dir, 'meta.json');
  try {
    const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
    if (meta.photos && meta.photos.length) return meta;
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
      const inatId = await throttled(() => resolveTaxonId(taxon));
      if (!inatId) throw new Error('no iNat taxon');
      meta.inatId = inatId;
      const list = await throttled(() => fetchPhotoList(inatId));
      let n = 0;
      for (const p of list) {
        const file = `${n}.jpg`;
        try {
          await download(p.src, path.join(dir, file));
          meta.photos.push({ file, attribution: p.attribution, license: p.license,
                             observed: p.observed, place: p.place });
          n++;
        } catch { /* skip this image */ }
      }
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
    if (p === '/api/taxa') return json(res, 200, TAXA, { 'Cache-Control': 'public, max-age=86400' });

    /* ---- state ---- */
    let m = p.match(/^\/api\/state\/([^/]+)$/);
    if (m) {
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

module.exports = { ensurePhotos, TAXA, server };
