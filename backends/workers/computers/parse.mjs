// Runs only inside the isolated Linux computer. No user input is evaluated.
import { readFile, stat } from "node:fs/promises";
const [path, format] = process.argv.slice(2);
if (!path?.startsWith("/workspace/") || path.split("/").includes(".."))
  throw Error("Invalid workspace path");
if (!["text", "json", "csv", "html"].includes(format))
  throw Error("Unsupported document format");
const info = await stat(path);
if (!info.isFile() || info.size > 8 * 1024 * 1024)
  throw Error("Document exceeds 8 MiB or is not a regular file");
const content = await readFile(path, "utf8");
let text = content;
if (format === "json") text = JSON.stringify(JSON.parse(content), null, 2);
if (format === "csv") {
  const rows = [];
  let row = [],
    field = "",
    quoted = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '"' && (quoted || field === "")) {
      if (quoted && content[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((ch === "\r" || ch === "\n") && !quoted) {
      if (ch === "\r" && content[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (quoted) throw Error("Unclosed CSV quote");
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  text = rows.map((fields) => fields.join("\t")).join("\n");
}
if (format === "html") {
  text = content
    .replace(
      /<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,
      "",
    )
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(
      /&(?:amp|lt|gt|quot|apos|nbsp);/g,
      (entity) =>
        ({
          "&amp;": "&",
          "&lt;": "<",
          "&gt;": ">",
          "&quot;": '"',
          "&apos;": "'",
          "&nbsp;": " ",
        })[entity],
    )
    .trim();
}
const originalLength = text.length;
text = text.slice(0, 60000);
let output;
do {
  output = JSON.stringify({
    format,
    bytes: info.size,
    text,
    truncated: text.length < originalLength,
  });
  if (Buffer.byteLength(output) <= 60000) break;
  text = text.slice(0, Math.floor(text.length * 0.8));
} while (text.length);
process.stdout.write(output);
