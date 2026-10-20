import { fileURLToPath } from "node:url";
export function modeMatrix(count: number, full = false) {
  if (![5, 12].includes(count)) throw new Error("Expected 5 or 12 shards");
  return { include: ["inline", "process"].flatMap(hosting => {
    const shards = hosting === "process" && count === 5 && !full ? 4 : count;
    return Array.from({ length: shards }, (_, index) => ({ hosting, shard: index + 1, count: shards, scope: hosting === "process" && !full ? "sensitive" : "full" }));
  }) };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(modeMatrix(Number(process.argv[2]), process.argv.includes("--full"))));
