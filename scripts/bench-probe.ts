// Preloaded into the runtime under `npm run bench:execute` (node --import). It reads
// commands on stdin: "probe" prints this process's CPU time (every thread) and the
// Postgres statements it has sent, grouped by their first words; "profile-start"
// and "profile-stop <file>" record a CPU profile of the main thread (the sandbox's
// worker threads are left out). Worker threads load it too; only the main thread acts.
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { isMainThread } from "node:worker_threads";
import pg from "pg";

if (isMainThread) {
  const statements = new Map<string, number>();
  const query = pg.Client.prototype.query;
  pg.Client.prototype.query = function (this: pg.Client, ...args: any[]) {
    const text: string = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
    const kind = text.replace(/\s+/g, " ").trim().slice(0, 48);
    statements.set(kind, (statements.get(kind) ?? 0) + 1);
    return (query as any).apply(this, args);
  } as any;

  // Linux only: the main thread's own CPU time, and the container's (every process in it, v8-exec and parse jobs included).
  const mainThread = () => {
    try { const fields = readFileSync(`/proc/self/task/${process.pid}/stat`, "utf8").split(") ")[1].split(" "); return (Number(fields[11]) + Number(fields[12])) * 10_000; }
    catch { return undefined; }
  };
  const cgroup = () => {
    try { return Number(/usage_usec (\d+)/.exec(readFileSync("/sys/fs/cgroup/cpu.stat", "utf8"))![1]); }
    catch { return undefined; }
  };
  const inspector = new Session();
  const commands: Record<string, (argument: string) => Promise<unknown>> = {
    probe: async () => ({ cpu: process.cpuUsage(), mainThreadUs: mainThread(), cgroupUs: cgroup(), statements: Object.fromEntries(statements) }),
    "profile-start": async () => {
      inspector.connect();
      await inspector.post("Profiler.enable");
      await inspector.post("Profiler.setSamplingInterval", { interval: 200 });
      await inspector.post("Profiler.start");
      return {};
    },
    "profile-stop": async file => {
      const { profile } = await inspector.post("Profiler.stop");
      await writeFile(file, JSON.stringify(profile));
      inspector.disconnect();
      return {};
    },
  };
  let pending = "";
  let chain = Promise.resolve();
  process.stdin.setEncoding("utf8").on("data", chunk => {
    const lines = (pending + chunk).split("\n");
    pending = lines.pop()!;
    for (const line of lines) chain = chain.then(async () => {
      const [command, argument = ""] = line.split(" ");
      const answer = await commands[command]?.(argument);
      console.log(JSON.stringify({ type: "bench_probe", command, ...answer as object }));
    });
  });
}
