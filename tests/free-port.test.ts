import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { addressInUse, onFreePort } from "./cluster-helpers.ts";

test("onFreePort tries another port when the one it chose was taken first, and gives up on other errors", async () => {
  const taken = createServer().listen(0, "127.0.0.1");
  await once(taken, "listening");
  const used: number[] = [];
  const listen = async (port: number) => {
    // The first try is beaten to its port, as another process would beat it.
    const server = createServer().listen(used.push(port) === 1 ? (taken.address() as { port: number }).port : port, "127.0.0.1");
    await Promise.race([once(server, "listening"), once(server, "error").then(([error]) => { throw error; })]);
    server.close();
    return port;
  };
  assert.equal(await onFreePort(listen), used[1]);
  assert.equal(used.length, 2);
  taken.close();
  await assert.rejects(onFreePort(async () => { throw new Error("no database"); }), /no database/);
  assert.ok(addressInUse(Object.assign(new Error("node a exited: 1"), { addressInUse: true })));
});
