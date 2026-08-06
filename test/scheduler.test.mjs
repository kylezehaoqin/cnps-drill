#!/usr/bin/env node
/*
 * Scheduler tests. No framework:  node test/scheduler.test.mjs
 * The scheduling algorithm had no tests before it was a module.
 */
import { LADDER_CRAM, LADDER_LONG, ladderFor, isSolid, weakness, advance } from '../public/scheduler.mjs';

let fails = 0;
const check = (ok, label) => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`); };
const card = o => Object.assign({ step: 0, due: 0, reps: 0, lapses: 0, right: 0, wrong: 0, last: 0 }, o);
const MIN = 60000, NOW = 1000000;

console.log('\n# ladder + isSolid\n');
check(ladderFor({ ladder: 'cram' }) === LADDER_CRAM, 'cram config selects the minute ladder');
check(ladderFor({ ladder: 'long' }) === LADDER_LONG, 'long config selects the long ladder');
check(ladderFor(undefined) === LADDER_LONG, 'missing config falls back to the long ladder');
check(isSolid(card({ step: LADDER_CRAM.length - 2 }), LADDER_CRAM), 'solid at two steps from the end');
check(!isSolid(card({ step: LADDER_CRAM.length - 3 }), LADDER_CRAM), 'not solid three steps from the end');
check(!isSolid(undefined, LADDER_CRAM), 'a missing card is not solid');

console.log('\n# weakness ordering\n');
check(weakness(card({ lapses: 2 })) > weakness(card({ lapses: 0 })), 'more lapses = weaker');
check(weakness(card({ right: 1, wrong: 3 })) > weakness(card({ right: 3, wrong: 1 })), 'lower accuracy = weaker');

console.log('\n# advance (grade transitions)\n');
const again = advance(card({ step: 4, reps: 5, right: 3 }), 0, LADDER_CRAM, NOW);
check(again.step === 0 && again.lapses === 1 && again.wrong === 1 && again.reps === 6,
  'again (0) resets step to 0, lapses++, wrong++, reps++');
check(again.due === NOW + LADDER_CRAM[0] * MIN && again.last === NOW, 'again reschedules off step 0');

const good = advance(card({ step: 2, reps: 1 }), 2, LADDER_CRAM, NOW);
check(good.step === 3 && good.right === 1 && good.due === NOW + LADDER_CRAM[3] * MIN, 'good (2) advances one step');

const easy = advance(card({ step: 2 }), 3, LADDER_CRAM, NOW);
check(easy.step === 4, 'easy (3) advances two steps');

const cap = advance(card({ step: LADDER_CRAM.length - 1 }), 3, LADDER_CRAM, NOW);
check(cap.step === LADDER_CRAM.length - 1, 'step never runs off the end of the ladder');

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nall tests pass\n');
process.exit(fails ? 1 : 0);
