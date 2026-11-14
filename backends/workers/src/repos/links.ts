import { FileLinks, declaredType } from '../file-policy.ts';
import { RepoError, check, normalizeRepoPath, type Mode } from './repo-policy.ts';
import { repoContext, type RepoContext, type RepoEnv } from './registry.ts';
import { requireCamelfs } from '../camelfs/repo-storage.ts';
import { commitChanges } from './write.ts';
import { json, repoFailure, boundedBody, streamFile, fileEntry } from './routes.ts';
type Grant = {
  kind: 'repo';
  tenant: string;
  repo: string;
  ref: string;
  version?: string;
  path: string;
  method: 'GET' | 'PUT';
  expiresAt: number;
  maxBytes?: number;
  contentType?: string;
  agent?: string;
  run?: string;
  call?: string;
};
function signer(env: RepoEnv, base: string) {
  if (!env.FILE_SIGNING_SECRET || env.FILE_SIGNING_SECRET.length < 32)
    throw new RepoError('signing_unavailable', 503, 'signing_unavailable');
  return new FileLinks(env.FILE_SIGNING_SECRET + ':repo', env.AGENT_PUBLIC_URL || env.PUBLIC_BASE_URL || base);
}
export async function signRepoLink(ctx: RepoContext, base: string, input: {
  path: string;
  method?: 'GET' | 'PUT';
  ref?: string;
  version?: string;
  expiresIn?: number;
  maxBytes?: number;
  contentType?: string;
  agent?: string; run?: string; call?: string;
}) {
  const method = input.method ?? 'GET', seconds = input.expiresIn ?? 900;
  check(method === 'GET' || method === 'PUT');
  check(Number.isInteger(seconds) && seconds >= 1 && seconds <= 3600, 'bad_expiry');
  check(input.maxBytes === undefined || (Number.isSafeInteger(input.maxBytes) && input.maxBytes >= 0 && input.maxBytes <= 256 * 2 ** 20), 'bad_size');
  check(input.contentType === undefined || declaredType(input.contentType), 'bad_content_type');
  check(method !== 'PUT' || input.version === undefined, 'bad_version');
  const path = normalizeRepoPath(input.path), ref = input.ref ?? 'main';
  if (method === 'GET') {
    const v = await ctx.repo.resolve(input.version ?? ref);
    await fileEntry(ctx, v, path);
  }
  const grant = { kind: 'repo' as const, tenant: ctx.tenant, repo: ctx.repoId, ref, version: input.version, path, method, maxBytes: input.maxBytes, contentType: input.contentType, agent: input.agent, run: input.run, call: input.call };
  // A separate HMAC domain prevents either link family accepting the other's token.
  const signed = signer(ctx.env, base).sign({ ...grant, expiresIn: seconds });
  return { url: signed.url.replace('/v1/links/', '/v1/repo-links/'), expiresAt: signed.expiresAt };
}
export async function handleSignedRepoRequest(request: Request, env: RepoEnv): Promise<Response | null> {
  const url = new URL(request.url), m = /^\/v1\/repo-links\/([^/]+)\/[^/]+$/.exec(url.pathname);
  if (!m)
    return null;
  try {
    requireCamelfs(env);
    const grant = signer(env, url.origin).verify(m[1]) as unknown as Grant;
    if (grant.kind !== 'repo' || !grant.tenant || !/^repo_[a-f0-9]{24}$/.test(grant.repo) || normalizeRepoPath(grant.path) !== grant.path)
      throw new RepoError('invalid_link', 403, 'invalid_link');
    if (request.method !== grant.method)
      throw new RepoError('method_not_allowed', 405, 'method_not_allowed');
    const ctx = await repoContext(env, grant.tenant, grant.repo);
    if (grant.method === 'GET') {
      const v = await ctx.repo.resolve(grant.version ?? grant.ref);
      return await streamFile(request, ctx, v, await fileEntry(ctx, v, grant.path));
    }
    if (grant.contentType && declaredType(request.headers.get('content-type')) !== grant.contentType)
      throw new RepoError('content_type', 415, 'content_type');
    const result = await commitChanges(ctx, { ref: grant.ref, op: grant.agent ? 'turn' : 'api', changes: { [grant.path]: { bytes: await boundedBody(request, Math.min(grant.maxBytes ?? 256 * 2 ** 20, 256 * 2 ** 20)), mode: (request.headers.get('x-mode') ?? undefined) as Mode | undefined } }, message: `put ${grant.path.slice(0, 1000)}`, author: grant.agent ? `agent:${grant.agent}` : `link:${grant.repo}`, trailers: grant.agent ? { 'Camel-Agent': grant.agent, 'Camel-Checkpoint': 'automatic', ...(grant.run ? { 'Camel-Run': grant.run } : {}), ...(grant.call ? { 'Camel-Call': grant.call } : {}) } : { 'Camel-Checkpoint': 'api' } });
    return json({ version: result.version, path: grant.path, ...result.files[grant.path] }, 201);
  }
  catch (e) {
    return repoFailure(e);
  }
}
