import { defineDoc, defineTool, type ToolExecutionApi, type ToolRegistration, type ToolTaskInput } from '@earendil-works/pi-durable';
import { createCodemodeTool } from '@earendil-works/pi-durable/codemode';
import { CodemodeSandboxBase, type CodemodeRunOptions } from '@earendil-works/pi-codemode/portable';
import type { Context } from '@earendil-works/chord';
import { Delegation, type ParentRun } from './delegation.ts';
import { WORKFLOW_LIMITS, workflowTool, scriptCode, fnv1a, workflowAgentSummary, type WorkflowSettings } from './workflow-policy.ts';
import type { DelegateSettings } from './multi-agent-policy.ts';
import { toolCallSite } from './tool-call-context.ts';
import { SANDBOX_LIMITS } from '../../../src/limits.ts';

type Child = { index: number; label?: string; agent?: string; phase?: string; status: 'running' | 'completed' | 'failed'; error?: string; agentId?: string; requestId?: string; value?: any };
type State = { settings?: WorkflowSettings; runId?: string; callId?: string; createdAt?: number; children: Record<string, Child>; returned?: { value: any }; transferred: number; phases: number; lines: number };
const Workflow = defineDoc<State>({ kind: 'camel.workflow', version: 1, scope: 'task', initial: () => ({ children: {}, transferred: 0, phases: 0, lines: 0 }), checkpointWhen: () => true });
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value ?? null)).byteLength;
const textResult = (value: any, error = false) => ({ output: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredOutput: value, ...(error ? { isError: true } : {}) });
const delegateSettings = (settings: WorkflowSettings): DelegateSettings => ({ agents: settings.agents, instructions: settings.instructions, maxDepth: settings.maxDepth, maxParallel: settings.maxParallel ?? WORKFLOW_LIMITS.maxParallel });

/** Keep the source script API, but journal progress as native tool calls, too. */
export function workflowCode(script: string, args: unknown, parallel: number, now: number, seed: string) {
  return scriptCode(script, args, WORKFLOW_LIMITS.items, parallel, 'workflow-progress', now, fnv1a(seed))
    .replace('var __wf = tools.workflow_agent;', `var __events = Promise.resolve();
var __wf = async request => { await __events; return tools.workflow_agent(request); };`)
    .replace('var __emit = message => console.log(__mark + JSON.stringify(message));', 'var __emit = message => { __events = __events.then(() => tools.workflow_agent(message)); };');
}

async function owner(api: ToolExecutionApi, context: Context) {
  let id = api.taskId;
  for (let depth = 0; depth < 64; depth++) {
    const state = await api.snapshot(Workflow, id, context);
    if (state?.settings) return { id, state };
    const task = await api.getTask(id, context), input = task?.input as ToolTaskInput | undefined;
    if (input?.kind !== 'nested') break;
    id = input.parent;
  }
  throw new Error('workflow_agent is available only inside run_workflow');
}

export type WorkflowOptions = {
  sandbox: CodemodeSandboxBase;
  delegation: Delegation;
  settings?: WorkflowSettings;
  context(api: ToolExecutionApi): Promise<ParentRun>;
  emit(event: unknown): Promise<void>;
};

/** A workflow is a Pi script whose agent calls use the same durable child lifecycle. */
export async function workflowTools(options: WorkflowOptions): Promise<ToolRegistration[]> {
  if (!options.settings) return [];
  const settings = options.settings, delegation = options.delegation;
  const definition = workflowTool(settings, await delegation.targetDescriptions(delegateSettings(settings)));
  const internal = defineTool({ name: 'workflow_agent', description: 'A workflow operation.', callers: ['tools'], replay: 'safe',
    parameters: { type: 'object', additionalProperties: true }, structuredOutputSchema: {},
    async execute(raw, api, context) {
      const request = raw as Record<string, any>, { id, state } = await owner(api, context);
      const event = (value: object) => options.emit({ type: 'event', requestId: state.runId, event: { toolCallId: state.callId, ...value } });
      if (request.op === 'return') {
        if (bytes(request.value) > WORKFLOW_LIMITS.valueBytes) throw new Error(`The workflow's return value is larger than ${WORKFLOW_LIMITS.valueBytes} bytes; return a summary instead of the whole result`);
        await api.commit(async tx => { (await tx.doc(Workflow, id)).returned = { value: request.value ?? null }; }, context);
        return textResult(null);
      }
      if (request.op === 'phase' || request.op === 'log') {
        await api.commit(async tx => {
          const current = await tx.doc(Workflow, id);
          if (request.op === 'phase' && ++current.phases > WORKFLOW_LIMITS.phases) throw new Error(`A workflow may open at most ${WORKFLOW_LIMITS.phases} phases`);
          if (request.op === 'log' && ++current.lines > WORKFLOW_LIMITS.logLines) throw new Error(`A workflow may log at most ${WORKFLOW_LIMITS.logLines} lines`);
        }, context);
        await event({ type: 'workflow_progress', ...(request.op === 'phase' ? { phase: String(request.title).slice(0, WORKFLOW_LIMITS.labelChars) } : { log: String(request.message).slice(0, WORKFLOW_LIMITS.logChars) }) });
        return textResult(null);
      }
      if (request.op !== 'agent') throw new Error('Unknown workflow operation');
      const key = api.callId;
      const initial = await api.commit(async tx => {
        const current = await tx.doc(Workflow, id), saved = current.children[key];
        if (saved) return saved;
        const index = Object.keys(current.children).length;
        if (index >= (current.settings!.maxAgents ?? WORKFLOW_LIMITS.agents)) throw new Error(`A workflow makes at most ${current.settings!.maxAgents ?? WORKFLOW_LIMITS.agents} agent calls`);
        current.transferred += bytes(request);
        if (current.transferred > SANDBOX_LIMITS.workflowToolBytes - 512 * 1024) throw new Error('This workflow has used the sandbox transfer budget');
        return current.children[key] = { index, status: 'running', ...(typeof request.label === 'string' ? { label: request.label.slice(0, WORKFLOW_LIMITS.labelChars) } : {}), ...(typeof request.phase === 'string' ? { phase: request.phase } : {}), ...(typeof request.agent === 'string' ? { agent: request.agent } : {}) };
      }, context);
      if (initial.status !== 'running') return textResult(initial.value ?? null);
      let child: Child;
      try {
        const started = await delegation.start({ task: request.prompt, ...(request.agent !== undefined ? { agent: request.agent } : {}), ...(request.instructions !== undefined ? { instructions: request.instructions } : {}), ...(request.schema !== undefined ? { output: request.schema } : {}) }, `${state.callId}:workflow:${key}`, context.abortSignal ?? new AbortController().signal, false, api, delegateSettings(state.settings!));
        const answer = delegation.answer(await delegation.wait(started, context.abortSignal));
        let value = answer.output ?? answer.text ?? null;
        if (typeof value === 'string' && bytes(value) > WORKFLOW_LIMITS.answerChars) value = new TextDecoder().decode(new TextEncoder().encode(value).subarray(0, WORKFLOW_LIMITS.answerChars)) + `\n\n[answer cut at ${WORKFLOW_LIMITS.answerChars} bytes]`;
        else if (bytes(value) > WORKFLOW_LIMITS.answerChars) throw new Error(`An agent answered more than ${WORKFLOW_LIMITS.answerChars} bytes of JSON; ask it for less`);
        child = { ...initial, status: answer.status === 'completed' ? 'completed' : 'failed', agentId: answer.agentId, requestId: answer.requestId, ...(answer.error ? { error: answer.error } : {}), value: answer.status === 'completed' ? value : null };
      } catch (error) { child = { ...initial, status: 'failed', error: error instanceof Error ? error.message : String(error), value: null }; }
      await api.commit(async tx => {
        const current = await tx.doc(Workflow, id);
        current.transferred += bytes(child.value);
        if (current.transferred > SANDBOX_LIMITS.workflowToolBytes - 512 * 1024) throw new Error('This workflow has used the sandbox transfer budget');
        current.children[key] = child;
      }, context);
      return textResult(child.value ?? null);
    },
  });
  const run = defineTool({ name: definition.name, description: definition.description, parameters: definition.parameters as never, callers: ['model'], replay: 'safe', structuredOutputSchema: {},
    async execute(input, api, context) {
      if ((await toolCallSite(api, context)).innerCallId) throw new Error('run_workflow is called directly, not from code');
      const { script, args } = input as { script: string; args?: unknown };
      if (bytes(args) > WORKFLOW_LIMITS.argsBytes) throw new Error(`A workflow's args are at most ${WORKFLOW_LIMITS.argsBytes} bytes`);
      if (/\bimport\s*\(/.test(script)) throw new Error("A workflow script cannot import modules: put library work in an agent's task");
      const request = await options.context(api);
      await api.commit(async tx => { const state = await tx.doc(Workflow, api.taskId); if (!state.settings) Object.assign(state, { settings, runId: request.id, callId: api.callId, createdAt: api.now() }); }, context);
      const event = (value: object) => options.emit({ type: 'event', requestId: request.id, event: { toolCallId: api.callId, ...value } });
      await event({ type: 'workflow_start' });
      // Restrict this VM to the one workflow bridge; Pi still journals every call.
      class WorkflowSandbox extends CodemodeSandboxBase {
        constructor() { super({}, () => { throw new Error('Workflows require durable execution'); }); }
        override start(code: string, runOptions: CodemodeRunOptions) { return options.sandbox.start(code, { ...runOptions, tools: runOptions.tools?.filter(tool => tool.name === 'workflow_agent') }); }
      }
      const native = createCodemodeTool({ sandbox: new WorkflowSandbox(), models: false });
      let error: string | undefined;
      try {
        const state = (await api.snapshot(Workflow, api.taskId, context))!;
        const result = await native.execute({ code: `// @options: ${JSON.stringify({ timeout_ms: WORKFLOW_LIMITS.timeMs, max_output_tokens: 128_000 })}\n` + workflowCode(script, args, settings.maxParallel ?? WORKFLOW_LIMITS.maxParallel, state.createdAt!, `${request.id}:${api.callId}`) }, api, context);
        if (result.isError) error = result.output?.filter(part => part.type === 'text').map(part => part.text).join('\n') || 'The workflow failed';
      } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
      finally { await delegation.cancel(request.id, `${api.callId}:workflow:`); }
      const state = (await api.snapshot(Workflow, api.taskId, context))!;
      if (!state.returned && !error) error = 'The workflow did not return a value';
      const status = context.abortSignal?.aborted ? 'canceled' : error ? 'failed' : 'completed';
      const agents = Object.values(state.children).sort((a, b) => a.index - b.index).map(({ value: _value, ...child }) => child);
      const value = { status, ...workflowAgentSummary(agents), ...(state.returned ? { value: state.returned.value } : {}), ...(error ? { error } : {}) };
      await event({ type: 'workflow_end', status, agents: agents.length, ...(error ? { error } : {}) });
      return textResult(value, status !== 'completed');
    },
  });
  return [run, internal];
}
