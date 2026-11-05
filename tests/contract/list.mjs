import { readdir } from "node:fs/promises";
process.env.CONTRACT_LIST = "1";
for (const file of (await readdir(new URL("./areas/", import.meta.url))).filter(file => file.endsWith(".test.ts")).sort()) {
  process.env.CONTRACT_FILE = `tests/contract/areas/${file}`;
  await import(new URL(`./areas/${file}`, import.meta.url));
}
