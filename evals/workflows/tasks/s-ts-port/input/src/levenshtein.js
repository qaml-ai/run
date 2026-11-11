/** Levenshtein edit distance (insertions, deletions, substitutions each cost 1). */
export function distance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * The candidate nearest to `word`, the first one on a tie; undefined when none is within `maxDistance`.
 * Case-insensitive unless `caseSensitive`.
 */
export function closest(word, candidates, options = {}) {
  const max = options.maxDistance ?? Infinity;
  const fold = (text) => (options.caseSensitive ? text : text.toLowerCase());
  let best;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const d = distance(fold(word), fold(candidate));
    if (d < bestDistance) { best = candidate; bestDistance = d; }
  }
  return bestDistance <= max ? best : undefined;
}
