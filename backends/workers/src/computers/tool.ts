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
import type { ContainerComputer, OperateSetup } from "./objects.ts";
import { COMPUTER_LIMITS, egressDescription, type ComputerSettings } from "./egress.ts";

export interface ComputerBindings {
  COMPUTER_CONTAINERS?: DurableObjectNamespace<ContainerComputer>;
  /** TEST_MODE only: a loopback origin that stands in for every granted egress host. */
  TEST_EGRESS_UPSTREAM?: string;
}
const provider = oneOf(["container"]);
export const computerParameters = union([
  obj({
    provider,
    op: lit("exec"),
    command: str({ minLength: 1, maxLength: 16384 }),
    timeoutMs: opt(int({ minimum: 1, maximum: COMPUTER_LIMITS.execMs })),
  }),
  obj({
    provider,
    op: lit("exec"),
    argv: arr(str({ maxLength: 16384 }), { maxItems: 100, minItems: 1 }),
    timeoutMs: opt(int({ minimum: 1, maximum: COMPUTER_LIMITS.execMs })),
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
    op: lit("snapshot"),
    name: str({ pattern: "^[a-zA-Z0-9_-]{1,80}$" }),
  }),
  obj({
    provider,
    op: lit("restore"),
    name: str({ pattern: "^[a-zA-Z0-9_-]{1,80}$" }),
    from: opt(lit("parent")),
  }),
  obj({ provider, op: lit("sleep") }),
]);
/**
 * `setup` gives each operation the definition's computer settings, the agent's identity (for egress credentials) and
 * its parent's computer. `settings` words the description.
 */
export function computerTool(bindings: ComputerBindings, agentId: string, setup?: () => Promise<OperateSetup | undefined>, settings?: ComputerSettings) {
  return defineTool({
    name: "computer",
    parameters: computerParameters,
    replay: "unsafe",
    description:
      "Linux computer: exec a shell command (command, run with bash -lc) or an argv list (timeoutMs up to 600000), read/write relative /workspace paths, parse text/JSON/CSV/HTML, save/restore a named snapshot, or sleep. Parsing accepts 8 MiB, bounds extracted text and never executes document content; PDF is unsupported. Snapshots capture the whole filesystem. A sub-agent's computer can start as a copy of its parent's: restore with from: \"parent\" and the name of a snapshot the parent saved. Files are separate from agent volumes. Shell syntax requires an explicit shell. " +
      egressDescription(settings),
    async execute({ provider, ...request }) {
      const namespace = bindings.COMPUTER_CONTAINERS;
      if (!namespace)
        throw new Error(`Optional ${provider} computer is not configured`);
      const result = await namespace.getByName(agentId).operate(request as never, await setup?.());
      return { output: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });
}
