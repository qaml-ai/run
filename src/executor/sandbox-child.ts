import { createInterface } from "node:readline";
import { Rpc } from "../rpc.ts";
import { runSandbox } from "../quickjs-sandbox.ts";

// The code child as it runs inside a per-execution sandbox, where no IPC channel
// crosses the boundary: stdin and stdout carry the executor's NDJSON protocol.
// Anything else that writes to stdout (a dependency, an engine abort) goes to stderr.
const protocol = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;

const rpc = new Rpc(message => { protocol(`${JSON.stringify(message)}\n`); });
createInterface({ input: process.stdin })
  .on("line", line => { void rpc.receive(JSON.parse(line)); })
  // The executor closing its end means the execution is over, whatever state it was in.
  .on("close", () => process.exit(0));

let used = false;
rpc.handler = async (method, params) => {
  if (method !== "execute" || used) throw new Error("Codemode child accepts one execution");
  used = true;
  return runSandbox({
    code: params.code,
    tools: params.tools,
    timeoutMs: params.timeoutMs,
    maxOutputCharacters: params.maxOutputCharacters,
    call: (name, args) => rpc.request("tool", { name, args }),
    onOutput: text => rpc.send({ type: "event", event: { type: "output", text } }),
  });
};
