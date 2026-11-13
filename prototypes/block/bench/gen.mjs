// The shared bench trees (prototypes/artifacts-volumes/bench/README.md): same generator, same sizes, same bytes.
//   node gen.mjs <dir> <small|medium|large>        generate the tree
//   node gen.mjs <dir> <size> change               rewrite f0,f1,f2 with seed i+100000 (the "small change")
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SIZES = { small: { files: 200, bytesPerFile: 5_000 }, medium: { files: 5_000, bytesPerFile: 10_000 }, large: { files: 50_000, bytesPerFile: 10_000 } };
const WORDS = "const let function return import export async await class interface type string number boolean void null undefined if else for while switch case break continue throw try catch finally new this super extends implements public private static readonly".split(" ");
function content(seed, bytes) {
  let x = seed * 2654435761 >>> 0;
  const next = () => (x = (x * 1664525 + 1013904223) >>> 0);
  let out = `// file ${seed}\n`;
  while (out.length < bytes) {
    const line = [];
    for (let n = 2 + next() % 9; n > 0; n--) line.push(WORDS[next() % WORDS.length]);
    out += `${"  ".repeat(next() % 4)}${line.join(" ")}${next() % 3 ? ";" : " {"}\n`;
  }
  return out;
}
const pathOf = (i) => `src/m${Math.floor(i / 2500)}/d${Math.floor(i / 50)}/f${i}.ts`;

const [dir, size, mode] = process.argv.slice(2);
const { files, bytesPerFile } = SIZES[size];
if (mode === "change") {
  for (const i of [0, 1, 2]) await writeFile(join(dir, pathOf(i)), content(i + 100_000, bytesPerFile));
} else {
  const dirs = new Set();
  for (let i = 0; i < files; i++) dirs.add(join(dir, pathOf(i), ".."));
  await Promise.all([...dirs].map((d) => mkdir(d, { recursive: true })));
  let pending = [];
  for (let i = 0; i < files; i++) {
    pending.push(writeFile(join(dir, pathOf(i)), content(i, bytesPerFile)));
    if (pending.length === 256) { await Promise.all(pending); pending = []; }
  }
  await Promise.all(pending);
}
