import { Hono } from "hono";
import type { Accounts } from "./accounts.ts";
import type { AgentRef, SessionHooks } from "./client-sessions/state.ts";
import type { ToolDefinition } from "./protocol.ts";
import { errorText } from "./protocol.ts";
import { safeError as safeErrorOf } from "./metrics.ts";
import { valueServer, type ToolServer } from "./tool-servers.ts";
import type { Definitions } from "./definitions.ts";
import { readText } from "./http.ts";
import type { RequestRecord } from "../shared/client-protocol.ts";
import { transaction, type Db } from "./db.ts";
import { underClaim, type Claim, type Ownership } from "./ownership.ts";
import { validFileRef, type FileRef } from "./files.ts";
import type { Input } from "./inputs.ts";
import { network } from "./node-context.ts";
import { decisionsRequest, type DecisionService } from "./decisions.ts";
import {
  Channels as CoreChannels, conversationAgentKey as coreConversationAgentKey, fetchFile as coreFetchFile, SEND_MESSAGE_TOOL, SEND_MESSAGE_WITH_AGENTS_TOOL, sendMessageTarget, TYPING_MAX_MS,
  type ChannelFiles as CoreChannelFiles, type Presented,
} from "./core/channels/channels.ts";

/**
 * Channels on the Node runtime. The shared logic (CRUD, inbound, the item state machine,
 * replies) is src/core/channels/channels.ts, which the Workers backend runs too; this file
 * gives it Postgres, the node's lease and claims, and a scan every few seconds, and adds the
 * public webhook route and the agent hooks (typing, replies, send_message, origin).
 */
export {
  SendError, CHANNEL_FILE_LIMITS, RETIRED_CHANNEL_TYPES, RETIRED_CHANNEL_MESSAGE, sizeText, chunks, askText, answerOf,
  type Sender, type Inbound, type InboundFile, type OutboundFile, type ChannelSettings, type ParseContext, type ChannelProvider,
  type Channel, type ChannelInput,
} from "./core/channels/channels.ts";

export const SEND_MESSAGE: ToolDefinition = { ...SEND_MESSAGE_TOOL, parameters: structuredClone(SEND_MESSAGE_TOOL.parameters) as ToolDefinition["parameters"], exposure: "direct", callers: ["model"] };
const SEND_MESSAGE_WITH_AGENTS: ToolDefinition = { ...SEND_MESSAGE_WITH_AGENTS_TOOL, parameters: structuredClone(SEND_MESSAGE_WITH_AGENTS_TOOL.parameters) as ToolDefinition["parameters"], exposure: "direct", callers: ["model"] };

/**
 * A channel agent that also messages agents (its sub-agents, or its parent) has two send_message tools: the channel's
 * (`feature`) and the agents' (`agents`, multi-agent.ts). One shadowed the other, so this gives it one instead, which
 * the agents' server answers when the call names `to` and the channel's otherwise. Placed first, it takes precedence.
 */
export async function mergedSendMessage(feature: ToolServer, agents: ToolServer | undefined): Promise<ToolServer | undefined> {
  if (!agents || !(await agents.tools()).some(tool => tool.name === "send_message")) return undefined;
  return {
    tools: () => [SEND_MESSAGE_WITH_AGENTS],
    call: call => sendMessageTarget(call.args) === "agent" ? agents.call(call) : feature.call(call),
  };
}

/** A conversation's agent's provisioning key (#692): one copy, in core (`conversationAgentKey` there). */
export const conversationAgentKey = (type: string, channel: string, conversation: string, generation = 0) =>
  coreConversationAgentKey({ type, id: channel }, conversation, generation);

/** Fetch an attachment from a service's file host: never redirected (a token may go with it), within a time limit. */
export const fetchFile = (url: string, headers: Record<string, string> = {}) => coreFetchFile(((input: string, init?: RequestInit) => network().fetch(input, init)) as typeof fetch, url, headers);

export interface ChannelsOptions {
  db: Db; accounts: Accounts; definitions: Definitions; node: string; publicUrl: string;
  providers: Record<string, import("./core/channels/channels.ts").ChannelProvider>;
  /** This node's lease: replies are sent only while it is fresh. */
  ownership?: Ownership;
  createAgent(tenant: string, params: any, key: string): Promise<{ id: string }>;
  /** The id `createAgent` gives the agent for a key, so the conversation is bound before the agent starts. */
  agentId(tenant: string, key: string): string;
  /** Whether the agent still exists and is the tenant's. */
  live(agent: string, tenant: string): Promise<boolean>;
  /** Submit a request to an agent on whichever node serves it. */
  submit(agent: string, tenant: string, request: { id: string; method: string; params: Record<string, unknown> }): Promise<RequestRecord>;
  /** Files in and out of agents' volumes; without it attachments are noted but not saved, and files are not sent. */
  files?: ChannelFiles;
  /** Human input an agent waits on: its pending inputs, oldest first, and answering one (as its sender, who must be allowed to). */
  inputs?: {
    pending(agent: string): Promise<Input[]>;
    answer(agent: string, tenant: string, input: string, answer: { action: "accept" | "decline"; content?: unknown; from: { id: string; name?: string; username?: string } }): Promise<unknown>;
  };
  /** Asks channel filters, billed as POST /v1/decisions; without it a channel cannot have one. */
  decisions?: DecisionService;
  retryBaseMs?: number;
  recheckMs?: number;
}
export interface ChannelFiles {
  /** Save an attachment for request `requestId` in the agent's workspace. */
  upload(agent: string, tenant: string, requestId: string, name: string, source: AsyncIterable<Uint8Array>, contentType?: string): Promise<{ path: string }>;
  /** A file in the agent's mounts, as a reference; rejects paths outside them. */
  ref(agent: string, tenant: string, path: string): Promise<FileRef>;
  read(tenant: string, ref: FileRef): AsyncIterable<Uint8Array>;
  /** A download link to a file in the agent's mounts, lasting as long as links may. */
  link(agent: string, tenant: string, path: string): Promise<string>;
}

export class Channels extends CoreChannels {
  readonly db: Db;
  private readonly typingTimers = new Map<string, ReturnType<typeof setInterval>>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(options: ChannelsOptions) {
    const decisions = options.decisions;
    super({
      sql: options.db, transaction: (work, settings) => transaction(options.db, work, settings), node: options.node, publicUrl: options.publicUrl,
      providers: options.providers,
      keys: { get canStore() { return options.accounts.canStoreKeys; }, seal: (context, text) => options.accounts.seal(context, text), unseal: (context, sealed) => options.accounts.unseal(context, sealed) },
      definitions: options.definitions,
      createAgent: options.createAgent, agentId: options.agentId, live: options.live,
      submit: options.submit,
      ...(options.files ? { files: options.files as unknown as CoreChannelFiles } : {}),
      isFile: validFileRef,
      ...(options.inputs ? { inputs: options.inputs } : {}),
      ...(decisions ? { decisions: {
        available: tenant => decisions.decider.available(tenant, undefined),
        ask: (tenant, request, signal) => decisionsRequest(decisions, tenant, request as Parameters<typeof decisionsRequest>[2], signal),
      } } : {}),
      underClaim: (agent, work) => underClaim(options.db, agent.claim as Claim | undefined, work),
      ...(options.ownership ? { ownership: options.ownership } : {}),
      ...(options.retryBaseMs !== undefined ? { retryBaseMs: options.retryBaseMs } : {}),
      ...(options.recheckMs !== undefined ? { recheckMs: options.recheckMs } : {}),
      safeError: safeErrorOf,
      // A sub-agent's notice (request child_<its request>): the run of the parent that started it.
      parentRun: async (agent, run) => (await options.db.query("select parent_run from agent_children where tenant = $1 and parent = $2 and request_id = $3",
        [agent.tenant, agent.id, run.id.slice("child_".length)])).rows[0]?.parent_run as string | undefined,
    });
    this.db = options.db;
  }

  start(intervalMs = 5_000) {
    this.timer ??= setInterval(() => void this.scan().catch(error => console.error(JSON.stringify({ type: "channel_scan_failed", error: errorText(error) }))), intervalMs);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const timer of this.typingTimers.values()) clearInterval(timer);
    this.typingTimers.clear();
  }

  /** Public webhooks, mounted before any authentication: each request proves itself with the channel's secret. */
  readonly app = new Hono().post("/channels/:type/:id", async c => {
    const answer = await this.webhook(c.req.param("type"), c.req.param("id"), c.req.raw.headers, max => readText(c.req.raw.body, max));
    return answer.json ? c.json(answer.json, answer.status as 200) : c.body(null, answer.status as 200);
  });

  readonly hooks: SessionHooks = {
    runStarted: (agent, record) => {
      if (record.method !== "prompt" && record.method !== "resume") return;
      if (this.typingTimers.has(agent.id)) return;
      void this.typing(agent.id).then(typing => {
        if (!typing || this.typingTimers.has(agent.id)) return;
        const show = () => void typing.show().catch(() => {});
        // The service clears the indicator after a few seconds; keep it up while the turn runs.
        const timer = setInterval(show, typing.every);
        timer.unref();
        this.typingTimers.set(agent.id, timer);
        setTimeout(() => this.stopTyping(agent.id, timer), TYPING_MAX_MS).unref();
        show();
      }).catch(() => {});
    },
    runEnded: (agent, record) => {
      this.stopTyping(agent.id);
      if (record.method !== "prompt" && record.method !== "resume") return;
      void this.settle(agent, record).catch(error => console.error(JSON.stringify({ type: "channel_reply_failed", agent: agent.id, request: record.id, error: safeErrorOf(error) })));
    },
    // A channel's agents get send_message, for updates before the final reply.
    server: async agent => {
      const binding = await this.binding(agent.id);
      return binding && valueServer([SEND_MESSAGE], async ({ args, run }) => this.sendMessage(agent, args, run));
    },
    origin: (agent: AgentRef, requestId?: string) => this.origin(agent, requestId),
  };

  private stopTyping(agent: string, only?: ReturnType<typeof setInterval>) {
    const timer = this.typingTimers.get(agent);
    if (!timer || (only && timer !== only)) return;
    clearInterval(timer);
    this.typingTimers.delete(agent);
  }
}

export type { Presented };
