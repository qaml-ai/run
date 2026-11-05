import type { Extension } from '@earendil-works/pi-durable';
import { runtimeRules } from './prompt-policy.ts';
import { languageInstructions } from '../../../src/language.ts';

type Config = { codeMode?: boolean; fileTools?: boolean; language?: string; mounts?: { path: string; mode: string }[] };
/** Pi renders these each request, so compaction cannot discard the runtime rules. */
export function runtimePromptSections(config: () => Promise<Config>): Extension {
  return {
    name: 'camel.runtime',
    sections: [
      { key: 'runtime', tag: false, render: async ({ agent }) => runtimeRules({ ...await config(), tools: agent.tools }) },
      { key: 'environment', tag: false, render: async ({ agent }) => {
        const current = await config();
        if (current.codeMode === false && !agent.tools.length) return;
        const names = agent.tools.map(tool => tool.name).sort();
        const mounts = current.mounts ?? [{ path: '/workspace', mode: 'rw' }];
        return ['Your environment:', `- Files: ${mounts.length ? mounts.map(mount => `${mount.path} (${mount.mode === 'ro' ? 'read-only' : 'read-write'})`).join(', ') : 'no volumes mounted'}.`, `- Tools declared to you: ${names.length ? names.join(', ') : 'none'}.`, ...(names.includes('ask_user') ? ["- When you are blocked on a choice only the user can make, ask them with ask_user; your turn pauses until they answer. Don't ask what you can find out yourself."] : []), ...(current.codeMode !== false ? ['- Code runs in an isolated per-session sandbox. Each script has a 24 MiB heap; at most three scripts run concurrently. The codemode section gives its tool and execution limits.'] : [])].join('\n');
      } },
      { key: 'language', tag: false, render: async () => { const language = (await config()).language; return language ? languageInstructions(language) : undefined; } },
    ],
  };
}
