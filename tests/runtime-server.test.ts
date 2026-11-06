import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import { runtime } from "./runtime-server.ts";

test("the runtime fixture rejects an occupied port after its drain log", async t => {
  const holder = createServer().listen(0, "127.0.0.1");
  await once(holder, "listening");
  t.after(() => new Promise<void>(resolve => holder.close(() => resolve())));
  const { port } = holder.address() as { port: number };
  await assert.rejects(
    runtime(t, () => ({ role: "assistant", content: "unused" }), { PORT: String(port) }),
    { message: "Server exited: 1" },
  );
});
