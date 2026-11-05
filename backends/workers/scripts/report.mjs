import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const base = fileURLToPath(new URL("../", import.meta.url));
const table = execFileSync(process.execPath, ["scripts/measure.mjs"], {
  cwd: base,
  encoding: "utf8",
}).trim();
const { rows } = JSON.parse(
  await readFile(
    new URL("../measurements/compatibility.json", import.meta.url),
    "utf8",
  ),
);
const count = (matches) => rows.filter(matches).length;
const score = [
  `The final inventory has **${rows.length} cases: ${count((r) => r.status === "pass")} pass, ${count((r) => r.status === "fail")} fail, ${count((r) => r.status === "not-applicable")} not applicable**. Of the passes, **${count((r) => r.status === "pass" && r.kind === "worker")} reach workerd** and **${count((r) => r.status === "pass" && r.kind === "sdk-unit")} are SDK-only unit checks**.`,
  "",
  "| Original test file | Worker pass | SDK-only pass | Fail | N/A |",
  "| --- | ---: | ---: | ---: | ---: |",
];
for (const file of [...new Set(rows.map((r) => r.file))].sort()) {
  const subset = rows.filter((r) => r.file === file),
    n = (f) => subset.filter(f).length;
  score.push(
    `| \`${file}\` | ${n((r) => r.status === "pass" && r.kind === "worker")} | ${n((r) => r.status === "pass" && r.kind === "sdk-unit")} | ${n((r) => r.status === "fail")} | ${n((r) => r.status === "not-applicable")} |`,
  );
}
let text = await readFile(new URL("../ELEGANCE.md", import.meta.url), "utf8");
for (const [key, value] of [
  ["SIZE_TABLE", table],
  ["SCORECARD", score.join("\n")],
]) {
  const block = `<!-- ${key} -->\n${value}\n<!-- /${key} -->`;
  const regex = new RegExp(`<!-- ${key} -->[\\s\\S]*?<!-- /${key} -->`);
  text = regex.test(text)
    ? text.replace(regex, block)
    : text.replace(`<!-- ${key} -->`, block);
}
await writeFile(new URL("../ELEGANCE.md", import.meta.url), text);
console.log("Updated ELEGANCE from measured code and compatibility records.");
