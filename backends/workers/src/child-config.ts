import { childMounts } from './delegation-policy.ts';
import { SUBAGENT_PROMPT } from './multi-agent-policy.ts';
import { hostMatches, PACKAGE_HOSTS, type Networking } from '../../../src/core/vault.ts';

const effectiveHosts = (config: Record<string, any>, policy: Networking) => [
  ...policy.allowedHosts,
  ...(policy.allowPackageManagers ? PACKAGE_HOSTS : []),
  ...(policy.allowMcpServers ? (config.mcpServers ?? []).map((server: any) => new URL(server.url).hostname) : []),
];
const narrower = (rule: string, boundary: string) => rule === boundary || boundary.startsWith('*.') && hostMatches(rule.startsWith('*.') ? rule.slice(2) : rule, boundary);

/** Children can narrow an inherited boundary, never acquire new destinations or credentials. */
export function childSecurity(parent: Record<string, any>, target: Record<string, any> = parent) {
  const a = parent.networking as Networking | undefined, b = target.networking as Networking | undefined;
  let networking = b;
  if (a?.type === 'limited') {
    const ar = effectiveHosts(parent, a), br = b?.type === 'limited' ? effectiveHosts(target, b) : ar;
    networking = {
      type: 'limited',
      allowedHosts: [...new Set([...ar.filter(x => br.some(y => narrower(x, y))), ...br.filter(x => ar.some(y => narrower(x, y)))])],
      allowPackageManagers: false, allowMcpServers: false,
    };
  }
  const refs = (c: Record<string, any>) => [
    ...(c.computer?.secrets ?? []), ...(c.computer?.egress ?? []).map((g: any) => g.auth),
    ...(c.mcpServers ?? []).map((s: any) => s.auth), ...(c.openApi ?? []).map((s: any) => s.auth),
  ].filter((r: any) => r?.type === 'vault');
  const permitted = (r: any) => refs(parent).some((p: any) => p.name === r.name && (p.workspace ?? '') === (r.workspace ?? '') && (!r.inBody || p.inBody));
  const computer = target.computer && {
    ...target.computer,
    ...(target.computer.secrets ? { secrets: target.computer.secrets.filter(permitted) } : {}),
    ...(target.computer.egress ? { egress: target.computer.egress.filter((g: any) => !g.auth || (parent.computer?.egress ?? []).some((p: any) => JSON.stringify(p) === JSON.stringify(g))) } : {}),
  };
  const sources = Object.fromEntries(['mcpServers', 'openApi'].filter(k => target[k]).map(k => [k, target[k].filter((s: any) => {
    const inherited = (parent[k] ?? []).some((p: any) => JSON.stringify([p.url, p.baseUrl, p.auth, p.headers, p.sealed]) === JSON.stringify([s.url, s.baseUrl, s.auth, s.headers, s.sealed]));
    if ((Object.keys(s.headers ?? {}).length || s.sealed) && !inherited) return false;
    if (s.auth?.type === 'vault') return permitted(s.auth);
    return !s.auth || s.auth.type === 'runtime' || inherited;
  })]));
  return { ...(networking ? { networking } : {}), ...(computer ? { computer } : {}), ...sources };
}

/** Existing agents cannot be reconfigured as a side effect of delegation. Refuse a wider target. */
export function assertChildSecurity(parent: Record<string, any>, target: Record<string, any>) {
  const restricted: Record<string, any> = childSecurity(parent, target);
  const credentialsChanged = ['computer', 'mcpServers', 'openApi'].some(key => JSON.stringify(restricted[key]) !== JSON.stringify(target[key]));
  const a = parent.networking as Networking | undefined, b = target.networking as Networking | undefined;
  const networkWider = a?.type === 'limited' && (b?.type !== 'limited' || effectiveHosts(target, b).some(rule => !effectiveHosts(parent, a).some(boundary => narrower(rule, boundary))));
  if (credentialsChanged || networkWider) throw new Error("Delegation target exceeds the parent's network or secret access");
}

/**
 * Inline children share the parent's files and model, only its web builtins, and its native computer settings (the
 * hosts it may reach and their credentials), as a child inherits a computer connection. A definition's child has its
 * definition's, bounded by the parent's network and secret access.
 */
export function childConfig(parent: Record<string, any>, target?: Record<string, any>, params?: Record<string, any>) {
  const web = (parent.builtins as string[] | undefined)?.filter(name => name === 'web_search' || name === 'web_fetch') ?? [];
  return {
    ...(target ?? { model: parent.model, systemPrompt: SUBAGENT_PROMPT, ...(web.length ? { builtins: web } : {}), ...childMounts(parent.mounts), ...(parent.computer ? { computer: parent.computer } : {}) }),
    ...childSecurity(parent, target ?? {computer:parent.computer,networking:parent.networking}),
    ...(parent.subject !== undefined ? { subject: parent.subject } : {}),
    ...(parent.context ? { context: parent.context } : {}),
    ...(parent.keyScope ? { keyScope: parent.keyScope } : {}),
    ...((params?.bucket ?? parent.bucket) ? { bucket: params?.bucket ?? parent.bucket } : {}),
  };
}
