/**
 * Wraps text at `width` columns, keeping paragraphs (newlines). A word longer than the width stays whole on its
 * own line unless `hard` is set, which splits it. `indent` prefixes every line (and does not count toward width).
 */
export function wordWrap(text, width, options = {}) {
  if (!Number.isInteger(width) || width < 1) throw new RangeError("width must be a positive integer");
  const indent = options.indent ?? "";
  const lines = [];
  for (const paragraph of String(text).split("\n")) {
    let line = "";
    for (let word of paragraph.split(/\s+/).filter(Boolean)) {
      while (options.hard && word.length > width) {
        if (line) { lines.push(line); line = ""; }
        lines.push(word.slice(0, width));
        word = word.slice(width);
      }
      if (!word) continue;
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += " " + word;
      else { lines.push(line); line = word; }
    }
    lines.push(line);
  }
  return lines.map((line) => indent + line).join("\n");
}
