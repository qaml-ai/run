#!/usr/bin/env -S node --experimental-strip-types
// Read-only pilot checks. Requires an existing limited-network Container agent and GitHub App grant.
// CAMELAI_API_KEY=... node --experimental-strip-types scripts/verify-egress.mjs --pilot https://pilot.example.com --agent ag_... --repo https://github.com/owner/repo.git --blocked-host example.com
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { networkAllows } from '../src/core/vault.ts';
const { values } = parseArgs({ options: { pilot: {type:'string'}, agent: {type:'string'}, repo: {type:'string'}, 'blocked-host': {type:'string'} } });
const base = new URL(values.pilot ?? '');
assert(base.protocol === 'https:' && !base.username && !base.password && base.pathname === '/' && !base.search && !base.hash, 'Use an HTTPS pilot origin');
assert(!['run.camelai.com','api.run.camelai.com'].includes(base.hostname), 'Production is refused; use a deployed pilot');
assert(values.agent && /^[a-zA-Z0-9_-]+$/.test(values.agent), 'An existing pilot agent is required');
const repo = new URL(values.repo ?? '');
assert(repo.protocol === 'https:' && repo.hostname === 'github.com' && !repo.username && !repo.password && !repo.search && !repo.hash && /^\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(repo.pathname), 'Use a GitHub HTTPS repository URL');
const blocked = new URL(`https://${values['blocked-host'] ?? 'example.com'}/`);
assert(!blocked.username && !blocked.password && !blocked.port && blocked.pathname === '/' && !blocked.search && !blocked.hash, 'Use only a blocked hostname');
assert(process.env.CAMELAI_API_KEY, 'Set CAMELAI_API_KEY for the pilot');
// A public repository cannot prove that the gateway supplied the App credential.
const anonymous = await fetch(new URL(`${repo.pathname}/info/refs?service=git-upload-pack`, repo.origin), {redirect:'manual',signal:AbortSignal.timeout(30_000)});
await anonymous.body?.cancel();
assert([401,403,404].includes(anonymous.status), 'Use a private repository to verify GitHub App authentication');
const api = async (path, body) => {
  const r = await fetch(new URL(path,base), {method:body?'POST':'GET',headers:{authorization:`Bearer ${process.env.CAMELAI_API_KEY}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(180_000),redirect:'error'});
  assert(r.ok, `Pilot API returned HTTP ${r.status}`);
  return r.json();
};
const agent = await api(`/v1/agents/${values.agent}/configuration`);
const config = agent.configuration ?? agent.config ?? agent;
assert(config.networking?.type === 'limited', 'The pilot agent must already use limited networking');
assert(networkAllows(config.networking,repo,[]), 'GitHub must already be allowed');
assert(!networkAllows(config.networking,blocked,[]), 'The blocked host is allowed by this agent');
assert(config.computer?.egress?.some(g=>g.host==='github.com' && g.auth?.type==='github-app'), 'The pilot agent must already have a GitHub App grant');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const started = performance.now();
const result = await api(`/experimental/agents/${values.agent}/computer`, {provider:'container',op:'exec',argv:['bash','-lc',`git ls-remote ${quote(repo.href)} HEAD >/dev/null && test "$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' ${quote(blocked.href)})" = 403`],timeoutMs:120_000});
assert(result.exitCode === 0, 'GitHub authentication or blocked-host check failed (inspect pilot logs)');
console.log(JSON.stringify({githubApp:true,limitedNetworking:true,seconds:(performance.now()-started)/1000}));
