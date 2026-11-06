import assert from "node:assert/strict";
import test from "node:test";
import { createWorkersFixture } from "../../../tests/contract/fixtures/workers.ts";
import { toolCall, until } from "../../../tests/contract/http.ts";

const text = (message: any) => typeof message?.content === "string" ? message.content
  : (message?.content ?? []).map((part: any) => part.text ?? "").join("");
const roleText = (body: any) => body.messages.filter((message: any) =>
  message.role === "system" || message.role === "developer" || message.role === "user").map(text).join("\n");

test("an idle parent drains a child notification queued behind its completed turn without polling", { timeout: 60000 }, async t => {
  const work = Promise.withResolvers<void>(), busy = Promise.withResolvers<void>(), busyStarted = Promise.withResolvers<void>();
  t.after(() => { work.resolve(); busy.resolve(); });
  const r = await createWorkersFixture(t, { respond: body => {
    if (roleText(body).includes("WORKER")) return { role: "assistant", content: "worked", wait: work.promise };
    if (body.messages.at(-1).role === "tool") return { role: "assistant", content: "spawned" };
    const input = text(body.messages.findLast((message: any) => message.role === "user"));
    if (input.startsWith("<agent_notification")) return { role: "assistant", content: "heard" };
    if (input === "busy") { busyStarted.resolve(); return { role: "assistant", content: "busy done", wait: busy.promise }; }
    return toolCall("spawn_agent", { instructions: "You are WORKER.", task: "work" }, "call_spawn");
  } });
  const parent = (await r.call("/v1/agents", { body: { builtins: ["agents"], delegate: { instructions: true } } })).json.id;
  await r.prompt(parent, "spawn");
  assert.equal((await r.call(`/v1/agents/${parent}/prompt`, { body: { text: "busy" } })).status, 202);
  await busyStarted.promise;
  work.resolve();
  await until(async () => (await r.call(`/v1/agents/${parent}`)).json.requests.some((request: any) =>
    request.id.startsWith("child_") && request.state === "running"), "the child notification to queue");

  busy.resolve();
  // The provider is local to the fixture. Inspecting its observed calls cannot
  // wake the parent; only the durable watchdog can drain the queued notice.
  await until(() => r.model.bodies.some((body: any) => text(body.messages.findLast((message: any) =>
    message.role === "user")).startsWith("<agent_notification")), "the idle parent to consume its queued notification");
  const notice = await until(async () => (await r.call(`/v1/agents/${parent}`)).json.requests.find((request: any) =>
    request.id.startsWith("child_") && request.state === "completed"), "the notification to complete");
  assert.equal(notice.outcome.result.reply, "heard");
});
