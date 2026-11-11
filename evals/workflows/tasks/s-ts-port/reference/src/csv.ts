export interface CsvOptions { delimiter?: string }

export function parseCsv(text: string, options: CsvOptions & { header: true }): Record<string, string>[];
export function parseCsv(text: string, options?: CsvOptions & { header?: false }): string[][];
export function parseCsv(text: string, options: CsvOptions & { header?: boolean } = {}): string[][] | Record<string, string>[] {
  const delimiter = options.delimiter ?? ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (quoted) {
      if (character !== '"') field += character;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (character === '"' && field === "") quoted = true;
    else if (character === delimiter) { row.push(field); field = ""; }
    else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (quoted) throw new SyntaxError("Unterminated quoted field");
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  if (!options.header) return rows;
  const [head = [], ...body] = rows;
  return body.map((values) => Object.fromEntries(head.map((name, index) => [name, values[index] ?? ""])));
}

export function toCsv(rows: readonly (readonly unknown[])[], options: CsvOptions = {}): string {
  const delimiter = options.delimiter ?? ",";
  const quote = (value: unknown) => {
    const text = value == null ? "" : String(value);
    return /[",\r\n]/.test(text) || text.includes(delimiter) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return rows.map((values) => values.map(quote).join(delimiter)).join("\n");
}
