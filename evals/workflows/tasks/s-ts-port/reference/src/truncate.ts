export interface TruncateOptions { ellipsis?: string; wordBoundary?: boolean }

export function truncate(input: unknown, length: number, options: TruncateOptions = {}): string {
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
