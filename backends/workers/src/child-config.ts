import { childMounts } from './delegation-policy.ts';
import { SUBAGENT_PROMPT } from './multi-agent-policy.ts';

/**
 * Inline children share the parent's files and model, only its web builtins, and its native computer settings (the
 * hosts it may reach and their credentials), as a child inherits a computer connection. A definition's child has its
 * definition's.
 */
export function childConfig(parent: Record<string, any>, target?: Record<string, any>, params?: Record<string, any>) {
  const web = (parent.builtins as string[] | undefined)?.filter(name => name === 'web_search' || name === 'web_fetch') ?? [];
  return {
    ...(target ?? { model: parent.model, systemPrompt: SUBAGENT_PROMPT, ...(web.length ? { builtins: web } : {}), ...childMounts(parent.mounts), ...(parent.computer ? { computer: parent.computer } : {}) }),
    ...(parent.subject !== undefined ? { subject: parent.subject } : {}),
    ...(parent.context ? { context: parent.context } : {}),
    ...(parent.keyScope ? { keyScope: parent.keyScope } : {}),
    ...((params?.bucket ?? parent.bucket) ? { bucket: params?.bucket ?? parent.bucket } : {}),
  };
}
