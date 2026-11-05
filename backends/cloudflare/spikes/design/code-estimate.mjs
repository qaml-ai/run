// Verify the study's source denominator and reproduce its arithmetic. No mutation.
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const estimate = JSON.parse(await readFile(new URL('./code-estimate.json', import.meta.url), 'utf8'));
const lines = text => text.split('\n').length - Number(text.endsWith('\n'));
for (const row of estimate.retired) {
  assert.equal(lines(await readFile(path.join(root, row.path), 'utf8')), row.lines, row.path);
  assert(row.removeLow >= 0 && row.removeLow <= row.removeHigh && row.removeHigh <= row.lines, row.path);
}
async function tsLines(directory) {
  let sum = 0;
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, item.name);
    if (item.isDirectory()) sum += await tsLines(name);
    else if (item.name.endsWith('.ts')) sum += lines(await readFile(name, 'utf8'));
  }
  return sum;
}
const prototype = await tsLines(path.join(root, 'backends/cloudflare/src')) + await tsLines(path.join(root, 'backends/cloudflare/codemode'));
const removedLow = estimate.retired.reduce((sum, row) => sum + row.removeLow, 0);
const removedHigh = estimate.retired.reduce((sum, row) => sum + row.removeHigh, 0);
const addedLow = prototype + estimate.newBeyondPrototype.reduce((sum, row) => sum + row.low, 0);
const addedHigh = prototype + estimate.newBeyondPrototype.reduce((sum, row) => sum + row.high, 0);
console.log(JSON.stringify({ sourceCommit: estimate.sourceCommit, selectedSourceLines: estimate.retired.reduce((sum, row) => sum + row.lines, 0), prototypeLines: prototype, removed: [removedLow, removedHigh], addedIncludingPrototype: [addedLow, addedHigh], netChange: [addedLow - removedHigh, addedHigh - removedLow], units: estimate.units }, null, 2));
