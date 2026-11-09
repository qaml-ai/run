#!/usr/bin/env -S node --experimental-strip-types
// Pilot only. Creates/deletes two agents and scratch branches in qaml-ai/camelcode-scratch.
// The existing parent needs limited networking, agents + delegate.instructions, a GitHub App
// grant with contents:write, and an attached vault secret allowed at an HTTPS echo endpoint.
// The echo endpoint must return the injected Authorization header in its response body.
// CAMELAI_API_KEY=... node --experimental-strip-types scripts/verify-egress.mjs \
//   --pilot https://pilot.example.com --agent client_... --vault-name TEST_TOKEN \
//   --vault-url https://echo.example.com/headers --blocked-host example.com
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { networkAllows, secretName, secretPlaceholder } from '../src/core/vault.ts';

export const inlinePrompt = name => `Use spawn_agent once with name "${name}", instructions "Reply ready.", task "Reply ready.", and computer "fresh". Do not select a definition or existing agent.`;
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const repo = 'https://github.com/qaml-ai/camelcode-scratch.git';

export function auditCommand({ branch, vaultName, vaultUrl, blocked }) {
  return `set -euo pipefail
work=$(mktemp -d)
pushed=0
cleanup() {
  if [ "$pushed" = 1 ]; then git -C "$work/repo" push origin --delete ${quote(branch)} >/dev/null 2>&1; fi
  rm -rf "$work"
}
trap cleanup EXIT
# Only the placeholder enters the shell; the gateway injects the real value.
test "\${${vaultName}}" = ${quote(secretPlaceholder(vaultName))}
test "$(curl -sS --max-time 30 -o "$work/blocked" -w '%{http_code}' ${quote(blocked)})" = 403
curl -fsS --max-time 30 -H "Authorization: Bearer \${${vaultName}}" ${quote(vaultUrl)} >"$work/echo"
grep -Fq '[hidden]' "$work/echo"
! grep -Fq 'camel-vault-' "$work/echo"
git clone --quiet ${quote(repo)} "$work/repo"
git -C "$work/repo" checkout -q -b ${quote(branch)}
git -C "$work/repo" -c user.name='camelRun pilot check' -c user.email='pilot@camelai.com' commit --quiet --allow-empty -m 'Verify pilot egress'
pushed=1
git -C "$work/repo" push --quiet origin HEAD:refs/heads/${quote(branch)}
test "$(git -C "$work/repo" rev-parse HEAD)" = "$(git -C "$work/repo" ls-remote origin refs/heads/${quote(branch)} | cut -f1)"
git -C "$work/repo" push --quiet origin --delete ${quote(branch)}
pushed=0
printf 'vault-egress-ok\\n'`;
}

export async function verifyPilot(values, { transport = fetch, key = process.env.CAMELAI_API_KEY, pause = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const base = new URL(values.pilot ?? '');
  assert(base.protocol === 'https:' && !base.username && !base.password && base.pathname === '/' && !base.search && !base.hash, 'Use an HTTPS pilot origin');
  assert(!['run.camelai.com', 'api.run.camelai.com'].includes(base.hostname), 'Production is refused; use a deployed pilot');
  assert(values.agent && /^[a-zA-Z0-9_-]+$/.test(values.agent), 'An existing pilot agent is required');
  const vaultName = secretName(values['vault-name']);
  const vaultUrl = new URL(values['vault-url']);
  assert(vaultUrl.protocol === 'https:' && !vaultUrl.username && !vaultUrl.password && !vaultUrl.hash, 'Use an HTTPS vault echo URL without credentials');
  const blocked = new URL(`https://${values['blocked-host'] ?? 'example.com'}/`);
  assert(!blocked.username && !blocked.password && !blocked.port && blocked.pathname === '/' && !blocked.search && !blocked.hash, 'Use only a blocked hostname');
  assert(key, 'Set CAMELAI_API_KEY for the pilot');
  const api = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await transport(new URL(path, base), { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(600_000), redirect: 'manual' });
    assert(response.ok, `Pilot API ${method} ${path} returned HTTP ${response.status}`);
    return response.status === 204 ? undefined : response.json();
  };
  const configuration = id => api(`/v1/agents/${id}/configuration`);
  const parent = await configuration(values.agent);
  const check = config => {
    assert(config.networking?.type === 'limited', 'Expected limited networking');
    const mcpHosts = (config.mcpServers ?? []).map(server => new URL(server.url).hostname);
    assert(networkAllows(config.networking, new URL(repo), mcpHosts), 'GitHub must be allowed');
    assert(networkAllows(config.networking, vaultUrl, mcpHosts), 'Vault echo host must be allowed');
    assert(!networkAllows(config.networking, blocked, mcpHosts), 'Blocked host must be outside the policy');
    assert(config.computer?.egress?.some(g => g.host === 'github.com' && g.auth?.type === 'github-app'), 'A GitHub App grant is required');
    assert(config.computer?.secrets?.some(s => s.name === vaultName), 'The vault secret must be attached');
  };
  check(parent);
  assert(parent.builtins?.includes('agents') && parent.delegate?.instructions, 'Parent must allow inline spawn_agent');
  const tag = `vault-egress-${randomUUID()}`, created = new Set(), results = [];
  const started = performance.now();
  const audit = async (id, role) => {
    const config = await configuration(id);
    check(config);
    assert.deepEqual(config.networking, parent.networking, `${role} changed networking`);
    assert.deepEqual(config.computer?.secrets, parent.computer?.secrets, `${role} changed vault attachments`);
    assert.deepEqual(config.computer?.egress, parent.computer?.egress, `${role} changed grants`);
    const result = await api(`/experimental/agents/${id}/computer`, { provider: 'container', op: 'exec', argv: ['bash', '-lc', auditCommand({ branch: `${tag}-${role}`, vaultName, vaultUrl: vaultUrl.href, blocked: blocked.href })], timeoutMs: 600_000 });
    assert(result.exitCode === 0 && result.stdout?.includes('vault-egress-ok'), `${role}: clone/push, vault echo, blocked host, or cleanup failed`);
    if (role === 'fork') assert(result.computer?.restoredFrom === 'fork', 'Worker did not restore the parent computer snapshot');
    results.push({ role, clonePush: true, vaultSubstitution: true, blockedHost403: true });
  };
  try {
    await audit(values.agent, 'parent');
    const fork = await api(`/v1/agents/${values.agent}/fork`, { name: `${tag}-fork`, ttlSeconds: 3600 });
    created.add(fork.id);
    await api(`/v1/agents/${values.agent}/computer/fork`, { agents: [fork.id] });
    await audit(fork.id, 'fork');
    const name = `${tag}-inline`;
    const request = await api(`/v1/agents/${values.agent}/prompt`, { text: inlinePrompt(name) });
    const deadline = Date.now() + 180_000;
    let child;
    do {
      child = (await api(`/v1/agents/${values.agent}/children`)).children.find(c => c.name === name);
      if (child?.agentId) break;
      const state = await api(`/v1/agents/${values.agent}/requests/${request.id}`);
      assert(state.state !== 'completed', 'Parent finished without spawning the requested inline child');
      await pause(1000);
    } while (Date.now() < deadline);
    assert(child?.agentId, 'Timed out waiting for inline child');
    created.add(child.agentId);
    assert(!(await configuration(child.agentId)).definition, 'Expected an inline child without a definition');
    await audit(child.agentId, 'inline');
    return { checks: results, seconds: (performance.now() - started) / 1000 };
  } finally {
    for (const id of created) await api(`/v1/agents/${id}`, undefined, 'DELETE');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: Object.fromEntries(['pilot', 'agent', 'vault-name', 'vault-url', 'blocked-host'].map(name => [name, { type: 'string' }])) });
  console.log(JSON.stringify(await verifyPilot(values)));
}
