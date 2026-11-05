import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
// #638 is already on main while this experimental branch can lag it.
const ref = process.env.FS_SHIM_REF ?? "origin/main";
const source = execFileSync("git", ["show", `${ref}:sandbox/v8-exec/src/pi-glue.js`], { encoding: "utf8" });
const start = source.indexOf("  const fileTool ="), end = source.indexOf("  const shim =", start);
if (start < 0 || end < 0) throw new Error("fs shim extraction boundary changed");
const prefix = `(() => {\nconst stringify = JSON.stringify;\nconst FILES = "files are the agent's read, write and ls tools";\nconst scriptTools = tools;\n${source.slice(start, end)}\nObject.defineProperty(globalThis, "fs", { value: fs });\nObject.defineProperty(globalThis, "require", { value: name => { if (["fs", "node:fs", "fs/promises", "node:fs/promises"].includes(name)) return fs; throw new ReferenceError("Only the fs shim is available in codemode"); } });\n})();\n`;
const text = `// Generated from sandbox/v8-exec/src/pi-glue.js (#638), using scripts/reuse-fs-shim.mjs.\n// File shim only; Pi supplies all execution, replay, output and discovery behavior.\nexport const FS_SHIM = ${JSON.stringify(prefix)};\n`;
const destination = new URL("../codemode/fs-shim.ts", import.meta.url);
if (process.argv.includes("--check")) {
  if (await readFile(destination, "utf8") !== text) throw new Error("fs shim differs from source; regenerate");
} else await writeFile(destination, text);
console.log("Codemode fs shim matches the source runtime");
