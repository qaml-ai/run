export interface WrapOptions { indent?: string; hard?: boolean }

export function wordWrap(text: unknown, width: number, options: WrapOptions = {}): string {
  if (!Number.isInteger(width) || width < 1) throw new RangeError("width must be a positive integer");
  const indent = options.indent ?? "";
  const lines: string[] = [];
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
