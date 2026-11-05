import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const report = JSON.parse(readFileSync(resolve(root, 'backends/cloudflare/docs/hybrid-table-map.json'), 'utf8'));
const creates = new Map();
const drops = new Map();
for (const name of readdirSync(resolve(root, 'migrations')).filter(name => name.endsWith('.sql')).sort()) {
  const text = readFileSync(resolve(root, 'migrations', name), 'utf8').replace(/\/\*[\s\S]*?\*\/|--[^\n]*/g, '');
  for (const [, table] of text.matchAll(/create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/gi)) creates.set(table, `migrations/${name}`);
  for (const [, table] of text.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?([a-z_][a-z0-9_]*)/gi)) drops.set(table, `migrations/${name}`);
}
const mapped = new Map(report.tables.map(row => [row.name, row]));
const fail = message => { throw new Error(message); };
if (mapped.size !== report.tables.length) fail('Duplicate table map entry');
for (const [name, createdIn] of creates) {
  const row = mapped.get(name);
  if (!row) fail(`Missing table: ${name}`);
  if (row.createdIn !== createdIn) fail(`Wrong migration for ${name}`);
  if (!['Agent DO', 'Postgres', 'Delete'].includes(row.destination) || !row.reason) fail(`Incomplete classification: ${name}`);
  if (row.status !== (drops.has(name) ? 'already dropped' : 'live')) fail(`Wrong live status: ${name}`);
  if ((row.droppedIn ?? null) !== (drops.get(name) ?? null)) fail(`Wrong dropped migration: ${name}`);
  const source = readFileSync(resolve(root, row.source), 'utf8').split('\n');
  if (!new RegExp(`\\b${name}\\b`).test(source[row.sourceLine - 1] ?? '')) fail(`Stale source evidence: ${name}`);
}
for (const name of mapped.keys()) if (!creates.has(name)) fail(`Unknown table: ${name}`);
let localCatalogMatched = false;
if (process.argv[2]) {
  const catalog = JSON.parse(readFileSync(resolve(process.argv[2]), 'utf8'));
  const expected = [...creates.keys()].filter(name => !drops.has(name)).sort();
  const actual = catalog.liveTables.filter(name => name !== 'schema_migrations').sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('Local migrated PostgreSQL catalog differs from table map');
  if (catalog.failed) fail('Local PostgreSQL measurement reported a failure');
  localCatalogMatched = true;
}
const counts = Object.fromEntries(['Agent DO', 'Postgres', 'Delete'].map(kind => [kind, report.tables.filter(row => row.destination === kind).length]));
console.log(JSON.stringify({ passed: true, createdTables: creates.size, alreadyDropped: drops.size, liveTables: creates.size - drops.size, counts, localCatalogMatched }, null, 2));
