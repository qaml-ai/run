import { defineTool } from "@earendil-works/pi-durable";
import { arr, int, lit, obj, oneOf, opt, str, union } from "@earendil-works/pi-schema";
import type { ContainerComputer, SandboxComputer } from "./objects.ts";

export interface ComputerBindings {
  COMPUTER_CONTAINERS?: DurableObjectNamespace<ContainerComputer>;
  COMPUTER_SANDBOXES?: DurableObjectNamespace<SandboxComputer>;
}
const provider = oneOf(["container", "sandbox"]);
export const computerParameters = union([
  obj({ provider, op: lit("exec"), argv: arr(str({maxLength:16384}), {maxItems:100, minItems:1}), timeoutMs: opt(int({minimum:1, maximum:30000})) }),
  obj({ provider, op: lit("read"), path: str({maxLength:1024}) }),
  obj({ provider, op: lit("write"), path: str({maxLength:1024}), content: str({maxLength:1024*1024}) }),
  obj({ provider, op: oneOf(["snapshot", "restore"]), name: str({pattern:"^[a-zA-Z0-9_-]{1,80}$"}) }),
  obj({ provider, op: lit("sleep") }),
]);
export function computerTool(bindings: ComputerBindings, agentId: string) {
  return defineTool({
    name: "computer", parameters: computerParameters, replay: "unsafe",
    description: "Optional Linux computer: exec argv, read/write relative /workspace paths, save/restore a named snapshot, or sleep. Choose container (whole filesystem snapshot) or sandbox (directory backup to R2). Files are separate from the agent Workspace. Shell syntax requires an explicit shell. No Internet access.",
    async execute({provider, ...request}) {
      const namespace = provider === "container" ? bindings.COMPUTER_CONTAINERS : bindings.COMPUTER_SANDBOXES;
      if (!namespace) throw new Error(`Optional ${provider} computer is not configured`);
      const result = await namespace.getByName(agentId).operate(request);
      return { output: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });
}
