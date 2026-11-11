import { center, padEnd, padStart } from "./pad.js";

/**
 * A plain-text table of objects: a header row, a rule, then one line per row. `columns` picks and orders the keys
 * (default: the first row's), `align` maps a column to "left" (default), "right" or "center".
 */
export function formatTable(rows, options = {}) {
  if (!rows.length) return "";
  const columns = options.columns ?? Object.keys(rows[0]);
  const align = options.align ?? {};
  const cells = [columns.map(String), ...rows.map((row) => columns.map((column) => (row[column] == null ? "" : String(row[column]))))];
  const widths = columns.map((_, index) => Math.max(...cells.map((line) => line[index].length)));
  const fit = (value, index) => {
    const how = align[columns[index]] ?? "left";
    if (how === "right") return padStart(value, widths[index]);
    if (how === "center") return center(value, widths[index]);
    return padEnd(value, widths[index]);
  };
  const line = (values) => values.map(fit).join(" | ").trimEnd();
  const rule = widths.map((width) => "-".repeat(width)).join("-+-");
  return [line(cells[0]), rule, ...cells.slice(1).map(line)].join("\n");
}
