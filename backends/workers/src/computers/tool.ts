import { defineTool } from "@earendil-works/pi-durable";
import { SHARED_COMPUTER_CONTROL } from "../../../../src/core/computer-share.ts";
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
  }),
  obj({ provider, op: lit("sleep") }),
]);
/**
 * `setup` gives each operation the definition's computer settings and the agent's identity (for egress credentials and
 * metering). `settings` words the description.
 */
export function computerTool(bindings: ComputerBindings, agentId: string, setup?: () => Promise<OperateSetup | undefined>, settings?: ComputerSettings, owner?: () => Promise<{ id: string; shared: boolean }>) {
  return defineTool({
    name: "computer",
    parameters: computerParameters,
    replay: "unsafe",
    description:
      "Linux computer: exec a shell command (command, run with bash -lc) or an argv list (timeoutMs up to 600000), read/write files in /workspace (paths relative to it, or absolute under it), parse text/JSON/CSV/HTML, save/restore a named snapshot, or sleep. Parsing accepts 8 MiB, bounds extracted text and never executes document content; PDF is unsupported. Snapshots capture the whole filesystem. The disk lasts while the computer runs: it stops after idling, and sleep saves the disk first so the next operation resumes it. To give a sub-agent its own copy of this disk, start it with computer: \"fork\" on delegate or spawn_agent. Files are separate from agent volumes. Shell syntax requires an explicit shell. " +
      egressDescription(settings),
    async execute({ provider, ...request }) {
      const namespace = bindings.COMPUTER_CONTAINERS;
      if (!namespace)
        throw new Error(`Optional ${provider} computer is not configured`);
      if ("path" in request) request.path = computerPath(request.path);
      const target = await owner?.();
      if (target?.shared && ["sleep", "restore"].includes(request.op)) throw new Error(SHARED_COMPUTER_CONTROL);
      const result = await namespace.getByName(target?.id ?? agentId).operate(request as never, await setup?.());
      return { output: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });
}

/**
 * A read, write or parse path as models write it: an absolute one under /workspace (where exec runs, so models name
 * files that way) is made relative; any other absolute or `..` path is refused saying where paths resolve, rather than
 * as an invalid path. On the pilot, nearly every refused computer call of DeepSeek V4.1 Flash, on every host, was a
 * write to /workspace/<repo>/... or /tmp/... (2026-11-07). The path's own check follows (validation.ts workspacePath).
 */
export function computerPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith("/workspace/")) return trimmed.slice("/workspace/".length);
  if (trimmed.startsWith("/") || trimmed.split("/").includes(".."))
    throw new Error(`read, write and parse take paths in /workspace, relative to it (src/app.js is /workspace/src/app.js); ${JSON.stringify(path.slice(0, 200))} is outside it: use a path under /workspace, or exec for other places`);
  return path;
}
