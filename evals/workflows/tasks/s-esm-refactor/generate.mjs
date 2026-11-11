// Generates s-esm-refactor's fixed input (50 CommonJS modules on a legacy formatter) and its hidden expected
// outputs, computed by running the originals. Deterministic: rerunning it rewrites the same bytes. The committed
// output is what the eval uses; regenerate only to change the task, and bump the task's version when you do.
//
//   node evals/workflows/tasks/s-esm-refactor/generate.mjs
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const input = join(here, "input"), hidden = join(here, "hidden"), reference = join(here, "reference");
rmSync(input, { recursive: true, force: true });
rmSync(reference, { recursive: true, force: true });
mkdirSync(join(reference, "lib"), { recursive: true });
mkdirSync(join(input, "lib"), { recursive: true });
mkdirSync(join(input, "util"), { recursive: true });
mkdirSync(hidden, { recursive: true });

// A tiny seeded PRNG so the modules vary without changing between runs.
let seed = 20261111;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (list) => list[Math.floor(rand() * list.length)];
const pad = (n) => String(n).padStart(2, "0");

writeFileSync(join(input, "package.json"), JSON.stringify({ name: "ledger-labels", version: "3.2.0", private: true, license: "MIT", main: "lib/index.js" }, null, 2) + "\n");
writeFileSync(join(input, "util", "legacy-format.js"), `'use strict';
// The printf-style formatter every module still uses. %s is String(value), %d truncates toward zero after
// Number(value) (so "7.9" is 7, -1.5 is -1, and NaN prints "NaN"), %j is JSON.stringify, %% is a literal %.
// Extra arguments are ignored; a missing one prints "undefined" (%s), "NaN" (%d) or "undefined" (%j).
function legacyFormat(template, ...args) {
  let next = 0;
  return template.replace(/%([sdj%])/g, (_match, type) => {
    if (type === '%') return '%';
    const value = args[next++];
    if (type === 's') return String(value);
    if (type === 'd') return String(Math.trunc(Number(value)));
    return JSON.stringify(value);
  });
}
module.exports = { legacyFormat };
`);

const nouns = ["widget", "invoice", "parcel", "ticket", "voucher", "crate", "bundle", "permit", "coupon", "pallet"];
/** One formatter call, as the CommonJS original writes it and as the reference ES module writes it. */
function format(call, template, args) {
  let next = 0;
  const literal = template.replace(/`/g, "\\`").replace(/\$\{/g, "\\${").replace(/%([sdj%])/g, (_match, type) => {
    if (type === "%") return "%";
    const value = args[next++];
    return type === "s" ? `\${String(${value})}` : type === "d" ? `\${Math.trunc(Number(${value}))}` : `\${JSON.stringify(${value})}`;
  });
  return { cjs: `${call}('${template}', ${args.join(", ")})`, esm: `\`${literal}\`` };
}
const modules = [];
for (let index = 1; index <= 50; index++) {
  const id = pad(index), noun = pick(nouns), rate = 2 + Math.floor(rand() * 18);
  const shape = index % 5; // five export shapes
  const dependency = index > 10 && index % 7 === 0 ? pad(index - 7) : null;
  const call = shape === 1 ? "fmt" : "legacyFormat";
  const functions = [];
  functions.push({ name: `total${id}`, params: "qty", body: { cjs: `qty * RATE_${id}`, esm: `qty * RATE_${id}` }, args: [[3], [2.5], [-4]] });
  functions.push({ name: `describe${id}`, params: "name, qty", body: format(call, "%s x%d @ %d = %d", ["name", "qty", `RATE_${id}`, `total${id}(qty)`]), args: [[noun, 3], [noun, 2.7], ["n/a", -1.5], [noun, "4"]] });
  if (index % 3 === 0) functions.push({ name: `percent${id}`, params: "part, whole", body: format(call, "%d%% of %s (%j)", ["part / whole * 100", `'${noun}s'`, "{ part: part, whole: whole }"]), args: [[1, 3], [2, 2], [0, 5]] });
  if (dependency) functions.push({ name: `combined${id}`, params: "qty", body: format(call, `combined=%d (with m${dependency}: %d)`, [`total${id}(qty) + total${dependency}(qty)`, `total${dependency}(qty)`]), args: [[1], [1.5]] });
  const main = shape === 2 ? functions[1] : null;
  const fn = (entry, kind) => `function ${entry.name}(${entry.params}) {\n  return ${entry.body[kind]};\n}\n`;
  // The CommonJS original.
  let cjs = "'use strict';\n";
  if (dependency) cjs += `const { total${dependency} } = require('./m${dependency}');\n`;
  cjs += shape === 1 ? "const legacy = require('../util/legacy-format');\nconst fmt = legacy.legacyFormat;\n" : "const { legacyFormat } = require('../util/legacy-format');\n";
  cjs += `\nconst RATE_${id} = ${rate};\n` + functions.map((entry) => "\n" + fn(entry, "cjs")).join("");
  if (main) cjs += `\nmodule.exports = ${main.name};\n` + functions.filter((entry) => entry !== main).map((entry) => `module.exports.${entry.name} = ${entry.name};\n`).join("");
  else if (shape === 3) cjs += "\n" + functions.map((entry) => `exports.${entry.name} = ${entry.name};\n`).join("");
  else cjs += `\nmodule.exports = { ${functions.map((entry) => entry.name).join(", ")} };\n`;
  // The reference ES module (never shown to the agent).
  let esm = dependency ? `import { total${dependency} } from "./m${dependency}.js";\n\n` : "";
  esm += `const RATE_${id} = ${rate};\n` + functions.map((entry) => "\n" + (entry === main ? "export default " : "export ") + fn(entry, "esm")).join("");
  writeFileSync(join(input, "lib", `m${id}.js`), cjs);
  writeFileSync(join(reference, "lib", `m${id}.js`), esm);
  modules.push({ file: `lib/m${id}.js`, exported: functions.map((entry) => ({ name: entry.name, default: entry === main, args: entry.args })) });
}
writeFileSync(join(input, "lib", "index.js"), `'use strict';\nmodule.exports = {\n${modules.map(({ file }) => `  ${file.slice(4, -3)}: require('./${file.slice(4, -3)}'),`).join("\n")}\n};\n`);
writeFileSync(join(reference, "lib", "index.js"), modules.map(({ file }) => `export * as ${file.slice(4, -3)} from "./${file.slice(4)}";\n`).join(""));
writeFileSync(join(reference, "package.json"), JSON.stringify({ name: "ledger-labels", version: "3.2.0", private: true, license: "MIT", type: "module", main: "lib/index.js" }, null, 2) + "\n");

writeFileSync(join(input, "MIGRATION.md"), `# Migrating ledger-labels to ES modules

The package is CommonJS on a printf-style formatter (\`util/legacy-format.js\`). Move it to native ES modules and
drop the formatter.

1. \`package.json\` gets \`"type": "module"\`. Every file under \`lib/\` becomes an ES module: \`import\`/\`export\`, no
   \`require\`, no \`module.exports\`/\`exports.\`, no \`'use strict'\`. Relative imports name the file with its \`.js\`
   extension.
2. Every export keeps its name. A module that exported a single function (\`module.exports = fn\`) exports it as
   \`export default\` and keeps its extra properties as named exports. \`lib/index.js\` re-exports each module as a
   namespace under the same key (\`export * as m01 from "./m01.js"\`).
3. Replace every \`legacyFormat\` call with a template literal that prints exactly the same text, then delete
   \`util/legacy-format.js\`. Mind the formatter's rules (its header comment): \`%d\` truncates toward zero after
   \`Number()\`, \`%j\` is \`JSON.stringify\`, \`%%\` is \`%\`.
4. Behaviour must not change: every exported function returns exactly what it returned before, for any input.
`);

// Expected outputs, from the originals.
const require = createRequire(import.meta.url);
const expected = [];
for (const { file, exported } of modules) {
  const loaded = require(join(input, file));
  for (const entry of exported) {
    const fn = entry.default ? loaded : loaded[entry.name];
    for (const args of entry.args) expected.push({ file, export: entry.default ? "default" : entry.name, args, result: fn(...args) });
  }
}
writeFileSync(join(hidden, "expected.json"), JSON.stringify(expected, null, 1) + "\n");
console.log(`${modules.length} modules, ${expected.length} expected calls`);
