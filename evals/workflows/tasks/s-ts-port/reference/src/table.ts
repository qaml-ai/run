import { center, padEnd, padStart } from "./pad.ts";

export type Align = "left" | "right" | "center";
export interface TableOptions { columns?: string[]; align?: Record<string, Align> }

export function formatTable(rows: readonly Record<string, unknown>[], options: TableOptions = {}): string {
  const first = rows[0];
  if (!first) return "";
  const columns = options.columns ?? Object.keys(first);
  const align = options.align ?? {};
  const cells = [columns.map(String), ...rows.map((row) => columns.map((column) => (row[column] == null ? "" : String(row[column]))))];
  const widths = columns.map((_, index) => Math.max(...cells.map((line) => line[index]!.length)));
  const fit = (value: string, index: number) => {
    const how = align[columns[index]!] ?? "left";
    if (how === "right") return padStart(value, widths[index]!);
    if (how === "center") return center(value, widths[index]!);
    return padEnd(value, widths[index]!);
  };
  const line = (values: string[]) => values.map(fit).join(" | ").trimEnd();
  const rule = widths.map((width) => "-".repeat(width)).join("-+-");
  return [line(cells[0]!), rule, ...cells.slice(1).map(line)].join("\n");
}
