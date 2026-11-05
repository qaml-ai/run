import { contractTest, OPERATOR, OTHER_OPERATOR, free, lastUser, toolCall, toolResults, until, sleep, listen, watchEvents, type T } from '../support.ts';
import type { ContractFixture, ModelReply } from '../fixture.ts';

async function useFixture(f: ContractFixture, respond?: ModelReply, _env?: Record<string,string>, _tenants?: object) { if(respond) f.setModel(respond); return f; }

import assert from "node:assert/strict";

import { AgentRuntime } from "../../../clients/typescript.ts";

const text = (message: any) => message?.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("") ?? "";

const updates = (frames: { data: any }[]) => frames.filter(frame => frame.data.type === "event" && frame.data.event.type === "message_update").map(frame => frame.data.event);

const deltaText = (frames: { data: any }[]) => updates(frames).filter(event => event.assistantMessageEvent.type === "text_delta").map(event => event.assistantMessageEvent.delta).join("");

contractTest("streaming", "tests/stream-deltas.test.ts:132", "a tool call's updates are Pi's, less the message: toolcall_start names the call, toolcall_end carries it", async (t, f) => {
  const r = await useFixture(f, (_body, index) => index === 0 ? toolCall("codemode", { code: "return 1" }) : { content: "done" });
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const watcher = await watchEvents(t, `${r.base}/v1/agents/${agent}/events`, { Authorization: `Bearer ${OPERATOR}` }, { query: "" });
  const done = await r.prompt(agent, "go");
  await until(() => watcher.frames.some(frame => frame.data.type === "response" && frame.data.id === done.id), "the outcome");
  const calls = updates(watcher.frames).map(event => event.assistantMessageEvent).filter(delta => delta.type.startsWith("toolcall_"));
  // The call's id and name, which Pi's start carries only in the message, as fields of their own: never as a toolCall
  // (a consumer that reads toolcall_start's toolCall, like chiridion's relay, would take it for a whole call).
  assert.deepEqual(calls.find(delta => delta.type === "toolcall_start"), { type: "toolcall_start", contentIndex: 0, id: "call_codemode", name: "codemode" });
  assert.equal(calls.find(delta => delta.type === "toolcall_end").toolCall.name, "codemode");
  for (const delta of updates(watcher.frames).map(event => event.assistantMessageEvent)) assert.equal(delta.partial ?? delta.message ?? delta.error, undefined);

});
