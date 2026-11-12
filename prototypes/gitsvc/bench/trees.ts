// The generated trees of proto/artifacts-volumes `bench/bench.ts`, byte for byte (same seeds, same paths), so the two
// prototypes' numbers compare.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const SIZES: Record<string, { files: number; bytesPerFile: number }> = {
  small: { files: 200, bytesPerFile: 5_000 },        // ~1 MB
  medium: { files: 5_000, bytesPerFile: 10_000 },    // ~50 MB
  large: { files: 50_000, bytesPerFile: 10_000 },    // ~500 MB
};

const WORDS = "const let function return import export async await class interface type string number boolean void null undefined if else for while switch case break continue throw try catch finally new this super extends implements public private static readonly".split(" ");
export function content(seed: number, bytes: number) {
  let x = seed * 2654435761 >>> 0;
  const next = () => (x = (x * 1664525 + 1013904223) >>> 0);
  let out = `// file ${seed}\n`;
  while (out.length < bytes) {
    const line: string[] = [];
    for (let n = 2 + next() % 9; n > 0; n--) line.push(WORDS[next() % WORDS.length]);
    out += `${"  ".repeat(next() % 4)}${line.join(" ")}${next() % 3 ? ";" : " {"}\n`;
  }
  return out;
}
export const pathOf = (i: number) => `src/m${Math.floor(i / 2500)}/d${Math.floor(i / 50)}/f${i}.ts`;

export async function generate(dir: string, files: number, bytesPerFile: number) {
  const dirs = new Set<string>();
  for (let i = 0; i < files; i++) dirs.add(join(dir, pathOf(i), ".."));
  await Promise.all([...dirs].map((d) => mkdir(d, { recursive: true })));
  let pending: Promise<void>[] = [];
  for (let i = 0; i < files; i++) {
    pending.push(writeFile(join(dir, pathOf(i)), content(i, bytesPerFile)));
    if (pending.length === 256) { await Promise.all(pending); pending = []; }
  }
  await Promise.all(pending);
}
