const filler = (fill, count) => (count > 0 ? fill.repeat(Math.ceil(count / fill.length)).slice(0, count) : "");

export function padStart(input, width, fill = " ") {
  const text = String(input);
  return filler(fill, width - text.length) + text;
}

export function padEnd(input, width, fill = " ") {
  const text = String(input);
  return text + filler(fill, width - text.length);
}

/** Centers text in `width`, the extra column (if odd) on the right. */
export function center(input, width, fill = " ") {
  const text = String(input);
  const extra = Math.max(0, width - text.length);
  const left = Math.floor(extra / 2);
  return filler(fill, left) + text + filler(fill, extra - left);
}
