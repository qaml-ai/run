import { parse } from "@babel/parser";
import { readFile, readdir } from "node:fs/promises";

/** Scope exclusions are inventoried without importing their Node-only fixtures. */
export async function excludedCases() {
  const directory = new URL("../", import.meta.url), rows = [];
  for (const file of (await readdir(directory)).filter(file => /^(?:channels?|voice|speech|transcription).*\.test\.ts$/.test(file)).sort()) {
    const source = await readFile(new URL(file, directory), "utf8");
    const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
    const area = file.startsWith("channel") ? "channels" : "voice";
    const scan = node => {
      if (!node || typeof node !== "object") return;
      if (node.type === "CallExpression" && /^test(?:\.(?:skip|todo))?$/.test(source.slice(node.callee.start, node.callee.end))) {
        const title = node.arguments[0];
        const name = title.type === "StringLiteral" ? title.value : source.slice(title.start, title.end);
        const line = node.loc.start.line;
        rows.push({ area, source: `tests/${file}:${line}`, name, file: "scope", status: "out-of-scope", backend: "none", reason: "Channels and voice/audio are deliberately out of scope" });
        return;
      }
      for (const [key, value] of Object.entries(node)) if (key !== "loc") {
        if (Array.isArray(value)) value.forEach(scan);
        else if (value && typeof value === "object") scan(value);
      }
    };
    scan(ast);
  }
  return rows;
}
