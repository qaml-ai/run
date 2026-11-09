import { fileToolsFor, type FileToolDefinition } from './file-tool-policy.ts';

/**
 * The file tools as the policy words them for this configuration: in code mode, read, write and edit say to call them
 * directly; with fileTools: false, how scripts use them. Pi offers a registration's own description, so the words are
 * set where the tools are installed (agent-tools.ts, agent-http.ts).
 */
export function wordedFileTools<T extends FileToolDefinition>(tools: T[], config: { codeMode?: boolean; fileTools?: boolean }): T[] {
  const worded = new Map(fileToolsFor(tools, config.fileTools, config.codeMode).map(tool => [tool.name, tool.description]));
  return tools.map(tool => ({ ...tool, description: worded.get(tool.name) ?? tool.description }));
}

/**
 * Expose computer tools only to an agent that has a computer: the native `computer` tool when `nativeComputer` (the
 * deployment binds computers and the agent has one: computer-share.ts hasComputer), a connection's tools when attached.
 */
export function selectAgentTools<T extends FileToolDefinition>(
  tools: T[],
  fileNames: ReadonlySet<string>,
  config: { codeMode?: boolean; fileTools?: boolean; builtins?: readonly string[] },
  computers: ReadonlySet<string>,
  nativeComputer: boolean,
): { tools: T[]; modelTools: T[] } {
  const disabled = new Set([
    'host_execute', 'exec',
    ...(!nativeComputer || config.codeMode === false ? ['computer'] : []),
    ...(config.codeMode === false ? ['codemode'] : []),
    ...(!config.builtins?.includes('ask_user') ? ['ask_user'] : []),
    ...(!config.builtins?.includes('ask_human') ? ['ask_human'] : []),
  ]);
  const available = tools.filter(tool => !disabled.has(tool.name) &&
    (!/^(computer_|browser_)/.test(tool.name) || computers.has(tool.name)));
  return selectFileTools(available, fileNames, config);
}

/** Apply the source file-tool policy through Pi's separate enabled and model filters. */
export function selectFileTools<T extends FileToolDefinition>(
  tools: T[],
  fileNames: ReadonlySet<string>,
  config: { codeMode?: boolean; fileTools?: boolean },
): { tools: T[]; modelTools: T[] } {
  // These internal tools and the decide setting do not make a bare agent a tool-using agent.
  const internal = new Set(['host_execute', 'final_output', 'decide', 'report_progress', 'send_message']);
  const bare = config.codeMode === false && config.fileTools === false &&
    !tools.some(tool => !fileNames.has(tool.name) && !internal.has(tool.name));
  const files = bare ? [] : fileToolsFor(tools.filter(tool => fileNames.has(tool.name)), config.fileTools, config.codeMode);
  const exposure = new Map(files.map(tool => [tool.name, tool]));
  const enabled = tools.filter(tool => !fileNames.has(tool.name) || exposure.has(tool.name));
  return {
    tools: enabled,
    modelTools: enabled.filter(tool => {
      const selected = exposure.get(tool.name) ?? tool;
      return selected.callers === undefined || selected.callers.includes('model');
    }),
  };
}
