#!/usr/bin/env node
'use strict';
/*
 * Prefetch photos for every taxon into data/photos/.
 * Run once after deploying — takes roughly 20-30 minutes for all 500
 * because outbound calls to iNaturalist are throttled to ~1/sec.
 *
 *   node scripts/warm.js              all 500
 *   node scripts/warm.js --retry      only the ones with no photos yet
 *   node scripts/warm.js --limit 50   first 50 cold taxa
 */

const path = require('path');
const fs = require('fs');
const { ensurePhotos, TAXA } = require('../server.js');

const args = process.argv.slice(2);
const retryOnly = args.includes('--retry');
const limIdx = args.indexOf('--limit');
const limit = limIdx >= 0 ? Number(args[limIdx + 1]) : Infinity;
const PHOTOS = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'photos');

function statusOf(id) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(PHOTOS, String(id), 'meta.json'), 'utf8'));
    return m.photos && m.photos.length ? 'warm' : 'empty';
  } catch { return 'cold'; }
}

(async () => {
  if (process.env.OFFLINE === '1') {
    console.error('OFFLINE=1 is set — the warmer cannot fetch anything. Unset it and re-run.');
    process.exit(1);
  }

  const todo = TAXA.filter(t => {
    const s = statusOf(t.id);
    return retryOnly ? s !== 'warm' : s === 'cold' || s === 'empty';
  }).slice(0, limit);

  if (!todo.length) {
    console.log('Nothing to fetch — cache is warm.');
    process.exit(0);
  }

  console.log(`Fetching photos for ${todo.length} taxa. Roughly ${Math.ceil(todo.length * 2.4 / 60)} min.`);
  let ok = 0, fail = 0;

  for (let i = 0; i < todo.length; i++) {
    const t = todo[i];
    const meta = await ensurePhotos(t.id, retryOnly);
    const n = (meta.photos || []).length;
    if (n) ok++; else fail++;
    const pct = String(Math.round(((i + 1) / todo.length) * 100)).padStart(3);
    process.stdout.write(`${pct}%  ${String(i + 1).padStart(3)}/${todo.length}  ` +
      `${n ? String(n).padStart(2) + ' photos' : ' no photos'}  ${t.sci}\n`);
  }

  console.log(`\nDone. ${ok} taxa with photos, ${fail} without.`);
  if (fail) console.log('Re-run with --retry later; iNaturalist coverage of some genus-only entries is thin.');
  process.exit(0);
})();
