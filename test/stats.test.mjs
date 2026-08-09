#!/usr/bin/env node
/*
 * Stats/analytics tests. No framework:  node test/stats.test.mjs
 * recordMiss is the capture primitive for the confusion graph (see
 * docs/learning-features.md); the graph analysis will grow in stats.mjs.
 */
import { recordMiss } from '../public/stats.mjs';

let fails = 0;
const check = (ok, label) => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`); };

console.log('\n# recordMiss\n');
check(typeof recordMiss === 'function', 'recordMiss is exported');
if (typeof recordMiss === 'function') {
  const m = [];
  recordMiss(m, { id: 5, typed: 'foo', mode: 'com2sci', at: 1 }, 10);
  check(m.length === 1 && m[0].typed === 'foo' && m[0].id === 5, 'appends the miss unchanged');

  const capped = [];
  for (let i = 0; i < 15; i++) recordMiss(capped, { id: i, typed: 't' + i, mode: 'x', at: i }, 10);
  check(capped.length === 10, 'never grows past the cap');
  check(capped[0].id === 5 && capped[9].id === 14, 'cap keeps the most recent entries');

  check(recordMiss([], { id: 1, typed: 'a', mode: 'x', at: 1 }).length === 1, 'works with the default cap and returns the list');
}

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nall tests pass\n');
process.exit(fails ? 1 : 0);
