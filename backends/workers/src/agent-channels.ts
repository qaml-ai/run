import type { ToolRegistration } from "@earendil-works/pi-durable";
import { SEND_MESSAGE_TOOL, TYPING_MAX_MS, type ChannelRun } from "../../../src/core/channels/channels.ts";
import type { Env } from "./agent-types.ts";
import { workerChannels } from "./channels.ts";
import { safeError } from "./observability.ts";

type Owner = { id: string; tenantId: string; config: { type?: string } };
type Run = { id: string; method: string; state: string; outcome?: { result?: unknown; error?: unknown } };
const REPLYING = new Set(["prompt", "resume"]);

/**
 * A channel agent's side of its conversation (src/core/channels): while a turn runs its
 * service shows a typing indicator, and when it ends the reply goes to the conversation from
 * here, through the service's API. Only agents a channel made (type "channel") do any of it.
 * A reply that is not settled here (the object was evicted mid-send) is found by the channel's
 * own re-check of the message, so it is sent once all the same.
 */
export class AgentChannels {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;
  private typing?: { timer: ReturnType<typeof setInterval>; until: ReturnType<typeof setTimeout> };

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  private channels() { return workerChannels(this.env, work => this.ctx.waitUntil(work)); }

  /** For a sub-agent's notice (request child_…), the sub-agent: its outbox entry (delegation-notifications.ts) names it. */
  private async notifier(request: string): Promise<string | undefined> {
    if (!request.startsWith("child_")) return undefined;
    const notices = await this.ctx.storage.list<{ request?: { id?: string }; notice?: { source?: { agentId?: string } } }>({ prefix: "delegation-notice:" });
    for (const pending of notices.values()) if (pending.request?.id === request) return pending.notice?.source?.agentId;
    return undefined;
  }

  /** An event the agent committed: a turn's start shows typing, its end settles the reply. */
  observe(owner: Owner | undefined, event: { type?: string; event?: { type?: string } }, record: Run | undefined) {
    if (owner?.config.type !== "channel" || !record) return;
    if (event.type === "event" && event.event?.type === "agent_start" && REPLYING.has(record.method)) this.startTyping(owner.id);
    if (event.type !== "response") return;
    this.stopTyping();
    if (!REPLYING.has(record.method)) return;
    const run: ChannelRun = { id: record.id, method: record.method, state: "completed", ...(record.outcome ? { outcome: record.outcome } : {}) };
    this.ctx.waitUntil(this.notifier(record.id).then(agentId => agentId ? { ...run, metadata: { agentId } } : run)
      .then(settled => this.channels().then(channels => channels.settle({ id: owner.id, tenant: owner.tenantId }, settled)))
      .catch(error => console.error(JSON.stringify({ type: "channel_reply_failed", agent: owner.id, request: record.id, error: safeError(error) }))));
  }

  private startTyping(agent: string) {
    if (this.typing) return;
    const started = this.channels().then(channels => channels.typing(agent)).then(typing => {
      if (!typing || this.typing) return;
      const show = () => void typing.show().catch(() => {});
      // The service clears the indicator after a few seconds; keep it up while the turn runs.
      this.typing = { timer: setInterval(show, typing.every), until: setTimeout(() => this.stopTyping(), TYPING_MAX_MS) };
      show();
    }).catch(() => {});
    this.ctx.waitUntil(started);
  }

  private stopTyping() {
    if (!this.typing) return;
    clearInterval(this.typing.timer);
    clearTimeout(this.typing.until);
    this.typing = undefined;
  }

  /** send_message, for a channel's agents: updates and files before the final reply. */
  tool(agent: () => Promise<{ id: string; tenantId: string }>, run?: (api: unknown) => Promise<string | undefined>): ToolRegistration {
    return {
      name: SEND_MESSAGE_TOOL.name, description: SEND_MESSAGE_TOOL.description,
      parameters: structuredClone(SEND_MESSAGE_TOOL.parameters) as never,
      callers: ["model"], replay: "unsafe",
      execute: async (args: Record<string, unknown>, api: unknown) => {
        const owner = await agent();
        const sent = await (await this.channels()).sendMessage({ id: owner.id, tenant: owner.tenantId }, args ?? {}, await run?.(api));
        return { output: [{ type: "text", text: JSON.stringify(sent) }] };
      },
    } as ToolRegistration;
  }

  /** What a tool call of this agent's run is told of where it came from: the channel, the conversation and the sender. */
  async origin(owner: { id: string; tenantId: string }, requestId?: string) {
    return (await this.channels()).origin({ id: owner.id, tenant: owner.tenantId }, requestId);
  }
}
