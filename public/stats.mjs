/* Study analytics. Pure, no DOM. For now just the capture primitive for the
   confusion graph: record what a learner typed when they got a card wrong. The
   raw strings are kept deliberately un-resolved — a later slice runs the matcher
   over them to build the "confused B with A" graph (see docs/learning-features.md
   and docs/architecture.md). Keeping the record flat — { id, typed, mode, at } —
   is what lets it move to a `misses` table 1:1 if storage ever becomes SQL. */

// Append a miss and bound the log to the most recent `cap` entries. Mutates and
// returns the array. `entry` is { id, typed, mode, at }.
export function recordMiss(misses, entry, cap = 2000) {
  misses.push(entry);
  if (misses.length > cap) misses.splice(0, misses.length - cap);
  return misses;
}
