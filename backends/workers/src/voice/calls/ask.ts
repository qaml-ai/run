import type { Env } from "../../agent-types.ts";
import { followEvents } from "../../event-follow.ts";
import { askPrompt } from "./prompts.ts";
import type { VoiceCall } from "./schema.ts";

export async function streamVoiceReply(env: Env, call: VoiceCall, ask: { n: number; started: number; request: string },
  lines: string[], payer: { endUser?: string; bucket?: string }, signal: AbortSignal):
  Promise<{ outcome: "ok" | "empty" | "error" | "timeout"; reply: string }> {
  if (!ask.request.trim()) return { outcome: "empty", reply: "" };
  const id = `voice_${call.id.slice(3)}_ask_${ask.started.toString(36)}_${ask.n}`;
  const agent = env.AGENTS.getByName(call.agent);
  const prefix = lines.length ? `[What was said in the call since your last request (speakers not labeled)]\n${lines.join("\n")}\n\n` : "";
  const stop = new AbortController();
  const watch = AbortSignal.any([signal, stop.signal]);
  let reply = "";
  try {
    await followEvents({ fetch: (url, init) => agent.fetch(new Request(url, init)), events: `https://agent/events?watch=1&runId=${id}` }, {
      push(item) {
        if (item.kind !== "event") return;
        const event = item.data as { type?: string; assistantMessageEvent?: { type?: string; delta?: string } };
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta")
          reply += event.assistantMessageEvent.delta?.slice(0, 4000 - reply.length) ?? "";
      },
    }, watch);
    watch.throwIfAborted();
    let response = await agent.fetch(new Request("https://agent/requests", {
      method: "POST", signal: watch, body: JSON.stringify({ id, method: "prompt", params: {
        text: prefix + askPrompt(ask.request), metadata: { voiceCall: call.id, via: "voice" }, allowDisconnected: true, ...payer,
      } }),
    }));
    while (response.ok) {
      const record = await response.json<{ state: string; outcome?: { error?: string; result?: { reply?: string; error?: string } } }>();
      if (record.state === "completed") {
        if (record.outcome?.error || record.outcome?.result?.error) break;
        return { outcome: "ok", reply: (record.outcome?.result?.reply ?? reply).slice(0, 4000).trim() };
      }
      watch.throwIfAborted();
      response = await agent.fetch(new Request(`https://agent/requests/${id}?wait=25`, { signal: watch }));
    }
  } catch {
    // The call's alarm owns the late deadline.
  } finally {
    stop.abort();
  }
  return { outcome: signal.aborted ? "timeout" : "error", reply: "" };
}
