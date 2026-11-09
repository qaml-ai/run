/** A reference is explicit so arbitrary prompts and metadata are never interpolated. */
export type ApplyReference = { $ref: string };
export type ApplyManifest = {
  volumes?: Record<string, Record<string, unknown>>;
  definitions?: Record<string, Record<string, unknown>>;
  agents?: Record<string, Record<string, unknown>>;
  dryRun?: boolean;
};
export type ApplyResult = {
  dryRun: boolean;
  volumes: Record<string, string>;
  definitions: Record<string, string>;
  agents: Record<string, string>;
  changes: { resource: string; action: 'create' | 'update' | 'unchanged' }[];
};
export function validateApply(input: unknown, error: (message: string) => Error): ApplyManifest {
  const fail = (message: string): never => { throw error(message); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('apply requires an object');
  const manifest = input as ApplyManifest;
  for (const field of Object.keys(manifest)) if (!['volumes', 'definitions', 'agents', 'dryRun'].includes(field)) fail(`Unknown apply field: ${field}`);
  if (manifest.dryRun !== undefined && typeof manifest.dryRun !== 'boolean') fail('dryRun must be boolean');
  let count = 0;
  for (const kind of ['volumes', 'definitions', 'agents'] as const) {
    const resources = manifest[kind];
    if (resources !== undefined && (!resources || typeof resources !== 'object' || Array.isArray(resources))) fail(`${kind} must be an object keyed by resource key`);
    for (const [key, value] of Object.entries(resources ?? {})) {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(key)) fail(`Invalid resource key: ${key}`);
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${kind}.${key} must be an object`);
      if (kind === 'agents' && ['prompt', 'importMessages', 'initialMessages'].some(field => field in value)) fail('apply provisions agents without initial messages or prompts');
      if (kind === 'definitions' && (value.applyOnUpdate || value.apply)) fail('applyOnUpdate is not supported in an atomic apply');
      count++;
    }
  }
  if (count > 100) fail('apply accepts at most 100 resources');
  return manifest;
}
export async function applyResources(manifest: ApplyManifest, ops: {
  error(message: string): Error;
  save(kind: 'volumes' | 'definitions' | 'agents', key: string, input: Record<string, unknown>): Promise<{ id: string; action: 'create' | 'update' | 'unchanged' }>;
}): Promise<ApplyResult> {
  const fail = (message: string): never => { throw ops.error(message); };
  const result: ApplyResult = { dryRun: manifest.dryRun ?? false, volumes: {}, definitions: {}, agents: {}, changes: [] };
  const resolve = (value: unknown): any => {
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if ('$ref' in record) {
        if (Object.keys(record).length !== 1 || typeof record.$ref !== 'string') fail('A reference must be {"$ref":"volumes.key"} or {"$ref":"definitions.key"}');
        const [kind, key, extra] = (record.$ref as string).split('.');
        if (extra || !['volumes', 'definitions'].includes(kind)) fail(`Invalid reference: ${record.$ref}`);
        const ids = (result as any)[kind];
        const id = Object.hasOwn(ids, key) ? ids[key] : undefined;
        if (!id) fail(`Unknown or forward reference: ${record.$ref}`);
        return id;
      }
      return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, key === 'metadata' ? item : resolve(item)]));
    }
    return value;
  };
  for (const kind of ['volumes', 'definitions', 'agents'] as const) for (const [key, value] of Object.entries(manifest[kind] ?? {})) {
    const saved = await ops.save(kind, key, resolve(value));
    Object.defineProperty(result[kind], key, { value: saved.id, enumerable: true });
    result.changes.push({ resource: `${kind}.${key}`, action: saved.action });
  }
  return result;
}
