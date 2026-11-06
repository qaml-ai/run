import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { test } from "node:test";
import { fakeModel as contractModel } from "./contract/http.ts";
import { fakeModel as runtimeModel } from "./runtime-server.ts";

for (const [name, fakeModel] of [["contract", contractModel], ["runtime", runtimeModel]] as const) {
  test(`${name} fake model tolerates cancellation before the request body is complete`, async t => {
    const model = await fakeModel(t, () => ({ role: "assistant", content: "done" }));
    const upload = request(model.url, {
      method: "POST",
      headers: { Expect: "100-continue", "Content-Type": "application/json", "Content-Length": "1000" },
    });
    // The server's continue response proves its request handler is reading the body.
    // Close before the declared body length, reproducing a cancelled provider upload.
    upload.on("error", () => {});
    const closed = new Promise<void>(resolve => upload.once("close", resolve));
    const reading = once(upload, "continue");
    upload.flushHeaders();
    await reading;
    upload.write('{"messages":[');
    upload.destroy();
    await closed;

    const complete = { messages: [{ role: "user", content: "hello" }] };
    const response = await fetch(model.url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(complete),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /done/);
    assert.deepEqual(model.bodies, [complete], "an incomplete upload is never sent to the model responder");
  });
}
