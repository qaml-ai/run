const DECIMAL = ["B", "kB", "MB", "GB", "TB", "PB"];
const BINARY = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

/** "1.5 kB", or with `binary` "1.5 KiB"; `decimals` (default 1) with trailing ".0" dropped. */
export function formatBytes(bytes, options = {}) {
  if (!Number.isFinite(bytes)) throw new TypeError("bytes must be a finite number");
  const base = options.binary ? 1024 : 1000;
  const units = options.binary ? BINARY : DECIMAL;
  const decimals = options.decimals ?? 1;
  const sign = bytes < 0 ? "-" : "";
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= base && unit < units.length - 1) { value /= base; unit++; }
  const text = unit === 0 ? String(value) : value.toFixed(decimals).replace(/\.0+$/, "");
  return `${sign}${text} ${units[unit]}`;
}

/** "1.5 kB" -> 1500, "2 KiB" -> 2048, "12" -> 12; rounds to whole bytes. */
export function parseBytes(text) {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*([kKMGTP]i?B|B)?\s*$/.exec(text);
  if (!match) throw new SyntaxError(`Invalid size: ${text}`);
  const unit = match[2] ?? "B";
  const power = unit === "B" ? 0 : "KMGTP".indexOf(unit[0].toUpperCase()) + 1;
  return Math.round(Number(match[1]) * (unit.includes("i") ? 1024 : 1000) ** power);
}
