import { fileToolsFor, type FileToolDefinition } from './file-tool-policy.ts';

/** Apply the source file-tool policy through Pi's separate enabled and model filters. */
export function selectFileTools<T extends FileToolDefinition>(
  tools: T[],
  fileNames: ReadonlySet<string>,
  config: { codeMode?: boolean; fileTools?: boolean },
): { tools: T[]; modelTools: T[] } {
  // These internal tools and the decide setting do not make a bare agent a tool-using agent.
  const internal = new Set(['host_execute', 'final_output', 'decide']);
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
