// Keep the latest nonempty observation per resource before deletion makes a
// historical query empty. Do not sum overlapping samples or replace newer data.
import { readFile, writeFile } from 'node:fs/promises';
const files = process.argv.slice(2), output = files.pop();
if (!output || !files.length) throw new Error('Expected INPUT... OUTPUT');
const inputs = await Promise.all(files.map(async file => ({ file, data: JSON.parse(await readFile(file, 'utf8')) })));
inputs.sort((a, b) => Date.parse(a.data.until) - Date.parse(b.data.until));
const saved = new Map();
for (const { file, data } of inputs) for (const row of data.results) {
  const resource = row.script ?? row.namespace?.id;
  if (!resource) continue;
  const key = `${row.kind}:${resource}`;
  const sourceWindow = row.sourceWindow ?? {
    since: data.since, until: data.until, generatedAt: data.generatedAt ?? data.at,
  };
  if (!Number.isFinite(Date.parse(sourceWindow.until))) throw new Error(`Invalid observation window for ${key}`);
  const candidate = { ...row, sourceFile: row.sourceFile ?? file, sourceWindow };
  const previous = saved.get(key);
  if (previous) {
    if (!candidate.rows.length && previous.rows.length) continue;
    const newer = Date.parse(candidate.sourceWindow.until) - Date.parse(previous.sourceWindow.until)
      || (Date.parse(candidate.sourceWindow.generatedAt) || 0) - (Date.parse(previous.sourceWindow.generatedAt) || 0);
    if (!!candidate.rows.length === !!previous.rows.length && newer < 0) continue;
  }
  saved.set(key, candidate);
}
const latest = inputs.at(-1).data;
const result = { ...latest, generatedAt: new Date().toISOString(),
  preservation: 'Latest nonempty result per resource; inspect each sourceWindow. Empty refreshes after deletion are not zero usage.',
  results: [...saved.values()] };
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ output, preservedResults: saved.size }));
