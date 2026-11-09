import type { TranscriptStore } from './session-transcripts.ts';

type SecretAccount = { unseal(aad: string, value: any): string; tenants: { providers(tenant: string): string[]; apiKey(tenant: string, provider: string): string | undefined } };
/** Fresh reads only. Values stay in memory and are never included in the workflow or logs. */
export async function tenantDreamSecrets(db: TranscriptStore['query'], accounts: SecretAccount, tenant: string): Promise<string[]> {
  const values = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value) {
      values.add(value);
      const bearer=value.match(/^Bearer\s+(.+)$/i);
      if(bearer) values.add(bearer[1]);
      const basic=value.match(/^Basic\s+(.+)$/i);
      if(basic) { values.add(basic[1]); try { const decoded=atob(basic[1]); values.add(decoded); for(const part of decoded.split(':')) if(part) values.add(part); } catch {} }
    }
    else if (value && typeof value === 'object') for (const entry of Object.values(value)) add(entry);
  };
  const open = (aad: string, sealed: any, json = true) => {
    const text = accounts.unseal(aad, sealed);
    add(json ? JSON.parse(text) : text);
  };
  for (const provider of accounts.tenants.providers(tenant)) add(accounts.tenants.apiKey(tenant, provider));
  const tables = await Promise.all([
    db('select provider,sealed from provider_keys where tenant=$1',[tenant]),
    db('select scope,provider,sealed from key_scope_providers where tenant=$1',[tenant]),
    db('select scope,name,sealed from model_providers where tenant=$1',[tenant]),
    db('select id,credentials from computer_connections where tenant=$1',[tenant]),
    db('select id,spec from definitions where tenant=$1',[tenant]),
    db('select header from agents where tenant=$1 and not revoked and purged_at is null',[tenant]),
  ]);
  for (const row of tables[0].rows) open(`${tenant}:${row.provider}`,row.sealed,false);
  for (const row of tables[1].rows) open(`key-scope:${tenant}:${row.scope}:${row.provider}`,row.sealed);
  for (const row of tables[2].rows) open(row.scope ? `model-provider:${tenant}:scope:${row.scope}:${row.name}` : `model-provider:${tenant}:${row.name}`,row.sealed);
  for (const row of tables[3].rows) open(`computer:${row.id}`,row.credentials);
  const configs = tables[4].rows.map(row => ({id:row.id,config:row.spec}));
  for (const {header} of tables[5].rows) {
    add(header.config?.modelHeaders);
    configs.push({id:header.definition?.id ?? header.config?.definition,config:header.sources ?? header.config});
  }
  for (const {id,config} of configs) {
    if (!config) continue;
    add(config.modelHeaders);
    add(config.computer?.secrets);
    for (const [field,kind] of [['mcpServers','mcp'],['openApi','openapi']] as const) {
      for (const source of config[field] ?? []) {
        add(source.headers);
        if (source.sealed && id) open(`definition:${id}:${kind}:${source.name}`,source.sealed);
      }
    }
  }
  // Vaults are not present on this main. A vault implementation must add its values here.
  return [...values].sort((a,b)=>b.length-a.length);
}
/** Replace exact values and common transport encodings, even short credentials. Never rewrite map keys. */
export function removeDreamSecrets(value: unknown, secrets: readonly string[]): any {
  if (typeof value === 'string') {
    for (const secret of secrets) for (const variant of new Set([secret,encodeURIComponent(secret),JSON.stringify(secret).slice(1,-1)]))
      if (variant) value = (value as string).split(variant).join('[redacted]');
    return value;
  }
  if (Array.isArray(value)) return value.map(item=>removeDreamSecrets(item,secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,removeDreamSecrets(item,secrets)]));
  return value;
}
