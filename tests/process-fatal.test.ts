import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { runtime, until } from "./runtime-server.ts";

const preload = ["--import", fileURLToPath(new URL("./fixtures/fatal-on-signal.mjs", import.meta.url))];
const logged = (logs: string[], type: string) => logs.map(line => { try { return JSON.parse(line); } catch { return undefined; } }).filter(entry => entry?.type === type);

for (const [signal, kind] of [["SIGUSR2", "uncaughtException"], ["SIGWINCH", "unhandledRejection"]] as const) {
  test(`${kind}: the node drains (its running turn finishes) and the process exits 1`, { timeout: 60_000 }, async t => {
    // The model takes a second: the turn is running when the error comes.
    const r = await runtime(t, () => ({ content: "finished anyway", delayMs: 1_000 }), {}, undefined, { execArgv: preload });
    const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
    await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "go", requestId: "turn" } });
    await until(() => r.model.bodies.length === 1, "the model to be called");
    const exited = once(r.child, "exit");
    r.child.kill(signal);
    const [code] = await exited;
    assert.equal(code, 1);
    const started = logged(r.logs, "drain_started");
    assert.equal(started.length, 1); assert.equal(started[0].signal, kind);
    assert.equal(logged(r.logs, "drain_finished")[0]?.unfinished, 0, "the turn finished within the drain");
  });
}
