#!/usr/bin/env node
'use strict';
/*
 * Scoring tests. No framework, no dependencies:  node test/scoring.test.js
 *
 * The matcher functions live inside public/app.js as browser globals, so we
 * slice that region out and eval it. If you move them, update SLICE_START /
 * SLICE_END below rather than duplicating the logic here — two copies of the
 * matcher that drift apart is worse than this hack.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SLICE_START = 'function norm(';
const SLICE_END = '/* ============================ pool';

const src = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const a = src.indexOf(SLICE_START), b = src.indexOf(SLICE_END);
if (a < 0 || b < 0) { console.error('Could not locate the matcher region in public/app.js'); process.exit(2); }
// Indirect eval: this file is strict, and a direct eval would keep the
// declarations local to the eval scope. (0, eval) evaluates in global scope.
(0, eval)(src.slice(a, b));
const { scoreBinomial, scoreCommon, wordMatch, norm } = globalThis;
if (typeof scoreBinomial !== 'function') { console.error('Matcher functions did not load'); process.exit(2); }

const TAXA = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/taxa.json'), 'utf8'));
const find = s => TAXA.find(t => t.sci === s);

let fails = 0;
const check = (ok, label) => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`); };

/* ---------------------------------------------------------------- */
console.log('\n# binomial scoring\n');

const cases = [
  ['Quercus agrifolia',        'Quercus agrifolia', 2, 'exact'],
  ['quercus agrifolia',        'Quercus agrifolia', 2, 'case insensitive'],
  ['  Quercus   agrifolia ',   'Quercus agrifolia', 2, 'sloppy whitespace'],
  ['Quercus agrifolium',       'Quercus agrifolia', 2, 'gender-ending slip -> near, still scores'],
  ['Quercus',                  'Quercus agrifolia', 1, 'genus only'],
  ['agrifolia',                'Quercus agrifolia', 1, 'epithet only'],
  ['Quercus lobata',           'Quercus agrifolia', 1, 'right genus, wrong species'],
  ['Pinus ponderosa',          'Quercus agrifolia', 0, 'unrelated'],
  ['',                         'Quercus agrifolia', 0, 'blank'],
  ['Pseudotsuga menzesii',     'Pseudotsuga menziesii', 2, 'one-letter typo tolerated'],
  ['Escholzia californica',    'Eschscholzia californica', 2, 'dropped syllable tolerated'],
  ['Arctostaphylos',           'Arctostaphylos spp.', 1, 'genus-level taxon caps at 1'],
  ['Arctostaphylos spp',       'Arctostaphylos spp.', 1, 'trailing spp ignored'],
  ['Mimulus aurantiacus',      'Diplacus [Mimulus] aurantiacus', 2, 'synonym genus accepted'],
  ['Diplacus aurantiacus',     'Diplacus [Mimulus] aurantiacus', 2, 'current genus accepted'],
  ['Lotus',                    'Acmispon [Lotus] spp.', 1, 'synonym on genus-level taxon'],
  ['Abies lowiana',            'Abies concolor/lowiana', 2, 'slashed epithet, alternate'],
  ['Abies concolor',           'Abies concolor/lowiana', 2, 'slashed epithet, primary'],
];
for (const [input, sci, want, note] of cases) {
  const t = find(sci);
  if (!t) { check(false, `MISSING TAXON ${sci}`); continue; }
  const s = scoreBinomial(input, t, false);
  check(s.pts === want, `${s.pts}/${s.max} (want ${want})  ${note.padEnd(38)} "${input}" -> ${sci}`);
}

/* ---------------------------------------------------------------- */
console.log('\n# strict mode\n');
check(scoreBinomial('Pseudotsuga menzesii', find('Pseudotsuga menziesii'), true).pts === 1,
  'strict mode rejects a typo that lenient mode accepts');
check(scoreBinomial('Pseudotsuga menziesii', find('Pseudotsuga menziesii'), true).pts === 2,
  'strict mode still accepts an exact match');

/* ---------------------------------------------------------------- */
console.log('\n# near vs exact are tracked separately\n');
const nearCase = scoreBinomial('Quercus agrifolium', find('Quercus agrifolia'), false);
check(nearCase.pts === 2 && nearCase.exact === 1 && nearCase.clean === false,
  'a near match scores the point but is not clean (drives the amber flag)');

/* ---------------------------------------------------------------- */
console.log('\n# common names\n');
const commons = [
  ['coast live oak',  'Quercus agrifolia', true],
  ['Coast Live Oak',  'Quercus agrifolia', true],
  ['chamise',         'Adenostoma fasciculatum', true],
  ['toyon',           'Heteromeles arbutifolia', true],
  ['christmas holly', 'Heteromeles arbutifolia', true],
  ['blue oak',        'Quercus agrifolia', false],
  ['',                'Quercus agrifolia', false],
];
for (const [input, sci, want] of commons) {
  const r = scoreCommon(input, find(sci), false);
  check(r.full === want, `common "${input}" -> ${sci}  full=${r.full} (want ${want})`);
}

/* ---------------------------------------------------------------- */
console.log('\n# congeners on the list must stay distinguishable\n');
const pairs = [
  ['Delphinium parishii', 'Delphinium parryi'],
  ['Hordeum murinum',     'Hordeum marinum'],      // one letter apart, both on the list
  ['Cornus nuttallii',    'Corylus cornuta'],      // one token must not pay for both slots
  ['Quercus lobata',      'Quercus kelloggii'],
  ['Salvia apiana',       'Salvia mellifera'],
  ['Pinus contorta',      'Pinus ponderosa'],
  ['Ribes cereum',        'Ribes aureum'],
  ['Bromus tectorum',     'Bromus diandrus'],
  ['Iris douglasiana',    'Iris missouriensis'],
  ['Rubus ursinus',       'Rubus parviflorus'],
  ['Sanicula arguta',     'Sanicula crassicaulis'],
  ['Cirsium vulgare',     'Cirsium arvense'],
  ['Eriogonum nudum',     'Eriogonum umbellatum'],
  ['Prunus ilicifolia',   'Prunus emarginata'],
];
for (const [wrote, actual] of pairs) {
  const s = scoreBinomial(wrote, find(actual), false);
  check(s.pts < 2, `"${wrote}" scores ${s.pts}/2 against ${actual}`);
}

/* ---------------------------------------------------------------- */
console.log('\n# exhaustive: no taxon earns full credit against any other\n');
let collisions = 0;
for (const target of TAXA) {
  if (!target.epithet) continue;
  for (const other of TAXA) {
    if (other.id === target.id || !other.epithet) continue;
    if (scoreBinomial(other.sci, target, false).pts === 2) {
      collisions++;
      if (collisions <= 8) console.log(`      collision: "${other.sci}" -> ${target.sci}`);
    }
  }
}
check(collisions === 0, `${collisions} full-credit collisions across ${TAXA.length}^2 pairs`);

/* ---------------------------------------------------------------- */
console.log('\n# dataset integrity\n');
check(TAXA.length === 500, `500 taxa (have ${TAXA.length})`);
check(new Set(TAXA.map(t => t.id)).size === TAXA.length, 'ids are unique');
check(TAXA.every(t => t.sci && t.common && t.habit && t.family), 'no empty fields');
check(TAXA.every(t => t.genusOnly || t.epithet || t.sci === 'Abies concolor/lowiana'),
  'every non-genus-only taxon has an epithet');
check(TAXA.filter(t => t.genusOnly).length === 60, 'genus-only count is 60');

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nall tests pass\n');
process.exit(fails ? 1 : 0);
