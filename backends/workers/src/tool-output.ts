import { agentRepoId } from "./repos/identity.ts";
import { hasFileArgument } from './tool-file-schema.ts';
import { Buffer } from 'node:buffer';
import { hook, ToolTask, type Extension, type HookApi, type ToolExecutionResult } from '@earendil-works/pi-durable';
import { FILE_LIMITS } from '../../../src/limits.ts';
import { handleAgentFileRequest, type FileBindings, type Mount as Mount } from './files.ts';
import { scratchMount } from './media/files-policy.ts';
import { toolOutputPolicy } from './tool-output-policy.ts';
import type { ToolCallSite } from './tool-call-context.ts';
import { saveToolImages, toolResultFiles } from './tool-output-files.ts';

type Scope = { tenant: string; agent: string; mounts: Mount[]; fileTools?: boolean; codeMode?: boolean; fileArguments?: Record<string, boolean>; call: ToolCallSite; requestId?:string };

/** Cap only model-facing results; nested scripts keep Pi's bounded structured values. */
export function toolOutputExtension(env: FileBindings, scope: (api: HookApi, callId: string) => Promise<Scope>): Extension {
  return { name: 'camel.tool-output', hooks: [hook(ToolTask, {
    async afterTool(call, result, api) {
      if (call.name === 'codemode' || call.name === 'bash') return; // Bash bounds both streams before building its result.
      const current = await scope(api, call.id);
      const prefix = call.name.split('__')[0];
      if (current.fileArguments?.[prefix] === false && hasFileArgument(call.arguments) && result.diagnostics?.some(value => value.code === 'invalid_arguments')) {
        return { ...result, diagnostics: result.diagnostics.map(value => value.code === 'invalid_arguments' ? { ...value, message: `${call.name} is not sent files: file arguments ({"$file": path}) are off for this tool. Pass what it needs in its own parameters (text, or a URL it can fetch), or use a tool that takes files` } : value) };
      }
      const materialized = await saveToolImages(result.output ?? [], await toolResultFiles(env, { ...current, tool: call.name, call: current.call.toolCallId }));
      if (call.parent) return { ...result, output: materialized };
      const own = agentRepoId(current.tenant, current.agent);
      const mount = current.fileTools !== false || current.codeMode !== false
        ? scratchMount(current.mounts.map(value => ({ ...value, workspace: value.repo === own }))) : undefined;
      const save = async (id: string, text: string, extension = 'txt') => {
        if (!mount) return;
        const prefix = current.call.messageIndex === undefined ? '' : `${current.call.messageIndex}-`;
        const path = `${mount.path}/tool-results/${prefix}${id.replace(/[^A-Za-z0-9_.-]/g, '_')}.${extension}`;
        const bytes = Buffer.from(text, 'utf8').subarray(0, FILE_LIMITS.scriptFileBytes);
        try {
          const response = await handleAgentFileRequest(new Request('https://agent.invalid/files', {
            method: 'PUT', body: bytes as Uint8Array<ArrayBuffer>, headers: { 'x-camel-call':current.call.toolCallId,...(current.requestId?{'x-camel-run':current.requestId}:{}), 'Content-Type': extension === 'json' ? 'application/json' : 'text/plain; charset=utf-8' },
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
