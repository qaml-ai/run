import { Directory, type ControlEnv } from './control.ts';
import { resolveDefinition } from './definitions.ts';
import { HttpError } from './errors.ts';

/** Existing targets keep their history; definition targets create a new child. */
export async function delegationTarget(env: ControlEnv, tenant: string, target: { agent?: string; definition?: string }) {
  if (target.definition !== undefined) return { config: (await resolveDefinition(env, tenant, target.definition)).spec };
  if (target.agent !== undefined) {
    const entry = await new Directory(env, tenant).get(target.agent);
    if (!entry || entry.deleted || entry.expiresAt !== null && entry.expiresAt <= Date.now()) throw new HttpError(404, 'Unknown delegate agent');
    return { id: entry.id, config: entry.config };
  }
  throw new HttpError(400, 'Name a definition or an existing agent');
}
