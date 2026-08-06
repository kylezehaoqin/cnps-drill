#!/usr/bin/env node
'use strict';
/*
 * Prefetch photos for every taxon into data/photos/.
 *
 * iNaturalist API calls stay throttled to ~1/sec inside server.js, but the
 * image bytes come from the S3 CDN (not rate-limited), so several taxa are
 * warmed at once and their downloads overlap. A full run is API-bound: ~8-12
 * min rather than the old ~25-40.
 *
 *   node scripts/warm.js                  cold + empty taxa
 *   node scripts/warm.js --retry          anything not already warm
 *   node scripts/warm.js --force          re-fetch EVERY taxon (regenerate)
 *   node scripts/warm.js --limit 50       cap the batch (first 50 selected)
 *   node scripts/warm.js --concurrency 8  taxa in flight at once (default 6)
 */

const path = require('path');
const fs = require('fs');
const { ensurePhotos, TAXA } = require('../server.js');

const args = process.argv.slice(2);
const has = f => args.includes(f);
const numFlag = (f, d) => { const i = args.indexOf(f); return i >= 0 ? Number(args[i + 1]) : d; };

const retryOnly = has('--retry');
const force = has('--force');
const limit = numFlag('--limit', Infinity);
const concurrency = Math.max(1, numFlag('--concurrency', 6));
const PER_TAXON = Number(process.env.PHOTOS_PER_TAXON || 6);
const PHOTOS = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'photos');

function countOf(id) {
  try { return (JSON.parse(fs.readFileSync(path.join(PHOTOS, String(id), 'meta.json'), 'utf8')).photos || []).length; }
  catch { return -1; }   // -1 = cold (no meta yet)
}

function coverage() {
  let full = 0, partial = 0, empty = 0;
  for (const t of TAXA) {
    const n = countOf(t.id);
    if (n >= PER_TAXON) full++; else if (n > 0) partial++; else empty++;
  }
  return { full, partial, empty };
}

// Bounded-concurrency pool. API calls serialise inside server.js's throttle, so
// concurrency only overlaps the CDN downloads.
async function pool(items, n, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await worker(items[idx], idx); }
  });
  await Promise.all(runners);
}

(async () => {
  if (process.env.OFFLINE === '1') {
    console.error('OFFLINE=1 is set — the warmer cannot fetch anything. Unset it and re-run.');
    process.exit(1);
  }

  const todo = TAXA.filter(t => {
    if (force) return true;
    const n = countOf(t.id);
    // default: cold or empty. --retry: anything short of a full set, so a taxon
    // left partial by a dropped connection (e.g. the laptop slept mid-run) is
    // picked back up rather than treated as done.
    return retryOnly ? n < PER_TAXON : n <= 0;
  }).slice(0, limit);

  if (!todo.length) {
    console.log('Nothing to fetch — cache is warm.');
    process.exit(0);
  }

  console.log(`Fetching photos for ${todo.length} taxa, ${concurrency} at a time.`);
  let done = 0, ok = 0, fail = 0;

  await pool(todo, concurrency, async (t) => {
    const meta = await ensurePhotos(t.id, force || retryOnly);
    const n = (meta.photos || []).length;
    if (n) ok++; else fail++;
    done++;
    const pct = String(Math.round((done / todo.length) * 100)).padStart(3);
    process.stdout.write(`${pct}%  ${String(done).padStart(3)}/${todo.length}  ` +
      `${n ? String(n).padStart(2) + ' photos' : ' no photos'}  ${t.sci}\n`);
  });

  const c = coverage();
  console.log(`\nDone. ${ok} fetched, ${fail} without photos.`);
  console.log(`Coverage of all ${TAXA.length}: ${c.full} full (>=${PER_TAXON}), ${c.partial} partial, ${c.empty} empty.`);
  if (c.empty || c.partial) console.log('Thin taxa can be pinned by hand in data/curate.json (see docs).');
  process.exit(0);
})();
