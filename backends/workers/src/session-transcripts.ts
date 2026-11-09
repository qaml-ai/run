import { database } from './postgres.ts';
import type { ControlEnv } from './control.ts';

/** Durable Objects retain named-target edges as well as newly created children. Read them without a cache. */
export async function transcriptDescendants(env: ControlEnv, tenant: string, root: string): Promise<string[]> {
  const seen = new Set<string>();
  let pending = [root];
  while (pending.length) {
    const batch = pending.splice(0, 4).filter(id => !seen.has(id));
    for (const id of batch) seen.add(id);
    const found = await Promise.all(batch.map(async id => {
      const row = (await database(env).query('select id from agents where id=$1 and tenant=$2 and not revoked and purged_at is null and (expires_at is null or expires_at > $3)', [id, tenant, Date.now()])).rows[0];
      if (!row) return [];
      const response = await env.AGENTS.getByName(id).fetch(new Request('https://agent/conversation-children'));
      if (!response.ok) throw new Error('Cannot read conversation descendants');
      return (await response.json() as {children: string[]}).children;
    }));
    pending.push(...found.flat().filter(id => !seen.has(id)));
  }
  return [...seen];
}

export async function transcriptScope(env: ControlEnv, id: string) {
  const row=(await database(env).query('select header from agents where id=$1',[id])).rows[0];
  const response=await env.AGENTS.getByName(id).fetch(new Request('https://agent/state'));
  if(!response.ok) throw new Error('Cannot read conversation scope');
  const state=await response.json() as {requests:any[]};
  return {subject:row?.header?.config?.subject,requests:state.requests};
}
