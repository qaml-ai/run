import assert from "node:assert/strict";
import test from "node:test";
import { Agents } from "../../../clients/agents.ts";
import { startFixture } from "./fixture.ts";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
test(
  "Workers-native core lifecycle, recovery and financial seam",
  { timeout: 180000 },
  async (t) => {
    const fixture = await startFixture();
    t.after(() => fixture.stop());
    const agents = new Agents({
      url: fixture.url,
      apiKey: fixture.token,
      connection: "lazy",
      pollMs: 25,
    });
    t.after(() => agents.close());
    const request = async (path: string, body?: unknown, method?: string) => {
      const r = await fetch(fixture.url + path, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers: {
          Authorization: `Bearer ${fixture.token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const value = (await r.json()) as any;
      assert.ok(r.ok, `${r.status} ${JSON.stringify(value)}`);
      return value;
    };
    const alpha = await agents.upsert("alpha", {
      model: "test/echo",
      instructions: "Answer simply.",
    });
    await t.test(
      "create, keyed upsert, message, history and idempotency",
      async () => {
        const again = await agents.upsert("alpha", {
          model: "test/echo",
          instructions: "Answer simply.",
        });
        assert.equal(again.id, alpha.id);
        await again.close();
        const result = await alpha.run("hello", {
          idempotencyKey: "hello",
          timeoutMs: 15000,
        });
        assert.equal(result.text, "Echo: hello");
        const before = await alpha.history();
        assert.ok(before.some((m) => JSON.stringify(m).includes("hello")));
        assert.equal(
          (
            await alpha.run("hello", {
              idempotencyKey: "hello",
              timeoutMs: 15000,
            })
          ).text,
          result.text,
        );
        assert.deepEqual(await alpha.history(), before);
        await assert.rejects(
          alpha.run("different", { idempotencyKey: "hello", timeoutMs: 15000 }),
          /reused|different|conflict/i,
        );
      },
    );
    await t.test("stream emits actual text deltas", async () => {
      const stream = alpha.stream("streamed", { timeoutMs: 15000 });
      const chunks: string[] = [];
      for await (const part of stream)
        if (part.type === "text") chunks.push(part.text);
      assert.equal(chunks.join(""), "Echo: streamed");
      assert.equal((await stream.result()).text, "Echo: streamed");
    });
    await t.test("human input survives a hard workerd restart", async () => {
      const sent = await alpha.send("ask:May I proceed?");
      let inputs: any[] = [];
      for (let i = 0; i < 100 && !inputs.length; i++) {
        inputs = await request(`/v1/agents/${alpha.id}/inputs`);
        await delay(30);
      }
      assert.equal(inputs.length, 1);
      await fixture.worker.stop(true);
      await fixture.worker.start();
      assert.deepEqual(await request(`/v1/agents/${alpha.id}/inputs`), inputs);
      await request(`/v1/agents/${alpha.id}/inputs/${inputs[0].id}`, {
        answer: "yes",
      });
      assert.match(
        (await alpha.wait(sent.id, { timeoutMs: 30000 })).text ?? "",
        /yes/,
      );
    });
    await t.test(
      "alarm wakes the agent and completes scheduled work",
      async () => {
        const schedule = await request(`/v1/agents/${alpha.id}/schedules`, {
          text: "wake from alarm",
          inSeconds: 0.1,
        });
        assert.ok(schedule.id);
        let history: any[] = [];
        for (let i = 0; i < 200; i++) {
          history = await alpha.history();
          if (JSON.stringify(history).includes("Echo: wake from alarm")) break;
          await delay(50);
        }
        assert.match(JSON.stringify(history), /Echo: wake from alarm/);
        assert.deepEqual(await request(`/v1/agents/${alpha.id}/schedules`), []);
      },
    );
    await t.test(
      "delegate to a durable child and read its independent history",
      async () => {
        const child = await request(`/v1/agents/${alpha.id}/children`, {
          task: "child task",
          key: "child-one",
        });
        assert.match(child.id, /^client_/);
        let result: any;
        for (let i = 0; i < 100; i++) {
          result = await request(
            `/v1/agents/${child.id}/requests/${child.requestId}?wait=1`,
          );
          if (result.state === "completed") break;
          await delay(20);
        }
        assert.equal(result.outcome.result.reply, "Echo: child task");
        assert.match(
          JSON.stringify(await request(`/v1/agents/${child.id}/history`)),
          /child task/,
        );
      },
    );
    await t.test(
      "remote codemode reaches ordered R2-backed tools",
      async () => {
        const r = await alpha.run(
          'code:await tools.write({path:"/workspace/code.txt",content:"remote"}); text(await tools.read({path:"/workspace/code.txt"}));',
          { timeoutMs: 30000 },
        );
        assert.match(r.text ?? "", /remote/);
        assert.equal(
          new TextDecoder().decode(
            (await alpha.files.download("/workspace/code.txt")).data,
          ),
          "remote",
        );
      },
    );
    await t.test(
      "crash after Postgres commit before DO acknowledgement never charges twice",
      async () => {
        const before = await request("/v1/credits");
        await request(
          `/experimental/agents/${alpha.id}/__test/crash-next-settlement`,
          {},
        );
        const result = await alpha.run("charge once", {
          idempotencyKey: "charge-once",
          timeoutMs: 15000,
        });
        assert.equal(result.text, "Echo: charge once");
        let checkpoint: any;
        for (let i = 0; i < 100; i++) {
          checkpoint = await request(
            `/experimental/agents/${alpha.id}/__test/settlement-state`,
          );
          if (checkpoint.crashReached) break;
          await delay(10);
        }
        assert.equal(
          checkpoint.crashReached,
          true,
          "PG commit checkpoint reached before killing workerd",
        );
        assert.equal(checkpoint.pending, 1);
        await fixture.worker.stop(true);
        await fixture.worker.start();
        await request(
          `/experimental/agents/${alpha.id}/__test/flush-billing`,
          {},
        );
        const after = await request("/v1/credits");
        assert.equal(Number(before.balance) - Number(after.balance), 7000);
        assert.equal(Number(after.held), 0);
        await alpha.run("charge once", {
          idempotencyKey: "charge-once",
          timeoutMs: 15000,
        });
        assert.equal(
          Number((await request("/v1/credits")).balance),
          Number(after.balance),
        );
      },
    );
  },
);
