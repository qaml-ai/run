/**
 * Shortens text to at most `length` characters, ellipsis included.
 * Options: `ellipsis` (default "…"), `wordBoundary` (cut at the last space that fits).
 */
export function truncate(input, length, options = {}) {
  const ellipsis = options.ellipsis ?? "…";
  const text = String(input);
  if (text.length <= length) return text;
  let cut = text.slice(0, Math.max(0, length - ellipsis.length));
  if (options.wordBoundary) {
    const space = cut.lastIndexOf(" ");
    if (space > 0) cut = cut.slice(0, space);
  }
  return cut.trimEnd() + ellipsis;
}
