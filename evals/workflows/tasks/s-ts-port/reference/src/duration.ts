const UNITS: readonly (readonly [string, number])[] = [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000], ["s", 1000], ["ms", 1]];

export function formatDuration(ms: number, options: { largest?: number } = {}): string {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError("ms must be a non-negative finite number");
  const largest = options.largest ?? Infinity;
  const parts: string[] = [];
  let rest = Math.round(ms);
  for (const [unit, size] of UNITS) {
    if (parts.length >= largest) break;
    const count = Math.floor(rest / size);
    if (count) { parts.push(`${count}${unit}`); rest -= count * size; }
  }
  return parts.length ? parts.join(" ") : "0ms";
}

export function parseDuration(text: string): number {
  const pattern = /(\d+(?:\.\d+)?)\s*(ms|d|h|m|s)/g;
  let total = 0;
  let matched = "";
  for (const match of String(text).matchAll(pattern)) {
    const size = UNITS.find(([unit]) => unit === match[2])?.[1] ?? 0;
    total += Number(match[1]) * size;
    matched += match[0];
  }
  if (!matched || String(text).replace(/\s+/g, "") !== matched.replace(/\s+/g, "")) throw new SyntaxError(`Invalid duration: ${text}`);
  return total;
}
