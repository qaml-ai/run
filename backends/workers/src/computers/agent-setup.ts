import { Directory, type ControlEnv } from "../control.ts";
import type { Config } from "../agent-types.ts";
import type { OperateSetup } from "./objects.ts";
import type { ComputerSettings } from "./egress.ts";

// The parent link is written once, by the runtime, when a sub-agent is made (child-parent.ts); it never changes.
const parents = new Map<string, string | null>();

/**
 * What an agent's computer needs with each operation: its definition's settings, the identity its egress credentials
 * are fetched for (the claims an exchange token carries: tenant, agent, definition, subject, context), and its
 * parent's computer object, by the name the parent's own computer tool uses (the parent agent's object id).
 */
export async function computerSetup(env: ControlEnv & { AGENT_PUBLIC_URL?: string; AGENTS: { idFromName(name: string): DurableObjectId } }, conf: Config): Promise<OperateSetup> {
  const settings = (conf.config.computer ?? {}) as ComputerSettings;
  const issuer = env.AGENT_PUBLIC_URL || conf.runtimeOrigin || "";
  if (settings.egress?.some(grant => grant.auth) && !issuer) throw new Error("Runtime public URL is not configured");
  const claims = {
    tenant: conf.tenantId, agent: conf.id,
    ...(conf.config.definition ? { definition: conf.config.definition } : {}),
    ...(conf.config.subject ? { sub: conf.config.subject } : {}),
    ...(conf.config.context ? { ctx: conf.config.context as Record<string, unknown> } : {}),
  };
  let parent = parents.get(conf.id);
  if (parent === undefined) {
    const entry = await new Directory(env, conf.tenantId).get(conf.id);
    parent = entry?.parentAgentId ? env.AGENTS.idFromName(entry.parentAgentId).toString() : null;
    if (entry) parents.set(conf.id, parent);
  }
  return { settings, identity: { issuer, claims }, ...(parent ? { parent } : {}) };
}
