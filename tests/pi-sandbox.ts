import { PiV8Sandbox, type PiV8Options } from "../src/codemode-pi-launcher.ts";
import type { ToolBridge } from "../src/protocol.ts";
import { validateToolCall } from "../src/tool-policy.ts";

/** Run the production Pi launcher with a test tool bridge. */
export async function runPi(options: PiV8Options & { code: string; bridge?: ToolBridge; signal?: AbortSignal }) {
  const { code, bridge, signal, ...limits } = options;
  const sandbox = new PiV8Sandbox({ ...limits, tools: bridge?.definitions.map(tool => ({
    name: tool.name, description: tool.description, inputSchema: tool.parameters,
    execute: (args, context) => {
      const checked = validateToolCall(bridge.definitions, tool.name, args);
      return bridge.call(checked.tool.name, checked.args, context.signal);
    },
  })) });
  try {
    const result = await sandbox.execute(code, { signal });
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  } finally { await sandbox.close(); }
}
