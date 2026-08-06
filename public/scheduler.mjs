/* Scheduling — the spaced-repetition ladder and how a graded card moves along
   it. Pure, no DOM and no global state: app.js passes the card, config, and
   ladder in. Orchestration (which card is due, the queue, saving) stays in
   app.js; only the algorithm lives here so it can be unit-tested.

   LADDER_CRAM is in MINUTES: 1, 6, 20, 60, 240, 720, 1440, 2880. Ordinary spaced
   repetition schedules in days, useless when the exam is days away — a card due
   next Tuesday never comes back. LADDER_LONG is the conventional ladder for after
   the exam. isSolid means "within two steps of the end of the current ladder",
   so its meaning shifts with the ladder — intentional. */

export const LADDER_CRAM = [1, 6, 20, 60, 240, 720, 1440, 2880];
export const LADDER_LONG = [10, 1440, 4320, 10080, 21600, 43200, 86400];
const MIN = 60000;

export const ladderFor = cfg => (cfg && cfg.ladder === 'cram' ? LADDER_CRAM : LADDER_LONG);
export const isSolid = (card, ladder) => !!card && card.step >= ladder.length - 2;

// Weakest first: more lapses and lower accuracy surface sooner. Used to order
// the due queue.
export const weakness = k => k.lapses * 2 - (k.right / Math.max(1, k.right + k.wrong));

// Apply a grade to a card's schedule fields and return it. q: 0 again, 1 hard,
// 2 good, 3 easy. Mutates only the card; the caller owns the queue and saving.
export function advance(card, q, ladder, now = Date.now()) {
  if (q === 0) { card.lapses++; card.wrong++; card.step = 0; }
  else {
    card.right++;
    if (q === 1) card.step = Math.max(0, card.step);
    if (q === 2) card.step = Math.min(ladder.length - 1, card.step + 1);
    if (q === 3) card.step = Math.min(ladder.length - 1, card.step + 2);
  }
  card.due = now + ladder[Math.max(0, card.step)] * MIN;
  card.reps++;
  card.last = now;
  return card;
}
