export type RepoAt = { repo: string; ref?: string; version?: string };
export function repoAt(value: unknown): RepoAt {
  const v = typeof value === 'string' ? { repo: value } : value as RepoAt;
  const bad = (message: string): never => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.repo !== 'string' || !v.repo.trim()) return bad('repo needs a non-empty repo id');
  if (Object.keys(v).some(k => !['repo', 'ref', 'version'].includes(k))) return bad('repo takes repo, ref or version');
  if (v.ref !== undefined && v.version !== undefined) return bad('Give ref or version, not both');
  if (v.ref !== undefined && (typeof v.ref !== 'string' || !v.ref)) return bad('ref is a non-empty string');
  if (v.version !== undefined && (typeof v.version !== 'string' || !/^[a-fA-F0-9]{40}$/.test(v.version))) return bad('version is 40 hex characters');
  return v;
}
