/**
 * Parses CSV (RFC 4180 quoting, CRLF or LF). With `header`, rows become objects keyed by the first row.
 * `delimiter` defaults to ",".
 */
export function parseCsv(text, options = {}) {
  const delimiter = options.delimiter ?? ",";
  const rows = [];
  let row = [];
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

/** Rows of values as CSV; null and undefined are empty, and fields that need it are quoted. */
export function toCsv(rows, options = {}) {
  const delimiter = options.delimiter ?? ",";
  const quote = (value) => {
    const text = value == null ? "" : String(value);
    return /[",\r\n]/.test(text) || text.includes(delimiter) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return rows.map((values) => values.map(quote).join(delimiter)).join("\n");
}
