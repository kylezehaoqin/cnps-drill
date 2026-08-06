#!/usr/bin/env node
'use strict';
/*
 * Photo-selection tests. No framework:  node test/photos.test.js
 *
 * Requiring server.js is safe: it reads taxa.json and makes data dirs but does
 * not listen() (guarded by require.main === module), so the pure helpers below
 * are reachable without starting a server or touching the network.
 */
const { applyCuration, licenseOk, pickTaxon } = require('../server.js');

let fails = 0;
const check = (ok, label) => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`); };

console.log('\n# licenseOk\n');
check(typeof licenseOk === 'function', 'licenseOk is exported');
if (typeof licenseOk === 'function') {
  check(licenseOk('cc-by') && licenseOk('cc0') && licenseOk('cc-by-nc'), 'accepts the allowed set');
  check(!licenseOk('cc-by-nd') && !licenseOk(null) && !licenseOk(''), 'rejects ND / all-rights-reserved / missing');
}

console.log('\n# applyCuration\n');
check(typeof applyCuration === 'function', 'applyCuration is exported');
if (typeof applyCuration === 'function') {
  const cand = n => Array.from({ length: n }, (_, i) => ({ photoId: 100 + i, src: `u${i}`, license: 'cc-by' }));

  const passthrough = applyCuration(cand(4), undefined, 6);
  check(passthrough.length === 4 && passthrough[0].photoId === 100, 'no entry: candidates pass through in order');

  const clipped = applyCuration(cand(10), undefined, 6);
  check(clipped.length === 6, 'clips to n');

  const blocked = applyCuration(cand(4), { block: [101, 103] }, 6);
  check(blocked.length === 2 && blocked.every(c => c.photoId !== 101 && c.photoId !== 103),
    'block removes candidates by photoId');

  const pinEntry = { url: 'PIN', attribution: '(c) me', license: 'cc-by-nd' };  // a license the filter would reject
  const pinned = applyCuration(cand(4), { pin: [pinEntry] }, 6);
  check(pinned[0].src === 'PIN' && pinned.length === 5, 'pin is prepended and survives a rejected license');

  const both = applyCuration(cand(6), { block: [100, 101], pin: [pinEntry] }, 3);
  check(both.length === 3 && both[0].src === 'PIN' && both.every(c => c.photoId !== 100 && c.photoId !== 101),
    'pin + block + clip to n together, pin first');
}

console.log('\n# pickTaxon\n');
check(typeof pickTaxon === 'function', 'pickTaxon is exported');
if (typeof pickTaxon === 'function') {
  const juncus   = { query: 'Juncus mexicanus', genus: 'Juncus', epithet: 'mexicanus', genusOnly: false, alts: [] };
  const raphanus = { query: 'Raphanus sativus', genus: 'Raphanus', epithet: 'sativus', genusOnly: false, alts: [] };
  const vulpia   = { query: 'Vulpia', genus: 'Vulpia', epithet: '', genusOnly: true, alts: ['Festuca'] };
  const quercus  = { query: 'Quercus agrifolia', genus: 'Quercus', epithet: 'agrifolia', genusOnly: false, alts: [] };
  const C = (id, name, rank, is_active = true) => ({ id, name, rank, is_active });

  check(pickTaxon([C(9, 'Wrong wrongata', 'species'), C(5, 'Quercus agrifolia', 'species')], quercus) === 5,
    'exact name match wins over an earlier wrong candidate');
  check(pickTaxon([C(1482818, 'Juncus balticus mexicanus', 'subspecies')], juncus) === 1482818,
    'accepts a subspecies whose genus matches and epithet appears (Juncus mexicanus)');
  check(pickTaxon([C(77, 'Raphanus raphanistrum sativus', 'subspecies')], raphanus) === 77,
    'accepts a reassigned/demoted match (Raphanus raphanistrum sativus)');
  check(pickTaxon([C(47110, 'Festuca', 'genus')], vulpia) === 47110,
    'genus-only: accepts an alt-genus candidate (Vulpia -> Festuca)');
  check(pickTaxon([C(99, 'Pinus ponderosa', 'species')], juncus) === null,
    'rejects a candidate sharing neither genus nor epithet');
  check(pickTaxon([C(20, 'Juncus balticus mexicanus', 'subspecies'), C(21, 'Juncus foo mexicanus', 'species')], juncus) === 21,
    'prefers species over subspecies among valid matches');
  check(pickTaxon([C(30, 'Juncus one mexicanus', 'subspecies', false), C(31, 'Juncus two mexicanus', 'subspecies', true)], juncus) === 31,
    'prefers active over inactive');
  check(pickTaxon([], juncus) === null && pickTaxon(undefined, juncus) === null,
    'empty / missing candidates -> null');

  // Synonym taxa: taxa.json lists the former name, iNat serves the current one,
  // and BOTH the genus and epithet can differ — the current epithet lives in the
  // alt binomial, so the identity check must accept alt epithets too.
  const pennisetum = { query: 'Pennisetum setaceum', genus: 'Pennisetum', epithet: 'setaceum', genusOnly: false, alts: ['Cenchrus setaceus'] };
  check(pickTaxon([C(430581, 'Cenchrus setaceus', 'species')], pennisetum) === 430581,
    'accepts the current accepted name from an alt binomial (genus AND epithet changed)');
  const festuca = { query: 'Festuca arundinacea', genus: 'Festuca', epithet: 'arundinacea', genusOnly: false, alts: ['Lolium arundinaceum', 'Schedonorus arundinaceus'] };
  check(pickTaxon([C(164708, 'Lolium arundinaceum', 'species')], festuca) === 164708,
    'accepts a current name matching one of several alt binomials');
  check(pickTaxon([C(1, 'Cenchrus ciliaris', 'species')], pennisetum) === null,
    'still rejects a different species in the alt genus (right genus, wrong epithet)');
}

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nall tests pass\n');
process.exit(fails ? 1 : 0);
