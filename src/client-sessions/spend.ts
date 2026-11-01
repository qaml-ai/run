import { randomUUID } from "node:crypto";
import { safeError } from "../metrics.ts";
import { END_USER_CREDIT } from "../model-attempt.ts";
import { creditError, DEFAULT_BUCKET, MICROS, type CreditHold } from "../end-user-credits.ts";
import { durableEntryMessages } from "../pi-durable/agent.ts";
import type { RunLimits, RunStop } from "../protocol.ts";
import { errorText } from "../protocol.ts";
import { usageCost } from "../webhooks.ts";
import type { AgentSupervisor } from "../supervisor.ts";
import { platformUsage, usageMissing } from "../platform-pricing.ts";
import type { CommitEffect } from "../../shared/append-log.ts";
import type { RequestRecord } from "../../shared/client-protocol.ts";
import { errorStatus, HttpError } from "../http.ts";
import type { Db } from "../db.ts";
import type { Sources } from "../tool-sources.ts";
import type { ToolServer } from "../tool-servers.ts";
import type { CodeLimits } from "../codemode.ts";
import { AUDIO_LIMITS, CODE_LIMITS, TOOL_FILE_LIMITS } from "../limits.ts";
import { ToolFiles } from "../tool-files.ts";
import { essence, type FileRef } from "../files.ts";
import { checkedAudio } from "../transcription.ts";
import { GENERATE_IMAGE, generateImage } from "../images.ts";
import { DECIDE, DECISION_MODEL, decideTool } from "../decisions.ts";
import { toolJudge, UNJUDGED, type Judge } from "../tool-judge.ts";
import type { ToolContext } from "../volume-tools.ts";
import { type Session, type ClientSessionOptions, type UsageRecord, type Refusal, type SpendLimit, RUN_METHODS, MODEL_RUNS, runningRun } from "./state.ts";

export type SpendContext = {
  options: ClientSessionOptions;
  sessions: Map<string, Session>;
  apiKey(session: Session, provider: string, keyScope: string | undefined): Promise<{ key?: string; platform: boolean }>;
  db: Db;
  supervisor: AgentSupervisor;
  counted(session: Session, cost: number): void;
  spent(session: Session, cost: number): void;
  agentSpendLimit(session: Session): Promise<string | undefined>;
  toolContext(session: Session): ToolContext;
  spendOf(session: Session): Promise<SpendLimit | null>;
  spendWrite(session: Session, cost: number): CommitEffect | undefined;
};

/** `spendLimit` as given: `{usd}`, or null to remove it. */
export function spendInput(value: unknown): number | null {
  if (value === null) return null;
  const usd = (value as { usd?: unknown } | undefined)?.usd;
  if (!value || typeof value !== "object" || Object.keys(value).some(key => key !== "usd") || typeof usd !== "number" || !Number.isFinite(usd) || usd < 0 || usd > 1_000_000) {
    throw new HttpError(400, "spendLimit must be {usd} with usd a number from 0 to 1000000, or null");
  }
  return usd;
}
/** How long an end user's charge for a tool call (`endUserCharge`) is retried through a database outage. */
export const END_USER_CHARGE_RETRY_MS = 5 * 60_000;
export const dollars = (usd: number) => `$${Number(usd.toFixed(6))}`;
/** The runtime's default maximums for one run, which an agent's own `runLimits` may lower (ClientSessionsOptions.runLimitsFor). */
export const RUN_LIMITS: Readonly<Required<Pick<RunLimits, "maxResponses" | "maxSeconds">>> = Object.freeze({ maxResponses: 1_000, maxSeconds: 2 * 3_600 });
/** An admin tenant's run backstop, unless its entry sets its own: a runaway's, not a long run's (see node-config.ts). */
export const ADMIN_RUN_LIMITS: Readonly<Required<Pick<RunLimits, "maxResponses" | "maxSeconds">>> = Object.freeze({ maxResponses: 1_000, maxSeconds: 4 * 3_600 });
export const duration = (seconds: number) => {
  const [count, unit] = seconds % 3_600 === 0 ? [seconds / 3_600, "hour"] : seconds % 60 === 0 ? [seconds / 60, "minute"] : [seconds, "second"];
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
};
/** A model response's cost as the runtime counts it. */
export const responseCost = (usage: any) => usageCost(usage).usd;
/** A model response that is billed, and counted against spend limits: one the provider completed, with usage. */
export const billed = (message: any) => message?.role === "assistant" && !!message.usage && (message.stopReason !== "error" || !!message.usage.billingAttemptId);
/**
 * How a limit's refusal of a run (a 402 of `runLimit`) ends it, said as a stop at that limit mid-run is: so a run refused
 * as it left the queue, one stopped between steps and a notification's turn refused as it landed all carry the same
 * `code` and fields. End-user credit: `end_user_credit`, with why (`reason`), whose (`endUser`) and which `bucket`; the
 * agent's or the tenant's spend limit, or the tenant's spent credit: `spend_limit`, with which (`limit`). Undefined: not
 * a limit's refusal.
 */
export function refusalStop(error: unknown): (Omit<RunStop, "message" | "stopped"> & { stopped: "spend_limit"; code: string }) | undefined {
  if (!(error instanceof HttpError) || error.status !== 402) return undefined;
  if (error.code === "END_USER_CREDIT") {
    const { reason, bucket, endUser } = error.details ?? {};
    return { stopped: "spend_limit", code: END_USER_CREDIT, limit: "end_user", ...(typeof reason === "string" ? { reason } : {}), ...(typeof bucket === "string" ? { bucket } : {}), ...(typeof endUser === "string" ? { endUser } : {}) };
  }
  const limit = (error as { stopLimit?: RunStop["limit"] }).stopLimit;
  if (error.code === "SPEND_LIMIT") return { stopped: "spend_limit", code: "spend_limit", ...(limit ? { limit } : {}) };
  if (error.code === "INSUFFICIENT_CREDIT") return { stopped: "spend_limit", code: "spend_limit", limit: "credit" };
  return undefined;
}

/**
 * The generate_image tool of an agent whose sources enable it, answered here rather than by a tool source: its image is
 * billed like a model response, with the run's facts, and counts against the agent's spend limit and the run's.
 */
export function imageServer(ctx: SpendContext, session: Session, sources: Sources | undefined): ToolServer | undefined {
  const { imager, volumes } = ctx.options;
  if (!imager || !sources?.builtins?.includes("generate_image")) return undefined;
  // What the run's calls may still save to the workspace, as for any tool's outputs.
  let saving = { id: undefined as string | undefined, left: TOOL_FILE_LIMITS.runBytes };
  return {
    returnsFiles: true,
    tools: () => [GENERATE_IMAGE],
    sources: async () => [{ kind: "builtin", name: "generate_image", status: "listed", tools: [GENERATE_IMAGE] }],
    call: async call => {
      if (call.name !== "generate_image") throw new Error(`Unknown tool ${call.name}`);
      const { header } = session;
      const mounts = header.mounts ?? [];
      if (!volumes || !mounts.length) throw new Error("generate_image needs a workspace to save the image in, and this agent has none");
      const run = runningRun(session);
      if (call.run !== saving.id) saving = { id: call.run, left: TOOL_FILE_LIMITS.runBytes };
      const files = new ToolFiles({ volumes, tenant: header.tenant, agent: header.id, mounts, tool: "generate_image", run: saving, onWrite: ctx.toolContext(session).onWrite });
      const budget = run ? await budgetLeft(ctx, session, run.id) : undefined;
      const { identity, keyScope } = header;
      return generateImage(imager, {
        tenant: header.tenant, ...(keyScope ? { keyScope } : {}), ...(budget !== undefined ? { budget } : {}), files,
        hold: usd => endUserHold(ctx, session, run, usd, "image"),
        record: usage => {
          const cost = usage.usage.cost.total as number;
          ctx.options.onUsage?.(header.tenant, header.id, { ...usage, ...(run ? { requestId: run.id } : {}), ...(run?.actor ? { actor: run.actor } : {}), ...(identity ? { identity } : {}), ...(keyScope ? { keyScope } : {}) });
          ctx.spent(session, cost);
          if (run && cost > 0) (session.imageSpend ??= new Map()).set(run.id, (session.imageSpend.get(run.id) ?? 0) + cost);
        },
      }, call.args, call.signal);
    },
  };
}

/**
 * The decide tool, answered here rather than by a tool source: its decisions are billed like a model response, with the
 * run's facts, and count against the agent's spend limit and the run's. Every agent's unless its sources opt out
 * (`decide: false`), or it is `plain` (no js_exec, no tools of its own) and did not ask (`decide: true`). Not offered
 * where it could only fail: no OpenRouter key decisions could use (the tenant's own, its key scope's or the platform's),
 * or an agent that denies data collection while the provider cannot pass that on.
 */
export function decisionServer(ctx: SpendContext, session: Session, sources: Sources | undefined, plain = false): ToolServer | undefined {
  const { decider } = ctx.options;
  if (!decider || sources?.decide === false || (plain && sources?.decide !== true)) return undefined;
  if (session.header.config.dataCollection === "deny" && !decider.options.provider.dataPolicy) return undefined;
  const offered = async () => await decider.available(session.header.tenant, session.header.keyScope) ? [DECIDE] : [];
  return {
    tools: offered,
    sources: async () => { const tools = await offered(); return tools.length ? [{ kind: "builtin", name: "decide", status: "listed", tools }] : []; },
    call: async call => {
      if (call.name !== "decide") throw new Error(`Unknown tool ${call.name}`);
      const { header } = session;
      const run = runningRun(session);
      const budget = run ? await budgetLeft(ctx, session, run.id) : undefined;
      const { identity, keyScope } = header;
      return decideTool(decider, {
        tenant: header.tenant, ...(keyScope ? { keyScope } : {}), ...(budget !== undefined ? { budget } : {}), ...(header.config.dataCollection ? { dataCollection: header.config.dataCollection } : {}),
        hold: usd => endUserHold(ctx, session, run, usd, "decision"),
        record: usage => {
          const cost = usage.usage.cost.total as number;
          ctx.options.onUsage?.(header.tenant, header.id, { ...usage, ...(run ? { requestId: run.id } : {}), ...(run?.actor ? { actor: run.actor } : {}), ...(identity ? { identity } : {}), ...(keyScope ? { keyScope } : {}) });
          ctx.spent(session, cost);
          if (run && cost > 0) (session.decisionSpend ??= new Map()).set(run.id, (session.decisionSpend.get(run.id) ?? 0) + cost);
        },
      }, call.args, call.signal);
    },
  };
}

/**
 * The judge a source's `judged` approval policy asks before a call (tool-judge.ts): the decisions service's model, with
 * the run's own facts, billed as a decision is and counted against the agent's spend limit and the run's. `undefined` when
 * the node has no decisions service; its judged calls then ask the person, as they do when the judge cannot answer.
 */
export function judgeFor(ctx: SpendContext, session: Session): Judge | undefined {
  const { decider } = ctx.options;
  if (!decider) return undefined;
  // The scope and the data policy are read when a call is judged, not when the agent's tools were built: a live
  // configure can change either without rebuilding them, and a judge built with the old data policy would send a call
  // the agent has since refused to send (`src/client-sessions/configuration.ts` writes the header after the rebuild).
  return (input, signal) => {
    const { header } = session;
    const { identity, keyScope } = header;
    // An agent that denies data collection, where the provider cannot pass that on: nothing is sent, and its judged calls
    // ask the person. `decide` refuses this too (decisions.ts), but only after a budget read and a credit hold.
    if (header.config.dataCollection === "deny" && !decider.options.provider.dataPolicy) return Promise.resolve({ ...UNJUDGED, reason: "unjudgeable" });
    return toolJudge(decider, {
      tenant: header.tenant, ...(keyScope ? { keyScope } : {}), ...(header.config.dataCollection ? { dataCollection: header.config.dataCollection } : {}),
      budget: async () => { const run = runningRun(session); return run ? budgetLeft(ctx, session, run.id) : undefined; },
      // As a decide call: when an end user pays, their credit holds the judge's estimate and settles what it cost.
      hold: usd => endUserHold(ctx, session, runningRun(session), usd, "decision"),
      record: usage => {
        const run = runningRun(session);
        const cost = usage.usage.cost.total as number;
        ctx.options.onUsage?.(header.tenant, header.id, { ...usage, ...(run ? { requestId: run.id } : {}), ...(run?.actor ? { actor: run.actor } : {}), ...(identity ? { identity } : {}), ...(keyScope ? { keyScope } : {}) });
        ctx.spent(session, cost);
        if (run && cost > 0) (session.decisionSpend ??= new Map()).set(run.id, (session.decisionSpend.get(run.id) ?? 0) + cost);
      },
      // A judge that could not answer says so once: the call then asks the person, and is not retried here.
      onError: error => console.log(JSON.stringify({ type: "tool_judge_failed", tenant: header.tenant, agent: header.id, provider: decider.provider, error: safeError(error) })),
      // What it decided, for counting denials and asks. Never the request, the arguments or the answer.
      onJudged: (input, judged) => console.log(JSON.stringify({ type: "tool_judged", tenant: header.tenant, agent: header.id, provider: decider.provider, model: DECISION_MODEL,
        tool: input.tool, decision: judged.decision, risk: judged.risk, ...(judged.reason ? { reason: judged.reason } : {}) })),
    })(input, signal);
  };
}

/**
 * A message's attached audio, transcribed (`transcriber`): each file it asks to (`transcribe: true`), and by default each
 * whose content type is audio/*. Files are checked (format, length, the message's limits) and their cost weighed against
 * the run's own budget and the agent's spend limit before any is sent; each transcription is billed like a model
 * response, with the run's facts, and counts against the agent's spend limit. A file asked for that cannot be
 * transcribed refuses the message; one transcribed by default is attached without a transcript instead, with why
 * (`untranscribed`), so a voice note from a channel still reaches the agent. A spend limit refuses either way. Files
 * come back with their transcript and (`cost`) what it cost, for the run's budget; the rest as they were.
 */
export async function transcribeAttached(ctx: SpendContext, session: Session, requestId: string, files: (FileRef & { transcribe?: boolean })[], run: { actor?: string; budget?: number; bucket?: string }): Promise<(FileRef & { cost?: number })[]> {
  const plain = files.map(({ transcribe: _transcribe, ...file }) => file as FileRef & { cost?: number });
  let chosen = files.flatMap((file, index) => file.transcribe ?? essence(file.contentType).startsWith("audio/") ? [index] : []);
  if (!chosen.length) return plain;
  /** A file that cannot be transcribed: the message is refused if it asked, else the file goes without. */
  const failed = (index: number, error: unknown) => {
    if (files[index].transcribe || errorStatus(error, 500) === 402) throw error;
    plain[index] = { ...plain[index], untranscribed: errorText(error).slice(0, 300) };
  };
  const transcriber = ctx.options.transcriber;
  if (!transcriber) {
    for (const index of chosen) failed(index, new HttpError(400, "Transcription is not enabled on this runtime"));
    return plain;
  }
  const tenant = session.header.tenant;
  const audio: { index: number; bytes: Uint8Array; header: ReturnType<typeof checkedAudio> }[] = [];
  let seconds = 0;
  for (const [position, index] of chosen.entries()) {
    const file = plain[index];
    try {
      if (position >= AUDIO_LIMITS.files) throw new HttpError(413, `At most ${AUDIO_LIMITS.files} audio files are transcribed for a message`, "AUDIO_TOO_LONG");
      if (file.size > AUDIO_LIMITS.fileBytes) checkedAudio(new Uint8Array(file.size), file.path);
      const bytes = await ctx.options.volumes!.readRange(tenant, file, 0, file.size);
      const header = checkedAudio(bytes, file.path);
      if (seconds + header.seconds > AUDIO_LIMITS.messageSeconds) throw new HttpError(413, `At most ${AUDIO_LIMITS.messageSeconds} seconds of audio are transcribed for a message`, "AUDIO_TOO_LONG");
      seconds += header.seconds;
      audio.push({ index, bytes, header });
    } catch (error) { failed(index, error); }
  }
  const spend = await ctx.spendOf(session);
  const left = spend ? spend.usd - spend.spent : Infinity;
  const budget = Math.min(run.budget ?? Infinity, left);
  const estimate = audio.reduce((total, { header }) => total + transcriber.cost(header.seconds), 0);
  if (estimate > budget) throw new HttpError(402, `Transcribing this message's audio costs about $${estimate.toFixed(4)}, more than the $${Math.max(0, budget).toFixed(4)} left of ${budget === left ? "this agent's" : "this run's"} spend limit`, "SPEND_LIMIT");
  const { identity, keyScope } = session.header;
  const facts = { requestId, ...(run.actor ? { actor: run.actor } : {}), ...(identity ? { identity } : {}), ...(keyScope ? { keyScope } : {}) };
  // Its end user's credit holds the estimate before any audio is sent, and pays what the transcripts cost.
  const held = audio.length ? await endUserHold(ctx, session, { id: requestId, ...(run.bucket ? { bucket: run.bucket } : {}) } as RequestRecord, estimate, "transcription") : undefined;
  let total = 0;
  const done = await Promise.allSettled(audio.map(async ({ index, bytes, header }) => {
    try {
      const { transcript, usage } = await transcriber.transcribe({ tenant, ...(keyScope ? { keyScope } : {}) }, { bytes, header }, {}, AbortSignal.timeout(AUDIO_LIMITS.timeoutMs + 10_000));
      const cost = usage.usage.cost.total as number;
      ctx.options.onUsage?.(tenant, session.header.id, { ...usage, ...facts });
      ctx.spent(session, cost);
      total += cost;
      plain[index] = { ...plain[index], transcript, cost };
    } catch (error) { failed(index, error); }
  }));
  await held?.settle(total);
  const refused = done.find(result => result.status === "rejected");
  if (refused) throw (refused as PromiseRejectedResult).reason;
  return plain;
}

/** Count a model response's usage toward the webhook event of its run's end. */
export function tally(session: Session, requestId: string, usage: any) {
  const total = (session.usage ??= new Map()).get(requestId) ?? { responses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
  session.usage.set(requestId, {
    responses: total.responses + 1, input: total.input + (usage.input ?? 0), output: total.output + (usage.output ?? 0),
    cacheRead: total.cacheRead + (usage.cacheRead ?? 0), cacheWrite: total.cacheWrite + (usage.cacheWrite ?? 0), costUsd: total.costUsd + responseCost(usage),
  });
}

/** A connected ChatGPT subscription needs no end-user credit to start or continue model calls. */
export function modelPayer(ctx: SpendContext, session: Session, run: RequestRecord | undefined): { id: string; bucket: string } | undefined {
  return session.header.config.model.api === "openai-codex-responses" ? undefined : payer(ctx, session, run);
}

/**
 * Who pays for the agent's work, and from which bucket: its subject (an end user of the tenant's), from the running
 * run's own bucket, else the agent's, else the default. Undefined for an agent with no subject: its tenant pays.
 */
export function payer(ctx: SpendContext, session: Session, run: RequestRecord | undefined): { id: string; bucket: string } | undefined {
  const id = session.header.identity?.subject;
  return id === undefined || !ctx.options.endUsers ? undefined : { id, bucket: bucketOf(ctx, session, run) };
}

/**
 * The bucket a run of the agent spends from: its own, else the agent's, else the one the tenant's latest run of it named
 * (`runBucket`), so a run the runtime starts (a schedule's, a sub-agent's notice, a channel's or a voice session's
 * message) spends where the agent's do. Only with none of them the default, said once per load for a tenant that meters.
 */
export function bucketOf(ctx: SpendContext, session: Session, run: Pick<RequestRecord, "bucket"> | undefined): string {
  const bucket = run?.bucket ?? session.header.bucket ?? session.header.runBucket;
  if (bucket !== undefined) return bucket;
  if (!session.defaultBucketSaid && session.header.identity?.subject !== undefined && ctx.options.endUsers) {
    session.defaultBucketSaid = true;
    const { tenant, id: agent } = session.header;
    // A metered agent's run named no bucket, nor did the agent or any run of it.
    void ctx.options.endUsers.enabled(tenant).then(metered => {
      if (metered) console.warn(JSON.stringify({ type: "end_user_default_bucket", tenant, agent }));
    }, () => {});
  }
  return DEFAULT_BUCKET;
}

/**
 * Hold `usd` of its end user's credit for work of the agent's that is not a model call (audio to transcribe, an image),
 * before it is sent: a refusal is a 402 END_USER_CREDIT. Settle it with what the work cost, or release it if none was
 * done. Undefined when nobody's credit is metered.
 */
export async function endUserHold(ctx: SpendContext, session: Session, run: RequestRecord | undefined, usd: number, call: string): Promise<CreditHold | undefined> {
  const user = payer(ctx, session, run);
  return user && ctx.options.endUsers?.hold(session.header.tenant, user.id, user.bucket, usd, call, { agent: session.header.id, ...(run ? { requestId: run.id } : {}) });
}

export async function refreshSpend(ctx: SpendContext, session: Session) {
  if (!session.spend) return;
  session.spend = undefined;
  const spend = await ctx.spendOf(session);
  if (spend) spend.spent += session.unwritten ?? 0;
}

/**
 * A response's usage as it is billed: on a platform key of a tenant that pays for it, priced from the runtime's catalog,
 * never from the agent's stored model; one that reported no usage, or was cut short, is charged an estimate (the
 * host's input estimate and `chars` streamed, at two a token), and logged. An unbilled tenant's (an admin tenant's) is
 * as the provider reported it, as its usage events say.
 */
export function billable(ctx: SpendContext, session: Session, usage: any, provider: string, model: string, estimate?: { chars: number; completed: boolean }, quiet = false) {
  if (!session.platformKey || !session.catalogPriced) return usage;
  const priced = platformUsage(usage, provider, model, estimate && { ...estimate, inputTokens: usage?.estimatedInputTokens });
  if (!quiet && (priced.estimated || !priced.known)) {
    console.log(JSON.stringify({ type: "platform_usage_untrusted", tenant: session.header.tenant, agent: session.header.id, provider, model, estimated: priced.estimated, known: priced.known, aborted: !!estimate && !estimate.completed, reportedOutputTokens: usage?.output ?? 0, billedOutputTokens: priced.usage.output ?? 0, usd: priced.usage.cost.total }));
  }
  return priced.usage;
}

/**
 * A compaction summary's usage, billed like a response: to the tenant (`onUsage`, kind compaction) and against the
 * agent's spend limit. One made in the background belongs to no run (`run` has no requestId). Returns the usage billed.
 */
export function compactionUsage(ctx: SpendContext, session: Session, event: any, run: Record<string, unknown>) {
  const usage = billable(ctx, session, event.usage, event.provider, event.model, usageMissing(event.usage) ? { chars: Number(event.chars) || 0, completed: true } : undefined);
  // Responses through the tenant's own endpoint count under it: `chiridion/openrouter/<model>`.
  const via = endpoint(ctx, session) ? `${session.header.config.model.provider}/` : "";
  ctx.options.onUsage?.(session.header.tenant, session.header.id, { ...event, usage, ...run, provider: via + event.provider, kind: "compaction", platform: !!session.platformKey,
    ...(event.durable && ctx.supervisor.options.db ? { durableReceipt: true } : {}) });
  if (event.durable && ctx.supervisor.options.db) ctx.counted(session, responseCost(usage));
  else ctx.spent(session, responseCost(usage));
  return usage;
}

/** A billed model response's usage, as `billable` prices it. `quiet`: logged already, or to be. */
export function responseUsage(ctx: SpendContext, session: Session, message: any, quiet = false) {
  // Cut short, or its usage never came: billed at the estimate of what it streamed.
  const aborted = message.stopReason === "aborted";
  const estimate = aborted || usageMissing(message.usage) ? { chars: message.content?.length ? JSON.stringify(message.content).length : 0, completed: !aborted } : undefined;
  return billable(ctx, session, message.usage, message.provider, message.model, estimate, quiet);
}

/**
 * What a transcript record commits (`ToolBridge.committing`): a model response's cost, and spend counted since that no
 * record carries, added to the agent's spend in the transaction that writes the record, under the claim. So spend is
 * never lost apart from the history it paid for: a new owner reads what the history it loads cost. Only the owner
 * writes, and an increment for a limit replaced since (`set_at`) is dropped: a new limit counts from zero.
 */
export function nativeUsageEffect(ctx: SpendContext, session: Session, entry: import("@earendil-works/pi-durable").EntryRecord): CommitEffect | undefined {
  const summary = entry.kind === "camel.compaction.usage" ? (entry.data as any)?.message : undefined;
  const message = summary ?? durableEntryMessages(entry).find(item => billed(item.message))?.message;
  if (!message || !billed(message)) return undefined;
  const usage = responseUsage(ctx, session, message, true);
  const via = endpoint(ctx, session) ? `${session.header.config.model.provider}/` : "";
  const request = [...session.running.values()].find(record => RUN_METHODS.includes(record.method));
  const { identity, keyScope } = session.header;
  const payload: UsageRecord = { usage, provider: via + (message as any).provider, model: (message as any).model,
    timestamp: message.timestamp, platform: !!session.platformKey, kind: summary ? "compaction" : "turn",
    ...(request ? { requestId: request.id, ...(request.actor ? { actor: request.actor } : {}) } : {}),
    ...(identity ? { identity } : {}), ...(keyScope ? { keyScope } : {}) };
  const spend = ctx.spendWrite(session, responseCost(usage));
  // The current runtime already charges tracked attempts durably, including end-user holds.
  if (usage.billingAttemptId) return spend;
  return async sql => {
    if (!sql) { await spend?.(); return; }
    const inserted = await sql.query(`insert into pi_usage_receipts (session_id, entry_id, tenant, message)
        values ($1, $2, $3, $4::jsonb) on conflict do nothing returning entry_id`,
      [session.header.id, entry.id, session.header.tenant, JSON.stringify(payload)]);
    if (inserted.rowCount) await spend?.(sql);
  };
}

/**
 * What commits with a journal entry (`ToolBridge.committing`): a model response's usage and cost (`nativeUsageEffect`),
 * and, with any other entry, the spend counted since that no entry carried yet.
 */
export function entryEffect(ctx: SpendContext, session: Session, entry: import("@earendil-works/pi-durable").EntryRecord): CommitEffect | undefined {
  return nativeUsageEffect(ctx, session, entry) ?? ctx.spendWrite(session, 0);
}

/** The tenant's js_exec limits. */
export async function codeLimits(ctx: SpendContext, tenant: string): Promise<CodeLimits> {
  return await ctx.options.codeLimitsFor?.(tenant) ?? { cpuMs: CODE_LIMITS.cpuMs, maxTimeoutMs: CODE_LIMITS.maxTimeoutMs, concurrent: CODE_LIMITS.concurrent };
}

/** Why the running run may not spend more: it has spent its own limit (`runLimits`). */
export function runSpendLimit(session: Session): string | undefined {
  for (const [id, usd] of session.runLimits ?? []) {
    const spent = (session.usage?.get(id)?.costUsd ?? 0) + (session.childSpend?.get(id) ?? 0) + (session.imageSpend?.get(id) ?? 0) + (session.decisionSpend?.get(id) ?? 0);
    if (session.running.has(id) && spent >= usd) return `This run has reached its spend limit of ${dollars(usd)} (${dollars(spent)} spent)`;
  }
  return undefined;
}

/**
 * Why the running run may not make another model request: it has made as many responses, or run as long, as the
 * agent's `runLimits` allow, within the runtime's. Counted on this node: a turn resumed after its node was lost
 * counts again from its resume.
 */
export async function turnLimit(ctx: SpendContext, session: Session): Promise<string | undefined> {
  const run = [...session.running.values()].find(record => RUN_METHODS.includes(record.method) && record.began);
  if (!run) return undefined;
  const most = await ctx.options.runLimitsFor?.(session.header.tenant) ?? RUN_LIMITS, own = session.header.config.runLimits ?? {}, its = session.runCaps?.get(run.id) ?? {};
  const maxResponses = Math.min(own.maxResponses ?? most.maxResponses, its.maxResponses ?? most.maxResponses, most.maxResponses);
  const seconds = await maxSeconds(ctx, session, run.id);
  const responses = session.usage?.get(run.id)?.responses ?? 0;
  if (responses >= maxResponses) return `This run stopped at its limit of ${maxResponses} model responses. Send another message to continue`;
  if (Date.now() - run.began! >= seconds * 1000) return `This run stopped at its time limit of ${duration(seconds)}. Send another message to continue`;
  return undefined;
}

/** Why a run may not start: a model run's spend limit (a monthly cap or spent credit), or for any run, spent credit. */
export async function runLimit(ctx: SpendContext, session: Session, method: string, bucket?: string): Promise<HttpError | undefined> {
  const tenant = session.header.tenant;
  const refused = (refusal: Refusal | undefined, code: string, limit?: RunStop["limit"]) => typeof refusal === "string" ? Object.assign(new HttpError(402, refusal, code), { stopLimit: limit }) : refusal;
  if (MODEL_RUNS.includes(method)) {
    const agent = await ctx.agentSpendLimit(session);
    const limited = agent ? refused(agent, "SPEND_LIMIT", "agent") : refused(await ctx.options.spendLimit?.(tenant), "SPEND_LIMIT", "tenant");
    if (limited) return limited;
    // Its end user has nothing left in the run's bucket.
    const payer = modelPayer(ctx, session, bucket ? { bucket } as RequestRecord : undefined);
    const broke = payer && await ctx.options.endUsers?.refusal(tenant, payer.id, payer.bucket);
    return broke ? creditError(broke) : undefined;
  }
  if (RUN_METHODS.includes(method)) return refused(await ctx.options.creditLimit?.(tenant), "INSUFFICIENT_CREDIT");
  return undefined;
}

/** Report the running run's active time so far; `running` keeps counting from now. */
export function reportActive(ctx: SpendContext, session: Session, running: boolean, now = Date.now()) {
  if (session.activeSince === undefined) return;
  const ms = now - session.activeSince;
  session.activeSince = running ? now : undefined;
  try { ctx.options.onActive?.(session.header.tenant, session.header.id, ms); }
  catch (error) { console.error(JSON.stringify({ type: "active_report_failed", error: errorText(error) })); }
}

/**
 * The most seconds a run of the agent may take: the least of its own runLimits' maxSeconds, the run's own (a prompt's
 * runLimits), and the runtime's maximum for its tenant.
 */
export async function maxSeconds(ctx: SpendContext, session: Session, run?: string) {
  const most = await ctx.options.runLimitsFor?.(session.header.tenant) ?? RUN_LIMITS;
  const its = run === undefined ? undefined : session.runCaps?.get(run)?.maxSeconds;
  return Math.min(session.header.config.runLimits?.maxSeconds ?? most.maxSeconds, its ?? most.maxSeconds, most.maxSeconds);
}

/**
 * The spend limit a delegate call's child gets, held for it until it ends (`releaseBudget`): an even share of what the
 * run may still spend that no other child in flight holds, split among this run's calls in flight that hold none yet
 * and the calls of this one's response that have not got here. A response's calls arrive one by one, and may wait for
 * a slot: counting only those in flight, the first could take it all and leave the next none.
 * So parallel children together never get more than the parent has left. Undefined when the run has no limit.
 */
export async function holdBudget(ctx: SpendContext, session: Session, runId: string, call: { messageIndex?: number; delegates?: number } = {}) {
  const left = await budgetLeft(ctx, session, runId);
  if (left === undefined) return undefined;
  const held = (session.childHeld ??= new Map()).get(runId) ?? { usd: 0, holders: 0 };
  let response = session.delegateResponse;
  if (call.messageIndex !== undefined && (response?.run !== runId || response.messageIndex !== call.messageIndex)) response = session.delegateResponse = { run: runId, messageIndex: call.messageIndex, taken: 0 };
  const unstarted = call.messageIndex !== undefined ? (call.delegates ?? 1) - response!.taken : 0;
  if (call.messageIndex !== undefined) response!.taken++;
  const sharing = Math.max(1, (session.delegating?.active ?? 1) - held.holders, unstarted);
  const share = Math.max(0, left - held.usd) / sharing;
  session.childHeld.set(runId, { usd: held.usd + share, holders: held.holders + 1 });
  return share;
}

export function releaseBudget(session: Session, runId: string, usd: number) {
  const held = session.childHeld?.get(runId);
  if (!held) return;
  if (held.holders <= 1) session.childHeld!.delete(runId);
  else session.childHeld!.set(runId, { usd: Math.max(0, held.usd - usd), holders: held.holders - 1 });
}

/**
 * A background child's spend limit, held for it on its row while it runs: an even share of what the agent may still
 * spend that no running child holds, among the slots `maxParallel` leaves, so children started together share it rather
 * than each getting all of it. It is the agent's own limit, not its run's: the run may end before the child does.
 * Undefined when the agent has no spend limit.
 */
export async function childShare(ctx: SpendContext, session: Session, requestId: string, maxParallel: number) {
  // One share at a time per agent: children started in one response each see the shares taken before theirs.
  const previous = session.sharing ?? Promise.resolve();
  let release!: () => void;
  session.sharing = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    const spend = await ctx.spendOf(session);
    if (!spend) return undefined;
    const { rows: [held] } = await ctx.db.query(`select coalesce(sum(budget), 0) as usd, count(*) as n from agent_children
        where parent = $1 and state = 'running' and ended_at is null and kind = 'spawn' and budget is not null and id <> $2`, [session.header.id, requestId]);
    const share = Math.max(0, spend.usd - spend.spent - Number(held.usd)) / Math.max(1, maxParallel - Number(held.n));
    await ctx.db.query("update agent_children set budget = $2 where id = $1", [requestId, share]);
    return share;
  } finally { release(); }
}

/** What the running run may still spend, within its own spend limit and its agent's; undefined when neither has one. */
export async function budgetLeft(ctx: SpendContext, session: Session, runId: string) {
  const spend = await ctx.spendOf(session);
  const own = session.runLimits?.get(runId);
  const left = Math.min(spend ? spend.usd - spend.spent : Infinity, own !== undefined ? own - (session.usage?.get(runId)?.costUsd ?? 0) - (session.childSpend?.get(runId) ?? 0) - (session.imageSpend?.get(runId) ?? 0) - (session.decisionSpend?.get(runId) ?? 0) : Infinity);
  return Number.isFinite(left) ? Math.max(0, left) : undefined;
}

/** The tenant's own endpoint the agent's model is on, if it is. */
export function endpoint(ctx: SpendContext, session: Session) {
  const endpoints = ctx.options.modelEndpoints?.(session.header.tenant);
  const { provider } = session.header.config.model;
  return endpoints && Object.hasOwn(endpoints, provider) ? endpoints[provider] : undefined;
}

/**
 * Charge the agent's end user for a call it made that held nothing beforehand (a web search, a page rendered, a tool
 * search's ranking), as the call is recorded. Never throws. A charge the database refuses (a failover) is retried
 * under the same key, which posts it once, for up to END_USER_CHARGE_RETRY_MS; one that still fails is logged.
 */
export function endUserCharge(ctx: SpendContext, agent: string, usage: UsageRecord) {
  const session = ctx.sessions.get(agent), endUsers = ctx.options.endUsers;
  const user = session && payer(ctx, session, runningRun(session));
  const usd = Number(usage.usage?.cost?.total ?? 0);
  if (!session || !user || !endUsers || !(usd > 0)) return;
  const call = usage.searches ? "web_search" : usage.renders ? "web_fetch" : usage.toolSearch ? "tool_search" : "tool";
  const tenant = session.header.tenant, raw = Math.round(usd * MICROS), key = `charge:${randomUUID()}`;
  const metadata = { call, agent, ...(usage.provider ? { provider: usage.provider } : {}) };
  void (async () => {
    for (let delay = 1000, until = Date.now() + END_USER_CHARGE_RETRY_MS; ; delay = Math.min(delay * 2, 30_000)) {
      try { return await endUsers.charge(tenant, user.id, user.bucket, raw, key, metadata); }
      catch (error) {
        if (Date.now() + delay > until) { console.error(JSON.stringify({ type: "end_user_charge_failed", tenant, agent, raw, error: safeError(error) })); return; }
        await new Promise(resolve => setTimeout(resolve, delay).unref?.());
      }
    }
  })();
}

/** Close a stopped turn through the same spend transaction as its host's transcript writes. */
export async function closeTurn(ctx: SpendContext, session: Session) {
  await ctx.spendOf(session);
  // A load can settle the old turn before ensureStarted initializes the pricing of recovered responses.
  if (session.spend && (session.platformKey === undefined || session.catalogPriced === undefined) && await ctx.supervisor.hasDurableHistory(session.header.id)) {
    const [{ platform }, priced] = await Promise.all([
      ctx.apiKey(session, session.header.config.model.provider, session.header.keyScope),
      ctx.options.catalogPriced?.(session.header.tenant),
    ]);
    session.platformKey = platform;
    session.catalogPriced = !!priced;
  }
  const id = session.header.id;
  const closed = await ctx.supervisor.closeTurn(id, session.claim, { committing: entry => entryEffect(ctx, session, entry) });
  // Recovered messages have no live message_end event to count them in memory. Read the committed ledger instead;
  // a retry or a second close finds the same native cursor and cannot charge the response twice.
  await refreshSpend(ctx, session);
  return closed;
}
