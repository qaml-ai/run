import { Buffer } from 'node:buffer';
import { hook, ToolTask, type Extension, type HookApi, type ToolExecutionResult } from '@earendil-works/pi-durable';
import { FILE_LIMITS } from '../../../src/limits.ts';
import { handleAgentFileRequest, type FileBindings, type Mount } from './files.ts';
import { workspaceId } from './file-mounts.ts';
import { scratchMount } from './media/files-policy.ts';
import { toolOutputPolicy } from './tool-output-policy.ts';
import type { ToolCallSite } from './tool-call-context.ts';
import { saveToolImages, toolResultFiles } from './tool-output-files.ts';

type Scope = { tenant: string; agent: string; mounts: Mount[]; fileTools?: boolean; codeMode?: boolean; call: ToolCallSite };

/** Cap only model-facing results; nested scripts keep Pi's bounded structured values. */
export function toolOutputExtension(env: FileBindings, scope: (api: HookApi, callId: string) => Promise<Scope>): Extension {
  return { name: 'camel.tool-output', hooks: [hook(ToolTask, {
    async afterTool(call, result, api) {
      if (call.name === 'codemode') return;
      const current = await scope(api, call.id);
      const materialized = await saveToolImages(result.output ?? [], await toolResultFiles(env, { ...current, tool: call.name, call: String(api.taskId) }));
      if (call.parent) return { ...result, output: materialized };
      const own = await workspaceId(current.agent);
      const mount = current.fileTools !== false || current.codeMode !== false
        ? scratchMount(current.mounts.map(value => ({ ...value, workspace: value.volumeId === own || value.volumeId === `agent:${current.agent}` }))) : undefined;
      const save = async (id: string, text: string, extension = 'txt') => {
        if (!mount) return;
        const prefix = current.call.messageIndex === undefined ? '' : `${current.call.messageIndex}-`;
        const path = `${mount.path}/tool-results/${prefix}${id.replace(/[^A-Za-z0-9_.-]/g, '_')}.${extension}`;
        const bytes = Buffer.from(text, 'utf8').subarray(0, FILE_LIMITS.scriptFileBytes);
        try {
          const response = await handleAgentFileRequest(new Request('https://agent.invalid/files', {
            method: 'PUT', body: bytes as Uint8Array<ArrayBuffer>, headers: { 'Content-Type': extension === 'json' ? 'application/json' : 'text/plain; charset=utf-8' },
          }), env, current.tenant, current.agent, path, current.mounts);
          return response.ok ? path : undefined;
        } catch { return; }
      };
      const policy = toolOutputPolicy({ ...current, id: current.agent }, save);
      const output = await policy.capped(call.id, materialized);
      const details = await policy.cappedDetails(call.id, call.name, result.details);
      return { ...result, output, ...(details === undefined ? {} : { details: details as ToolExecutionResult["details"] }) };
    },
  })] };
}
