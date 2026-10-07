// The simulation hooks' cost in production (src/buggify.ts, src/assert.ts): nanoseconds per call and garbage collections,
// beside an empty loop and an allocating one. npm run bench:sim-hooks
import { PerformanceObserver } from "node:perf_hooks";
import { buggify } from "../src/buggify.ts";
import { always, reachable, sometimes } from "../src/assert.ts";

const sink: unknown[] = [];
let fired = 0;
async function measure(name: string, body: (i: number) => void) {
  let collections = 0;
  const observer = new PerformanceObserver(list => { collections += list.getEntries().length; });
  observer.observe({ entryTypes: ["gc"] });
  const n = 5_000_000, started = performance.now();
  for (let i = 0; i < n; i++) body(i);
  const ns = (performance.now() - started) * 1e6 / n;
  await new Promise(resolve => setTimeout(resolve, 50));
  observer.disconnect();
  console.log(`${name.padEnd(28)} ${ns.toFixed(2)} ns/iteration, ${collections} GCs`);
}
await measure("empty loop", i => { if (i < 0) fired++; });
await measure("buggify", () => { if (buggify("bench.site")) fired++; });
await measure("always+sometimes+reachable", i => { always(i >= 0, "bench: always"); sometimes(i < 0, "bench: sometimes"); reachable("bench: reachable"); });
await measure("allocating (control)", i => { sink[i & 1023] = { i }; });
