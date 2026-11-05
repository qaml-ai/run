import { createServer, type RequestListener } from "node:http";
import { once } from "node:events";
import type { TestContext } from "node:test";
export async function listen(t: TestContext, listener: RequestListener) {
  const server = createServer(listener);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

export async function until(predicate: () => unknown | Promise<unknown>, message = "condition", timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${message}`);
}
