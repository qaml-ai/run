const filler = (fill: string, count: number) => (count > 0 ? fill.repeat(Math.ceil(count / fill.length)).slice(0, count) : "");

export function padStart(input: unknown, width: number, fill = " "): string {
  const text = String(input);
  return filler(fill, width - text.length) + text;
}

export function padEnd(input: unknown, width: number, fill = " "): string {
  const text = String(input);
  return text + filler(fill, width - text.length);
}

export function center(input: unknown, width: number, fill = " "): string {
  const text = String(input);
  const extra = Math.max(0, width - text.length);
  const left = Math.floor(extra / 2);
  return filler(fill, left) + text + filler(fill, extra - left);
}
