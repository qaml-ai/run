import { Worker } from "node:worker_threads";

/**
 * What a media worker costs (src/voice/media-host.ts): RSS and start time per worker, with the Discord transport loaded
 * (@discordjs/voice, DAVE's native module, libopus in WebAssembly) and a codec of each kind made, as a session's would.
 * `node --experimental-strip-types scripts/voice-worker-cost.ts [workers]`.
 */
const count = Number(process.argv[2] ?? 8);
const rss = () => process.memoryUsage().rss / 1_048_576;
const code = `
  const { parentPort } = require("node:worker_threads");
  (async () => {
    const started = performance.now();
    await import(${JSON.stringify(new URL("../src/voice-discord.ts", import.meta.url).href)});
    const { Opus } = await import(${JSON.stringify(new URL("../src/opus.ts", import.meta.url).href)});
    const decoder = new Opus(24000, 1, "voip"), encoder = new Opus(48000, 2, "audio");
    encoder.encode(Buffer.alloc(3840), 960);
    parentPort.postMessage(performance.now() - started);
  })();
`;
const before = rss();
const workers: Worker[] = [];
const starts: number[] = [];
for (let index = 0; index < count; index++) {
  const worker = new Worker(code, { eval: true });
  starts.push(await new Promise<number>(resolve => worker.once("message", resolve)));
  workers.push(worker);
}
await new Promise(resolve => setTimeout(resolve, 500));
const after = rss();
console.log(JSON.stringify({ workers: count, rssMb: { before: Math.round(before), after: Math.round(after), perWorker: Math.round((after - before) / count) }, startMs: { first: Math.round(starts[0]), median: Math.round(starts.sort((x, y) => x - y)[Math.floor(count / 2)]) } }));
await Promise.all(workers.map(worker => worker.terminate()));
