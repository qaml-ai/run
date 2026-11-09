import { mountNotes } from "../../../shared/mount-notes.ts";
import type { Extension } from '@earendil-works/pi-durable';
import { approvalPrompt } from './tool-approval-prompt.ts';
import { runtimeRules } from './prompt-policy.ts';
import { languageInstructions } from '../../../src/language.ts';

type Config = { sharedAgent?: unknown; codeMode?: boolean; fileTools?: boolean; language?: string; systemPrompt?: string; systemPromptAppend?: string; mounts?: { path: string; mode: string; instructions?: string }[]; output?: unknown };
const activeTools = <T extends { name: string }>(tools: readonly T[], config: Config) => tools.filter(tool => tool.name !== 'final_output' || config.output !== undefined);
/** Pi renders these each request, so compaction cannot discard the runtime rules. */
export function runtimePromptSections(config: () => Promise<Config>): Extension {
  return {
    name: 'camel.runtime',
    sections: [
      { key: 'runtime', tag: false, render: async ({ agent }) => { const current = await config(); return runtimeRules({ ...current, tools: activeTools(agent.tools, current) }); } },
      { key: 'application', tag: false, render: async () => { const current = await config(); return [current.systemPrompt,current.systemPromptAppend].filter(Boolean).join('\n\n') || undefined; } },
      { key: 'environment', tag: false, render: async ({ agent }) => {
        const current = await config();
        const tools = activeTools(agent.tools, current);
        if (current.codeMode === false && !tools.length) return;
        const names = tools.map(tool => tool.name).sort();
        const mounts = current.mounts ?? [{ path: '/workspace', mode: 'rw' }];
        return ['Your environment:', ...approvalPrompt(tools), `- Files: ${mounts.length ? mounts.map(mount => `${mount.path} (${mount.mode === 'ro' ? 'read-only' : 'read-write'})`).join(', ') : 'no volumes mounted'}.${mounts.length ? current.fileTools === false ? current.codeMode !== false ? " Scripts read and write them with the file tools (tools.read, tools.write, tools.ls and so on); the application's own tools may reach other files." : " The application's own tools may reach them." : " The file tools (read, write, edit, ls, glob, grep, mv, cp) are for looking at and changing them." : ''}`, ...(mountNotes(mounts) ? [mountNotes(mounts)] : []), `- Tools declared to you: ${names.length ? names.join(', ') : 'none'}.`, ...(names.includes('ask_user') ? ["- When you are blocked on a choice only the user can make, ask them with ask_user; your turn pauses until they answer. Don't ask what you can find out yourself."] : []), ...(current.codeMode !== false ? ['- Code runs in an isolated per-session sandbox. Each script has a 24 MiB heap; at most three scripts run concurrently. The codemode section gives its tool and execution limits.'] : [])].join('\n');
      } },
      { key: 'language', tag: false, render: async () => { const language = (await config()).language; return language ? languageInstructions(language) : undefined; } },
    ],
  };
}
