import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";

// Test hook only (sandbox-server --test-hooks): what a sandbox process can reach,
// reported from inside it. The native checks, against the runtime and a sibling
// sandbox process, run in a child, which inherits this process's uid and seccomp filter.
export async function probe(params: { pid: number; sibling: number; paths: string[]; launcher: string }) {
  const outcome = (fn: () => unknown) => { try { fn(); return "ok"; } catch (error) { return (error as NodeJS.ErrnoException).code ?? String(error); } };
  const status = Object.fromEntries(readFileSync("/proc/self/status", "utf8").split("\n")
    .filter(line => /^(Uid|Gid|Groups|NoNewPrivs|Seccomp|Seccomp_filters|CapEff|CapPrm|CapBnd):/.test(line))
    .map(line => line.split(/:\s*/, 2)));
  const tcp = await new Promise<string>(resolve => {
    const socket = connect({ host: "127.0.0.1", port: 8790 });
    socket.once("connect", () => { socket.destroy(); resolve("ok"); });
    socket.once("error", error => resolve((error as NodeJS.ErrnoException).code ?? String(error)));
  });
  return {
    pid: process.pid, uid: process.getuid!(), gid: process.getgid!(), groups: process.getgroups!(),
    env: { ...process.env }, status, tcp,
    files: Object.fromEntries(params.paths.map(path => [path, outcome(() => {
      try { readdirSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error; readFileSync(path); }
    })])),
    native: Object.fromEntries(Object.entries({ runtime: params.pid, sibling: params.sibling })
      .map(([name, pid]) => [name, JSON.parse(execFileSync(params.launcher, ["probe", String(pid)], { encoding: "utf8" }))])),
  };
}
