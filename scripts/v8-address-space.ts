// Linux: how much address space a v8-exec process reserves, and the smallest RLIMIT_AS it runs under.
//   node --experimental-strip-types scripts/v8-address-space.ts
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { executeCode } from "../src/codemode.ts";
import { V8Exec, v8ExecBinary } from "../src/v8-exec.ts";

for (const args of [[], ["--jitless"]]) {
  const child = spawn(v8ExecBinary(), args, { stdio: ["pipe", "ignore", "ignore"] });
  await sleep(300);
  const status = readFileSync(`/proc/${child.pid}/status`, "utf8");
  console.log(JSON.stringify({ args, VmSize: /VmSize:\s+(.*)/.exec(status)![1], VmRSS: /VmRSS:\s+(.*)/.exec(status)![1], VmData: /VmData:\s+(.*)/.exec(status)![1] }));
  child.kill("SIGKILL");
}
const bridge = { definitions: [], call: async () => null };
for (const [kind, mb] of [["as", 20480], ["data", 192], ["data", 256], ["data", 384], ["data", 512]] as const) {
  const pool = new V8Exec(kind === "as" ? { maxAddressSpaceMb: mb } : { maxDataMb: mb });
  const outcome = async (code: string) => executeCode({ code, bridge, pool }).then(result => result.output.join(" ").slice(0, 60), error => `ERROR ${String(error.message).slice(0, 60)}`);
  console.log(JSON.stringify({ rlimit: kind, mb, return1: await outcome("return 1"), heapBomb: await outcome("const a = []; for (;;) a.push({ x: Math.random() })"), buffers: await outcome("const a = []; try { for (;;) a.push(new Uint8Array(1 << 20)); } catch (e) { return a.length + ' ' + e }") }));
  pool.close();
}
process.exit(0);
