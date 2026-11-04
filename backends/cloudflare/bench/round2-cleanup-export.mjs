// Run only after the final account audit and registry listing are complete.
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const final = await read('bench/.state/round2-final.json');
const images = await read('bench/.state/round2-images-list.json');
const snapshots = await read('docs/round2-snapshots.json');
const known = await read('bench/.state/round2-known-telemetry.json');
const ownedPrefix = 'camelrun-proto-r2-';
const owned = row => [row.id, row.name, row.title, row.script, row.class]
  .some(value => typeof value === 'string' && value.startsWith(ownedPrefix));
const ownedFinalResources = Object.fromEntries(Object.entries(final.resources).map(([kind, row]) =>
  [kind, { complete: row.complete, items: row.items.filter(owned) }]));
const excludedConcurrentResources = Object.fromEntries(Object.entries(final.resources).map(([kind, row]) =>
  [kind, row.items.filter(item => !owned(item))]));
if (Object.values(ownedFinalResources).some(row => !row.complete || row.items.length)) throw new Error('Round-two inventory is not empty');
const expectedTags = new Set(snapshots.snapshots.flatMap(row => row.tags.map(tag => `${row.repository}:${tag}`)));
const ownedImages = images.items.filter(row => row.name.startsWith(ownedPrefix));
const actualTags = ownedImages.flatMap(row => row.tags.map(tag => `${row.name}:${tag}`));
if (actualTags.length !== expectedTags.size || actualTags.some(tag => !expectedTags.has(tag))) throw new Error('Unexpected retained registry artifact');
const workers = [...new Set(known.namespaces.map(row => row.script))];
if (workers.some(name => !name.startsWith(ownedPrefix))) throw new Error('Worker outside round-two scope');
const endpoints = await Promise.all(workers.map(async worker => {
  const url = `https://${worker}.miguel-85b.workers.dev/`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (response.status !== 404) throw new Error(`Deleted Worker ${worker} returned ${response.status}`);
  return { worker, url, status: response.status };
}));
const normalImages = [await read('bench/.state/round2-native-image-delete.json'), await read('bench/.state/round2-images-delete.json')]
  .flatMap(row => row.items);
const report = {
  verifiedAt: new Date().toISOString(),
  baseline: await read('bench/.state/round2-baseline.json'),
  afterContainerCleanup: await read('bench/.state/round2-after-containers.json'),
  final, ownedPrefix, ownedFinalResources, excludedConcurrentResources,
  excludedConcurrentRegistryArtifacts: images.items.filter(row => !row.name.startsWith(ownedPrefix)),
  deletedWorkers: workers, deletedNamespaces: known.namespaces,
  deletedContainerApps: (await read('bench/.state/round2-apps-delete.json')).items,
  deletedR2Bucket: await read('bench/.state/round2-bucket-delete.json'),
  deletedNormalImages: normalImages, retainedSnapshotArtifacts: ownedImages,
  retainedSnapshots: snapshots.snapshots, endpoints, localBearerRemoved: false,
  notes: [
    'Only resources with the authorized camelrun-proto- prefix were mutated.',
    'This run created only camelrun-proto-r2-* resources. Concurrent camelrun-proto-bench-* resources appeared after the baseline and were left untouched.',
    'Four registry aliases and their referenced layers remain as the two permitted native snapshots.',
    'No account-wide registry garbage collection was requested.',
    'Snapshot expiry is estimated from documented retention; expiry has not been observed.',
  ],
};
async function save() {
  const temporary = `docs/.round2-cleanup.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(report, null, 2) + '\n');
  await rename(temporary, 'docs/round2-cleanup.json');
}
// Preserve all validated evidence before removing the local credential. Both
// the removal and the final write can be safely retried after interruption.
await save();
try { await unlink('bench/.state/api-token'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
report.localBearerRemoved = true;
await save();
console.log(JSON.stringify({ verifiedAt: report.verifiedAt, workersDeleted: workers.length,
  namespacesDeleted: known.namespaces.length, normalImagesDeleted: normalImages.length,
  snapshotsRetained: snapshots.snapshots.length, localBearerRemoved: true }));
