import { defineTool } from "@earendil-works/pi-durable";
import {
  arr,
  int,
  lit,
  obj,
  oneOf,
  opt,
  str,
  union,
} from "@earendil-works/pi-schema";
import type { ContainerComputer } from "./objects.ts";

export interface ComputerBindings {
  COMPUTER_CONTAINERS?: DurableObjectNamespace<ContainerComputer>;
}
const provider = oneOf(["container"]);
export const computerParameters = union([
  obj({
    provider,
    op: lit("exec"),
    argv: arr(str({ maxLength: 16384 }), { maxItems: 100, minItems: 1 }),
    timeoutMs: opt(int({ minimum: 1, maximum: 30000 })),
  }),
  obj({ provider, op: lit("read"), path: str({ maxLength: 1024 }) }),
  obj({
    provider,
    op: lit("write"),
    path: str({ maxLength: 1024 }),
    content: str({ maxLength: 1024 * 1024 }),
  }),
  obj({
    provider,
    op: lit("parse"),
    path: str({ maxLength: 1024 }),
    format: oneOf(["text", "json", "csv", "html"]),
  }),
  obj({
    provider,
    op: oneOf(["snapshot", "restore"]),
    name: str({ pattern: "^[a-zA-Z0-9_-]{1,80}$" }),
  }),
  obj({ provider, op: lit("sleep") }),
]);
export function computerTool(bindings: ComputerBindings, agentId: string) {
  return defineTool({
    name: "computer",
    parameters: computerParameters,
    replay: "unsafe",
    description:
      "Linux computer: exec argv, read/write relative /workspace paths, parse text/JSON/CSV/HTML, save/restore a named snapshot, or sleep. Parsing accepts 8 MiB, bounds extracted text and never executes document content; PDF is unsupported. Snapshots capture the whole filesystem. Files are separate from agent volumes. Shell syntax requires an explicit shell. No Internet access.",
    async execute({ provider, ...request }) {
      const namespace = bindings.COMPUTER_CONTAINERS;
      if (!namespace)
        throw new Error(`Optional ${provider} computer is not configured`);
      const result = await namespace.getByName(agentId).operate(request);
      return { output: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });
}
